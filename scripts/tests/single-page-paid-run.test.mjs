// [7g] 单页运行时接入计费运行（paid-run）：
// 单页生成、单页改图、复刻页生成/改图共用一个运行模块——claim 在 BEGIN IMMEDIATE 内、
// 在飞注册表归模块、幂等重放 409、单价快照、失败先退款后终态。
// 崩溃现场用注入时钟 + 模块接口制造（不再 UPDATE 数据库时间戳）。由 scripts/test-generation.mjs 汇总调用。
export async function runSinglePagePaidRunTests(ctx) {
  const { check, expectThrows, auth, credits, makeMockFetcher, editsOkHandler, imageConfig, PNG_1X1_B64 } = ctx;
  const singlePages = await import('../../src/lib/server/generation/single-pages.ts');
  const paidRun = await import('../../src/lib/server/generation/paid-run.ts');
  const recovery = await import('../../src/lib/server/generation/recovery.ts');
  const chargeKeys = await import('../../src/lib/server/generation/charge-keys.ts');
  const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
  const ledgerDb = (await import('../../src/lib/server/db.ts')).getDb();
  console.log('\n[7g] 单页运行时接入计费运行（键形 / 在飞 / 重放 / 崩溃窗口）');

  let seq = 0;
  const makeUser = async (label) => {
    seq += 1;
    const reg = await auth.registerWithPassword(
      { account: `sppaid${label}${seq}`, password: 'password123', confirmPassword: 'password123' },
      `127.0.9.${seq}`,
    );
    return reg.user.id;
  };
  const okFetcher = () => makeMockFetcher([
    { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } },
    editsOkHandler,
  ]);
  const versionRow = (pageId) => genDb
    .prepare('SELECT id, job_id, status, charge_key, error FROM single_page_versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(pageId);
  // 只看扣费/退款行：注册赠送不参与本组断言
  const ledgerKeys = (userId) => ledgerDb
    .prepare('SELECT idempotency_key, delta FROM credit_ledger WHERE user_id = ? ORDER BY created_at ASC, id ASC')
    .all(userId)
    .map((row) => ({ key: String(row.idempotency_key), delta: Number(row.delta) }))
    .filter((row) => !row.key.startsWith('signup-bonus:'));
  const refundRows = (userId) => ledgerKeys(userId).filter((row) => row.key.startsWith('refund:'));

  // ---- 扣费键唯一来源：单页运行与恢复读同一个键 ----
  {
    const plain = chargeKeys.singlePageChargeKey({ pageId: 'p1', jobId: 'job1' });
    check('单页扣费键：无 requestId 时用服务端 jobId', plain === 'single-page:p1:job1', plain);
    const replay = chargeKeys.singlePageChargeKey({ pageId: 'p1', jobId: 'job1', requestId: 'req1' });
    check('单页扣费键：requestId 优先（重放命中同一键）', replay === 'single-page:p1:req1', replay);
    const longRequestId = `req-${'x'.repeat(200)}`;
    const longKey = chargeKeys.singlePageChargeKey({ pageId: 'p1', jobId: 'job1', requestId: longRequestId });
    check('单页扣费键：超长 requestId 归一与扣费口径一致（128 上限）',
      longKey.length === 128 && longKey === credits.chargeRefundKeys(`single-page:p1:${longRequestId}`).chargeKey,
      `len=${longKey.length}`);
  }

  // ---- 运行走模块：claim 写模块键、在飞注册表归模块、收尾释放 ----
  {
    const uid = await makeUser('flight');
    const fetcher = okFetcher();
    let release;
    let reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const reachedPromise = new Promise((resolve) => { reached = resolve; });
    const gated = async (url, init = {}) => {
      if (String(url).includes('/images/generations')) {
        reached();
        await gate;
      }
      return fetcher(url, init);
    };
    const running = singlePages.generateSinglePage(
      uid, { pageId: 'sp-flight', content: '单页在飞' }, { fetchImpl: gated, config: imageConfig },
    );
    await reachedPromise;
    const during = versionRow('sp-flight');
    const expectedKey = chargeKeys.singlePageChargeKey({ pageId: 'sp-flight', jobId: String(during.job_id) });
    check('单页运行：版本行在 claim 时写入模块产出的扣费键（写完即可读）',
      String(during.charge_key) === expectedKey, `stored=${during.charge_key} expected=${expectedKey}`);
    check('单页运行：在飞注册表归模块（键 = 扣费键，域/动作可列，旧 pageId 登记不存在）',
      paidRun.isInFlight(expectedKey) && !paidRun.isInFlight('sp-flight')
        && paidRun.listInFlight(uid).some((run) => run.runId === expectedKey
          && run.domain === 'single-page' && run.action === 'single_page_generate'),
      JSON.stringify(paidRun.listInFlight(uid)));
    check('单页运行：claim 时页面已置 running（双击可见）', singlePages.getOwnedPage(uid, 'sp-flight').status === 'running');
    release();
    const done = await running;
    const rows = ledgerKeys(uid);
    check('单页运行成功：在飞释放、按模块键扣一次、无退款',
      done.status === 'succeeded' && !paidRun.isInFlight(expectedKey)
        && rows.length === 1 && rows[0].key === expectedKey && rows[0].delta === -10
        && credits.getBalance(uid) === 90,
      `${JSON.stringify(rows)} / ${credits.getBalance(uid)}`);
  }

  // ---- 事务内 claim：并发双击只有一路能开始，另一路 409 且不双扣 ----
  {
    const uid = await makeUser('double');
    const pageRow = singlePages.upsertPage(uid, {
      pageId: 'sp-double', title: '双击', content: '双击测试', projectSource: 'single',
    });
    const fetcher = okFetcher();
    let release;
    let reached;
    const gate = new Promise((resolve) => { release = resolve; });
    const reachedPromise = new Promise((resolve) => { reached = resolve; });
    const gated = async (url, init = {}) => {
      if (String(url).includes('/images/generations')) {
        reached();
        await gate;
      }
      return fetcher(url, init);
    };
    const first = singlePages.runSinglePageJob(
      pageRow, { kind: 'single-generate', requestId: 'dbl-1' }, { fetchImpl: gated, config: imageConfig },
    );
    await reachedPromise;
    const second = singlePages.runSinglePageJob(
      pageRow, { kind: 'single-generate', requestId: 'dbl-2' }, { fetchImpl: okFetcher(), config: imageConfig },
    );
    await expectThrows('单页 claim 在 BEGIN IMMEDIATE 内：并发第二路 409', () => second, 'GENERATION_RUNNING');
    release();
    const firstResult = await first;
    const rows = ledgerKeys(uid);
    check('单页双击只扣一次费、只启动一次上游',
      firstResult.status === 'succeeded' && rows.length === 1
        && rows[0].key === 'single-page:sp-double:dbl-1' && fetcher.calls.length === 1,
      `${JSON.stringify(rows)} calls=${fetcher.calls.length}`);
  }

  // ---- 余额不足：模块不扣费、失败文案与错误码保持原样 ----
  {
    const uid = await makeUser('poor');
    credits.debitCredits(uid, 97, { reason: '测试花掉', idempotencyKey: 'sp-poor-drain' });
    const fetcher = okFetcher();
    await expectThrows('单页余额不足：仍抛 402 INSUFFICIENT_CREDITS',
      () => singlePages.generateSinglePage(uid, { pageId: 'sp-poor', content: '余额不足' }, { fetchImpl: fetcher, config: imageConfig }),
      'INSUFFICIENT_CREDITS');
    const page = singlePages.getOwnedPage(uid, 'sp-poor');
    const version = versionRow('sp-poor');
    check('单页余额不足：版本/页面置 failed 且文案保留',
      String(version?.status) === 'failed' && String(version?.error) === 'INSUFFICIENT_CREDITS'
        && page.status === 'failed' && page.error === 'INSUFFICIENT_CREDITS: 🌟 星星不足，请充值后重试',
      `version=${version?.error} page=${page.error}`);
    check('单页余额不足：无扣费账本、无在飞残留、未调上游',
      ledgerKeys(uid).length === 1 && ledgerKeys(uid)[0].key === 'sp-poor-drain'
        && paidRun.listInFlight(uid).length === 0 && fetcher.calls.length === 0);
  }

  // ---- 执行失败：先按实扣金额退款（定长派生键）再置 failed ----
  {
    const uid = await makeUser('fail');
    const failing = makeMockFetcher([{
      match: '/images/generations',
      payload: () => new Response(JSON.stringify({ error: { message: 'mock upstream 500' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    }]);
    const result = await singlePages.generateSinglePage(
      uid, { pageId: 'sp-fail', content: '失败页', requestId: 'fail-1' }, { fetchImpl: failing, config: imageConfig },
    );
    const chargeKey = 'single-page:sp-fail:fail-1';
    const rows = ledgerKeys(uid);
    const debitRow = rows.find((row) => row.key === chargeKey);
    const refundRow = rows.find((row) => row.key === credits.deriveRefundKey(chargeKey));
    check('单页执行失败：按实扣金额退还（余额回 100）',
      result.status === 'failed' && credits.getBalance(uid) === 100, `balance=${credits.getBalance(uid)}`);
    check('单页执行失败：扣费键 + 定长派生退款键各一笔',
      rows.length === 2 && debitRow?.delta === -10 && refundRow?.delta === 10,
      JSON.stringify(rows));
    const page = singlePages.getOwnedPage(uid, 'sp-fail');
    const version = versionRow('sp-fail');
    check('单页执行失败：版本/页面置 failed 带错误码、在飞释放',
      String(version?.status) === 'failed' && String(version?.error).includes('IMAGE_GENERATION_FAILED')
        && page.status === 'failed' && !paidRun.isInFlight(chargeKey));
  }

  // ---- 幂等重放：命中扣费键 409，不双扣、不重生、不退款，页还原到 claim 前状态 ----
  {
    const uid = await makeUser('replay');
    const fetcher = okFetcher();
    const first = await singlePages.generateSinglePage(
      uid, { pageId: 'sp-replay', content: '重放页', requestId: 'replay-1' }, { fetchImpl: fetcher, config: imageConfig },
    );
    const before = credits.getBalance(uid);
    const callsBefore = fetcher.calls.length;
    await expectThrows('单页幂等重放：同 requestId 返回 409', () =>
      singlePages.generateSinglePage(
        uid, { pageId: 'sp-replay', content: '重放页', requestId: 'replay-1' }, { fetchImpl: fetcher, config: imageConfig },
      ), 'DUPLICATE_REQUEST');
    const page = singlePages.getOwnedPage(uid, 'sp-replay');
    const version = versionRow('sp-replay');
    check('单页幂等重放：不双扣、不重生、不退款，页还原到成功状态',
      credits.getBalance(uid) === before && fetcher.calls.length === callsBefore
        && page.status === 'succeeded' && page.activeVersionId === first.versionId
        && String(version?.error) === 'DUPLICATE_REQUEST' && refundRows(uid).length === 0,
      `balance=${credits.getBalance(uid)} calls=${fetcher.calls.length} page=${page.status}`);
  }

  // ---- 崩溃窗口：现场全部用模块注入时钟制造，不再 UPDATE 数据库时间戳 ----
  const staleAfter = (base) => base + imageConfig.jobStaleMs + 1;
  const failedFetcher = () => makeMockFetcher([{
    match: '/images/generations',
    payload: () => new Response(JSON.stringify({ error: { message: 'mock upstream 500' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    }),
  }]);

  // 扣费后崩溃：进程死在执行前。重启后注册表为空（release 即该状态），恢复按存储键补退。
  {
    const uid = await makeUser('crashdebit');
    const t0 = Date.now() - 60_000;
    const page = singlePages.upsertPage(uid, {
      pageId: 'sp-crash-debit', title: '扣费后崩溃', content: '崩溃测试', projectSource: 'single',
    });
    const started = singlePages.beginSinglePagePaidRun(
      page, { kind: 'single-generate', requestId: 'crash-debit-1' }, { now: () => t0 },
    );
    const key = started.chargeKey;
    check('扣费后崩溃：模块已扣费并在飞（存储键 = requestId 键，与回退键不同）',
      started.began.charged === true && key === 'single-page:sp-crash-debit:crash-debit-1'
        && credits.getBalance(uid) === 90 && paidRun.isInFlight(key)
        && String(versionRow('sp-crash-debit')?.charge_key) === key,
      `key=${key} balance=${credits.getBalance(uid)}`);
    paidRun.releaseInFlight(key); // 进程重启：模块内存注册表为空
    const healed = recovery.reconcileUser(uid, () => staleAfter(t0));
    const pageAfter = singlePages.getOwnedPage(uid, 'sp-crash-debit');
    const versionAfter = versionRow('sp-crash-debit');
    check('扣费后崩溃：恢复收敛 1 条、页/版本置 failed 带中断文案',
      healed === 1 && pageAfter.status === 'failed' && pageAfter.error === '生成中断（服务重启），请重试'
        && String(versionAfter?.status) === 'failed',
      `healed=${healed} page=${pageAfter.status}/${pageAfter.error}`);
    check('扣费后崩溃：按存储键补退一次（不按 jobId 重拼）',
      credits.getBalance(uid) === 100 && refundRows(uid).length === 1
        && refundRows(uid)[0].key === credits.deriveRefundKey(key) && refundRows(uid)[0].delta === 10,
      `${credits.getBalance(uid)} / ${JSON.stringify(refundRows(uid))}`);
    const healedAgain = recovery.reconcileUser(uid, () => staleAfter(t0));
    check('扣费后崩溃：重复恢复不双退、不再收敛',
      healedAgain === 0 && credits.getBalance(uid) === 100 && refundRows(uid).length === 1,
      `healed=${healedAgain} refunds=${refundRows(uid).length}`);
  }

  // 退款后崩溃：退款已落账、终态未写（进程死在置终态前）。恢复补齐终态且不重复退款。
  {
    const uid = await makeUser('crashrefund');
    const t0 = Date.now() - 60_000;
    const page = singlePages.upsertPage(uid, {
      pageId: 'sp-crash-refund', title: '退款后崩溃', content: '崩溃测试', projectSource: 'single',
    });
    const started = singlePages.beginSinglePagePaidRun(
      page, { kind: 'single-generate', requestId: 'crash-refund-1' }, { now: () => t0 },
    );
    let crashed = false;
    try {
      paidRun.failPaidRun({
        userId: uid,
        chargeKey: started.chargeKey,
        refundReason: '单页生成失败退回',
        refType: 'single-page',
        refId: 'sp-crash-refund',
        settle: () => { throw new Error('进程在置终态前死亡'); },
      });
    } catch {
      crashed = true;
    }
    check('退款后崩溃：钱已退、版本仍在途、注册表已释放',
      crashed && credits.getBalance(uid) === 100 && refundRows(uid).length === 1
        && String(versionRow('sp-crash-refund')?.status) === 'queued'
        && !paidRun.isInFlight(started.chargeKey),
      `${credits.getBalance(uid)}/${versionRow('sp-crash-refund')?.status}`);
    const healed = recovery.reconcileUser(uid, () => staleAfter(t0));
    check('退款后崩溃：恢复补齐终态且不重复退款',
      healed === 1 && singlePages.getOwnedPage(uid, 'sp-crash-refund').status === 'failed'
        && credits.getBalance(uid) === 100 && refundRows(uid).length === 1,
      `healed=${healed} balance=${credits.getBalance(uid)} refunds=${refundRows(uid).length}`);
  }

  // 置终态后崩溃：行已 failed、退款完成。恢复不再把终态当在途，不双退。
  {
    const uid = await makeUser('crashterminal');
    const t0 = Date.now() - 60_000;
    const result = await singlePages.generateSinglePage(
      uid, { pageId: 'sp-crash-terminal', content: '失败页', requestId: 'terminal-1' },
      { fetchImpl: failedFetcher(), config: imageConfig, now: () => t0 },
    );
    const healed = recovery.reconcileUser(uid, () => staleAfter(t0));
    check('置终态后崩溃：终态行不再被收敛、不重复退款',
      result.status === 'failed' && healed === 0 && credits.getBalance(uid) === 100
        && singlePages.getOwnedPage(uid, 'sp-crash-terminal').status === 'failed'
        && refundRows(uid).length === 1,
      `healed=${healed} balance=${credits.getBalance(uid)} refunds=${refundRows(uid).length}`);
  }

  // 在途不误收敛：注册表是唯一在飞源，心跳过期也不动正在跑的那页。
  {
    const uid = await makeUser('crashlive');
    const t0 = Date.now() - 60_000;
    const page = singlePages.upsertPage(uid, {
      pageId: 'sp-crash-live', title: '在途', content: '崩溃测试', projectSource: 'single',
    });
    const started = singlePages.beginSinglePagePaidRun(
      page, { kind: 'single-generate', requestId: 'live-1' }, { now: () => t0 },
    );
    const healed = recovery.reconcileUser(uid, () => t0 + imageConfig.jobStaleMs * 2);
    check('在途不误收敛：在飞清单命中时不退款、不置 failed',
      healed === 0 && singlePages.getOwnedPage(uid, 'sp-crash-live').status === 'running'
        && credits.getBalance(uid) === 90 && refundRows(uid).length === 0,
      `healed=${healed} balance=${credits.getBalance(uid)}`);
    started.began.run.fail({ code: 'IMAGE_GENERATION_FAILED', message: '测试清理' });
    check('在途不误收敛：清理收尾释放登记并退款', !paidRun.isInFlight(started.chargeKey) && credits.getBalance(uid) === 100);
  }

  // 重放被拒的崩溃残留：重放 claim 已置 running、版本写入首笔成功的扣费键，
  // 进程死在 debit 命中 duplicate 之后（首笔已出图）。恢复不得把首笔的钱退掉。
  {
    const uid = await makeUser('replaycrash');
    const first = await singlePages.generateSinglePage(
      uid, { pageId: 'sp-replay-crash', content: '重放崩溃', requestId: 'rc-1' }, { fetchImpl: okFetcher(), config: imageConfig },
    );
    const ts = Date.now() - 60_000;
    genDb.prepare(
      "INSERT INTO single_page_versions (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at) VALUES (?, ?, 'generate', 'p', 'queued', '', '', '', ?, ?, ?, ?)",
    ).run('ver_replay_crash', 'sp-replay-crash', 'job_replay_crash', 'single-page:sp-replay-crash:rc-1', ts, ts);
    genDb.prepare("UPDATE single_pages SET status = 'running', updated_at = ? WHERE id = ?").run(ts, 'sp-replay-crash');
    const healed = recovery.reconcileUser(uid, () => ts + imageConfig.jobStaleMs + 1);
    const page = singlePages.getOwnedPage(uid, 'sp-replay-crash');
    const residue = genDb.prepare('SELECT status, error FROM single_page_versions WHERE id = ?').get('ver_replay_crash');
    check('重放崩溃残留：扣费键已被成功版本消费 → 不退款、页还原成功',
      first.status === 'succeeded' && healed === 1 && credits.getBalance(uid) === 90
        && refundRows(uid).length === 0 && page.status === 'succeeded' && page.activeVersionId === first.versionId
        && String(residue?.status) === 'failed' && String(residue?.error) === '生成中断（服务重启），请重试',
      `healed=${healed} balance=${credits.getBalance(uid)} page=${page.status}/${page.activeVersionId}`);
  }

  // 迁移前老行（无存储扣费键）：恢复按模块键函数回退拼键，仍能补退。
  {
    const uid = await makeUser('crashlegacy');
    const ts = Date.now() - 60_000;
    // 迁移前老行：页/项目走公开写入路径，只把版本行补成「无存储扣费键 + 已在途」
    singlePages.upsertPage(uid, { pageId: 'sp-crash-legacy', title: '老行', content: 'x', projectSource: 'single' });
    genDb.prepare(
      "INSERT INTO single_page_versions (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at) VALUES (?, ?, 'generate', 'p', 'queued', '', '', '', ?, '', ?, ?)",
    ).run('ver_legacy', 'sp-crash-legacy', 'job_legacy', ts, ts);
    genDb.prepare("UPDATE single_pages SET status = 'running', updated_at = ? WHERE id = ?").run(ts, 'sp-crash-legacy');
    const legacyKey = chargeKeys.singlePageChargeKey({ pageId: 'sp-crash-legacy', jobId: 'job_legacy' });
    credits.debitCredits(uid, 10, { reason: '单页生成', idempotencyKey: legacyKey, refType: 'single-page', refId: 'sp-crash-legacy' });
    const healed = recovery.reconcileUser(uid, () => ts + imageConfig.jobStaleMs + 1);
    check('老行无存储键：恢复按键模块回退补退（写入与读取同一口径）',
      healed === 1 && credits.getBalance(uid) === 100
        && refundRows(uid).some((row) => row.key === credits.deriveRefundKey(legacyKey)),
      `healed=${healed} balance=${credits.getBalance(uid)}`);
  }
}
