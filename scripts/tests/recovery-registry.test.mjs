// [7h] 恢复运行源注册表（T06）：恢复入口只有一循环——各域在装配期登记「运行源」（在途列表 +
// 结算动作 + 扣费键），判活时钟与在飞注册表经 RunSourceContext 注入，来源不自读时间。
// 覆盖：装配后三源登记（deck / single-page / ppt-to-base）、假运行源 + 假时钟（新鲜不收敛、
// 过期收敛、退款只一次、重复恢复幂等）、三域同轮收敛各走各自运行源。
// 由 scripts/test-generation.mjs 汇总调用；装配点与进程启动钩子同源（src/recovery-assembly.ts）。
export async function runRecoveryRegistryTests(ctx) {
  const { check, auth, credits, imageConfig } = ctx;
  const recovery = await import('../../src/lib/server/generation/recovery.ts');
  const registry = await import('../../src/lib/server/generation/run-source.ts');
  const decks = await import('../../src/lib/server/generation/decks.ts');
  const singlePages = await import('../../src/lib/server/generation/single-pages.ts');
  const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
  const ledgerDb = (await import('../../src/lib/server/db.ts')).getDb();
  console.log('\n[7h] 恢复运行源注册表（注册 / 注入时钟 / 假运行源）');

  let seq = 0;
  const makeUser = async (label) => {
    seq += 1;
    const reg = await auth.registerWithPassword(
      { account: `rr${label}${seq}`, password: 'password123', confirmPassword: 'password123' },
      `127.1.0.${seq}`,
    );
    return reg.user.id;
  };
  const refundRows = (userId) => ledgerDb
    .prepare("SELECT idempotency_key, delta FROM credit_ledger WHERE user_id = ? AND event_type = 'refund'")
    .all(userId)
    .map((row) => ({ key: String(row.idempotency_key), delta: Number(row.delta) }));

  // ---- 装配点登记三源：恢复入口只遍历注册表，不再认识任何域 ----
  const domains = registry.listRunSources().map((source) => source.domain);
  const known = domains.filter((domain) => ['deck', 'single-page', 'ppt-to-base'].includes(domain));
  check('运行源注册表：装配后登记三源，顺序 deck → single-page → ppt-to-base',
    known.join(',') === 'deck,single-page,ppt-to-base', domains.join(','));

  // ---- 假运行源 + 注入时钟：新鲜不收敛、过期收敛、退款只一次 ----
  const uid = await makeUser('clock');
  const fakeHeartbeat = 1_000_000;
  const fakeKey = `fake-source:${uid}:run-1`;
  credits.debitCredits(uid, 10, {
    reason: '假运行扣费', idempotencyKey: fakeKey, refType: 'fake-source', refId: 'run-1',
  });
  const settled = [];
  const seen = [];
  const fakeSource = {
    domain: 'fake-source',
    listRuns(userId, runCtx) {
      seen.push({
        userId,
        stale: runCtx.isStale(fakeHeartbeat),
        live: runCtx.isLive('fake-run', fakeHeartbeat),
        inFlight: runCtx.isInFlight('fake-run'),
      });
      // 结算后就地物化终态：下一轮不再列出（真实运行源结算后行已 failed）
      if (userId !== uid || settled.length > 0) return [];
      return [{
        key: 'run-1',
        domain: 'fake-source',
        userId,
        interrupted: runCtx.isStale(fakeHeartbeat),
        chargeKey: fakeKey,
        refundReason: '假运行中断退回',
        refType: 'fake-source',
        refId: 'run-1',
        settle: () => settled.push('run-1'),
      }];
    },
  };
  registry.registerRunSources([fakeSource]);
  registry.registerRunSources([fakeSource]); // 装配点可重入：同域再登记以最后一次为准
  check('运行源注册表：同域重复登记幂等（装配点可重入）',
    registry.listRunSources().filter((source) => source.domain === 'fake-source').length === 1);

  const before = credits.getBalance(uid);
  const freshHealed = recovery.reconcileUser(uid, () => fakeHeartbeat + imageConfig.jobStaleMs - 1);
  check('注入时钟：新鲜心跳不收敛、不结算、不退款',
    freshHealed === 0 && settled.length === 0 && credits.getBalance(uid) === before,
    `healed=${freshHealed} settled=${settled.join(',')} balance=${credits.getBalance(uid)}`);
  check('注入时钟：判活口径来自注入时钟（非真实时间）与 paid-run 在飞注册表',
    seen.at(-1)?.stale === false && seen.at(-1)?.live === true && seen.at(-1)?.inFlight === false,
    JSON.stringify(seen.at(-1)));

  const staleHealed = recovery.reconcileUser(uid, () => fakeHeartbeat + imageConfig.jobStaleMs + 1);
  check('过期心跳：运行源列出的在途运行被收敛并执行结算动作',
    staleHealed === 1 && settled.join(',') === 'run-1'
      && seen.at(-1)?.stale === true && seen.at(-1)?.live === false,
    `healed=${staleHealed} settled=${settled.join(',')}`);
  check('过期收敛：按 ledger 实扣金额补退一次（运行源不自己退款）',
    credits.getBalance(uid) === before + 10 && refundRows(uid).length === 1
      && refundRows(uid)[0].key === credits.deriveRefundKey(fakeKey) && refundRows(uid)[0].delta === 10,
    `balance=${credits.getBalance(uid)} refunds=${JSON.stringify(refundRows(uid))}`);

  const againHealed = recovery.reconcileUser(uid, () => fakeHeartbeat + imageConfig.jobStaleMs + 1);
  check('重复恢复：幂等（不重复收敛、不双退）',
    againHealed === 0 && refundRows(uid).length === 1 && credits.getBalance(uid) === before + 10,
    `healed=${againHealed} refunds=${refundRows(uid).length}`);

  // ---- 三域同轮收敛：一次 reconcileUser 走完注册表，列表与结算只来自各自运行源 ----
  {
    const tid = await makeUser('multi');
    const deck = decks.createDeck(tid, {
      title: '多域收敛', sourceFileName: 'm.txt', sourceText: '2025 年营收 300 万元。',
      durationMinutes: 15, targetPageCount: 1, qualityTier: 'standard', stylePackId: '',
    });
    decks.replaceSlides(deck.id, [{
      pageIndex: 0, role: 'cover', chapter: '', pageType: '封面', title: '封面', goal: '开场',
      mustKeep: [], rawText: '2025 年营收 300 万元。', summary: [], visualNote: '',
    }]);
    const job = decks.createJob(tid, deck.id, 'deck-generate', 1);
    decks.updateJob(job.jobId, { status: 'running' });
    const [slide] = decks.listSlides(deck.id);
    const deckKey = `deck-generate:${deck.id}:${job.jobId}:${slide.slideId}`;
    decks.createSlideVersion(slide, { kind: 'generate', prompt: 'p', jobId: job.jobId, chargeKey: deckKey });
    decks.updateSlideGen(deck.id, slide.slideId, { genStatus: 'queued' });
    decks.touchDeck(deck.id, { status: 'generating' });
    credits.debitCredits(tid, 10, { reason: '整套生成', idempotencyKey: deckKey, refType: 'deck', refId: deck.id });

    singlePages.upsertPage(tid, { pageId: 'rr-page', title: '单页', content: '多域收敛', projectSource: 'single' });
    const pageKey = `single-page:rr-page:job_rr`;
    genDb.prepare(
      "INSERT INTO single_page_versions (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at) VALUES (?, 'rr-page', 'generate', 'p', 'queued', '', '', '', 'job_rr', ?, ?, ?)",
    ).run('ver_rr', pageKey, Date.now(), Date.now());
    genDb.prepare("UPDATE single_pages SET status = 'running' WHERE id = 'rr-page'").run();
    credits.debitCredits(tid, 10, { reason: '单页生成', idempotencyKey: pageKey, refType: 'single-page', refId: 'rr-page' });

    const pptKey = `ppt-to-base:${tid}:rr-ppt`;
    genDb.prepare(
      `INSERT INTO ppt_to_base_jobs (id, user_id, request_id, charge_key, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', '', ?, ?)`,
    ).run('ptb_rr', tid, 'rr-ppt', pptKey, Date.now(), Date.now());
    credits.debitCredits(tid, 5, { reason: 'PPT 转模版底座', idempotencyKey: pptKey, refType: 'ppt-to-base', refId: 'rr-ppt' });
    const spent = credits.getBalance(tid);

    check('三域同轮：新鲜心跳时三域都不误收敛',
      recovery.reconcileUser(tid) === 0 && credits.getBalance(tid) === spent,
      `balance=${credits.getBalance(tid)}`);

    const healed = recovery.reconcileUser(tid, () => Date.now() + imageConfig.jobStaleMs * 2);
    const deckAfter = decks.getOwnedDeck(tid, deck.id);
    const slideAfter = decks.listSlides(deck.id).find((row) => row.slideId === slide.slideId);
    const pageAfter = singlePages.getOwnedPage(tid, 'rr-page');
    const pptAfter = genDb.prepare('SELECT status FROM ppt_to_base_jobs WHERE id = ?').get('ptb_rr');
    check('三域同轮：一次恢复按注册表收敛四类在途（页 + deck + 单页 + 底座）',
      healed === 4 && deckAfter.status === 'confirmed' && slideAfter?.genStatus === 'failed'
        && pageAfter.status === 'failed' && String(pptAfter?.status) === 'failed',
      `healed=${healed} deck=${deckAfter.status} slide=${slideAfter?.genStatus} page=${pageAfter.status} ppt=${pptAfter?.status}`);
    check('三域同轮：三笔实扣各退一次（10 + 10 + 5），余额回满',
      credits.getBalance(tid) === 100 && refundRows(tid).length === 3
        && refundRows(tid).every((row) => row.delta > 0),
      `balance=${credits.getBalance(tid)} refunds=${JSON.stringify(refundRows(tid))}`);
    check('三域同轮：重复恢复不再收敛、不再退款',
      recovery.reconcileUser(tid, () => Date.now() + imageConfig.jobStaleMs * 2) === 0
        && refundRows(tid).length === 3,
      `refunds=${refundRows(tid).length}`);
  }
}
