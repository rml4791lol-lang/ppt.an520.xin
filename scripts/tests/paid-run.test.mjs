// [4i] 计费运行模块（src/lib/server/generation/paid-run.ts）：
// 一次收费动作的权威顺序 = 落 claim 行 → 注册在飞 → 幂等扣费 → 执行 → 成功终态；
// 失败先按账本实扣金额退款（幂等）再置 failed。
// 塞子：真实测试账本 + 假行存储（可注入崩溃点）+ 注入时钟。由 scripts/test-generation.mjs 汇总调用。
export async function runPaidRunTests(ctx) {
  const { check, auth, credits } = ctx;
  const paidRun = await import('../../src/lib/server/generation/paid-run.ts');
  const { getDb } = await import('../../src/lib/server/db.ts');
  console.log('\n[4i] 计费运行模块（claim → 注册在飞 → 幂等扣费 → 执行 → 终态）');

  let seq = 0;
  const makeUser = async (label) => {
    seq += 1;
    const reg = await auth.registerWithPassword(
      { account: `paidrun${label}${seq}`, password: 'password123', confirmPassword: 'password123' },
      `127.0.8.${seq}`,
    );
    return reg.user.id;
  };
  const refundRows = (userId) => getDb()
    .prepare("SELECT idempotency_key, delta FROM credit_ledger WHERE user_id = ? AND event_type = 'refund'")
    .all(userId)
    .map((row) => ({ key: String(row.idempotency_key), delta: Number(row.delta) }));
  const ledgerRow = (key) => getDb()
    .prepare('SELECT delta, event_type, reason FROM credit_ledger WHERE idempotency_key = ?')
    .get(key);
  // 假行存储：记录动词顺序；hooks 可在「置终态」瞬间观察对外可见事实（如余额）
  const makeStore = (events, hooks = {}) => ({
    claim: (chargeKey) => {
      events.push(`claim:${chargeKey}`);
      hooks.claim?.(chargeKey);
      return { chargeKey };
    },
    markRunning: () => events.push('running'),
    markSucceeded: (row, result) => {
      events.push('succeeded');
      hooks.succeeded?.(row, result);
    },
    markFailed: (row, failure) => {
      events.push(`failed:${failure.code}`);
      hooks.failed?.(row, failure);
    },
  });

  {
    // --- 成功路径：claim 先于扣费；扣费金额 = 启动快照；成功后释放登记、无退款 ---
    const uid = await makeUser('ok');
    const key = 'deck-generate:d-paidrun:j-paidrun:s-paidrun';
    const events = [];
    const startedAt = 1_760_000_000_000;
    let balanceAtClaim = -1;
    let succeededResult = null;
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-paidrun',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成失败退回',
      store: makeStore(events, {
        claim: () => { balanceAtClaim = credits.getBalance(uid); },
        succeeded: (_row, result) => { succeededResult = result; },
      }),
      now: () => startedAt,
    });
    check('先落 claim 行再扣费（claim 时余额尚未扣，扣费后 90）',
      began.charged === true && events[0] === `claim:${key}` && balanceAtClaim === 100 && credits.getBalance(uid) === 90,
      `实际 ${events[0]} / ${balanceAtClaim} / ${credits.getBalance(uid)}`);
    check('扣费金额 = 启动时单价快照',
      Number(ledgerRow(key)?.delta) === -10 && String(ledgerRow(key)?.event_type) === 'debit',
      `实际 ${JSON.stringify(ledgerRow(key))}`);
    check('在飞清单透出本次运行（域/动作/注入时钟）',
      paidRun.listInFlight(uid).some((run) => run.runId === key
        && run.domain === 'deck' && run.action === 'deck_page_generate' && run.startedAt === startedAt),
      JSON.stringify(paidRun.listInFlight(uid)));
    began.run.succeed({ imagePath: 'p.png' });
    check('成功置终态、释放在飞、透传执行结果',
      events.includes('succeeded') && succeededResult?.imagePath === 'p.png' && paidRun.listInFlight(uid).length === 0,
      `实际 ${events.join(',')}`);
    check('成功不产生退款', refundRows(uid).length === 0 && credits.getBalance(uid) === 90);
  }

  {
    // --- 失败路径：退款（按实扣金额、定长派生键）先于置 failed ---
    const uid = await makeUser('fail');
    const key = 'deck-generate:d-fail:j-fail:s-fail';
    const events = [];
    let balanceWhenFailed = -1;
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-fail',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成失败退回',
      store: makeStore(events, {
        failed: () => { balanceWhenFailed = credits.getBalance(uid); },
      }),
    });
    check('失败前置：已扣 10（余额 90）', began.charged === true && credits.getBalance(uid) === 90);
    began.run.fail({ code: 'IMAGE_FAILED', message: '上游 500' });
    check('失败先退款再置 failed（置 failed 时余额已回 100）',
      balanceWhenFailed === 100, `实际 ${balanceWhenFailed}`);
    check('退款键由扣费键定长派生、只一笔、金额 = 实扣',
      refundRows(uid).length === 1
        && refundRows(uid)[0].key === credits.deriveRefundKey(key)
        && refundRows(uid)[0].delta === 10,
      JSON.stringify(refundRows(uid)));
    check('失败终态写进行存储并释放在飞',
      events.includes('failed:IMAGE_FAILED') && paidRun.listInFlight(uid).length === 0);
    const settledBalance = credits.getBalance(uid);
    paidRun.failPaidRun({
      userId: uid, chargeKey: key, refundReason: '重复恢复', refType: 'deck', refId: 'd-fail', settle: () => {},
    });
    check('置终态后崩溃再收敛：已退过不再退',
      credits.getBalance(uid) === settledBalance && refundRows(uid).length === 1);
  }

  {
    // --- 退款金额取账本实扣，不取单价快照（重放同一扣费键时两者可能不同）---
    const uid = await makeUser('actual');
    const key = 'deck-generate:d-actual:j-actual:s-actual';
    credits.debitCredits(uid, 7, { reason: '旧进程扣费', idempotencyKey: key, refType: 'deck', refId: 'd-actual' });
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-actual',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成失败退回',
      store: makeStore([]),
    });
    check('重放同一扣费键：幂等扣费不多扣（余额仍 93）',
      began.charged === true && credits.getBalance(uid) === 93, `实际 ${credits.getBalance(uid)}`);
    began.run.fail({ code: 'IMAGE_FAILED', message: 'x' });
    check('退款按账本实扣金额（7，不是快照 10）',
      credits.getBalance(uid) === 100 && refundRows(uid)[0]?.delta === 7,
      `实际 ${credits.getBalance(uid)} / ${JSON.stringify(refundRows(uid))}`);
  }

  {
    // --- 扣费失败（余额不足）：行置 failed、无账本、无可退、释放在飞 ---
    const uid = await makeUser('poor');
    credits.debitCredits(uid, 97, { reason: '测试花掉', idempotencyKey: 'paidrun-drain' });
    const key = 'deck-generate:d-poor:j-poor:s-poor';
    const events = [];
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-poor',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成失败退回',
      store: makeStore(events),
    });
    check('余额不足：不落账本、行置 failed、失败码透出',
      began.charged === false && began.failure.code === 'INSUFFICIENT_CREDITS'
        && !ledgerRow(key) && events.includes('failed:INSUFFICIENT_CREDITS'),
      `实际 ${began.charged} / ${events.join(',')}`);
    check('扣费失败无可退金额、释放在飞',
      credits.getBalance(uid) === 3 && refundRows(uid).length === 0 && paidRun.listInFlight(uid).length === 0);
  }

  {
    // --- 崩溃窗口一：扣费后进程死亡（在飞清单就是现场），恢复补退一次 ---
    const uid = await makeUser('crashdebit');
    const key = 'deck-generate:d-crash:j-crash:s-crash';
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-crash',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成中断退回',
      store: makeStore([]),
    });
    check('扣费后崩溃：在飞清单可构造「已扣费未完成」现场',
      began.charged === true && credits.getBalance(uid) === 90
        && paidRun.listInFlight(uid).some((run) => run.runId === key),
      `实际 ${credits.getBalance(uid)}`);
    let settled = 0;
    paidRun.failPaidRun({
      userId: uid, chargeKey: key, refundReason: '第 1 页生成中断退回',
      refType: 'deck', refId: 'd-crash', settle: () => { settled += 1; },
    });
    check('扣费后崩溃：恢复按实扣金额补退一次并置 failed',
      credits.getBalance(uid) === 100 && refundRows(uid).length === 1 && settled === 1);
    paidRun.failPaidRun({
      userId: uid, chargeKey: key, refundReason: '第 1 页生成中断退回',
      refType: 'deck', refId: 'd-crash', settle: () => { settled += 1; },
    });
    check('扣费后崩溃：重复恢复只退一次',
      credits.getBalance(uid) === 100 && refundRows(uid).length === 1 && settled === 2);
  }

  {
    // --- 崩溃窗口二：退款已落账、终态未写（置终态时进程死亡）---
    const uid = await makeUser('crashrefund');
    const key = 'deck-generate:d-refund:j-refund:s-refund';
    const events = [];
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-refund',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成失败退回',
      store: {
        claim: (chargeKey) => ({ chargeKey }),
        markSucceeded: () => events.push('succeeded'),
        markFailed: () => { throw new Error('进程在置终态前死亡'); },
      },
    });
    let crashed = false;
    try {
      began.run.fail({ code: 'IMAGE_FAILED', message: '上游 500' });
    } catch {
      crashed = true;
    }
    check('退款后崩溃：退款已落账、终态未写',
      crashed && credits.getBalance(uid) === 100 && refundRows(uid).length === 1 && !events.includes('failed'),
      `实际 ${credits.getBalance(uid)} / ${events.join(',')}`);
    let settled = 0;
    paidRun.failPaidRun({
      userId: uid, chargeKey: key, refundReason: '第 1 页生成失败退回',
      refType: 'deck', refId: 'd-refund', settle: () => { settled += 1; },
    });
    check('退款后崩溃：恢复补齐终态且不重复退款',
      settled === 1 && credits.getBalance(uid) === 100 && refundRows(uid).length === 1);
  }

  {
    // --- 扣费后域状态写不进去：按失败收敛，钱退回，不留「扣了费没跑」的行 ---
    const uid = await makeUser('runstart');
    const key = 'deck-generate:d-runstart:j-runstart:s-runstart';
    const events = [];
    const began = paidRun.beginPaidRun({
      domain: 'deck',
      userId: uid,
      action: 'deck_page_generate',
      unitPrice: 10,
      chargeKey: key,
      refType: 'deck',
      refId: 'd-runstart',
      reason: '生成第 1 页',
      refundReason: '第 1 页生成失败退回',
      store: {
        claim: (chargeKey) => ({ chargeKey }),
        markRunning: () => { throw new Error('run state write failed'); },
        markSucceeded: () => events.push('succeeded'),
        markFailed: (_row, failure) => events.push(`failed:${failure.code}`),
      },
    });
    check('扣费后状态写入失败：退款并置 failed（余额回 100）',
      began.charged === false && credits.getBalance(uid) === 100
        && events.includes('failed:CHARGE_FAILED') && refundRows(uid).length === 1,
      `实际 ${began.charged} / ${credits.getBalance(uid)} / ${events.join(',')}`);
    check('扣费后状态写入失败：释放该次在飞登记', paidRun.listInFlight(uid).length === 0);
  }

  {
    // --- 批次在飞作用域：执行中可判活/列出，结束或抛错都释放 ---
    const uid = await makeUser('scope');
    let during = null;
    await paidRun.withInFlightRun(
      { runId: 'job-scope', domain: 'deck', userId: uid, action: 'deck_batch', now: () => 7 },
      async () => {
        during = {
          active: paidRun.isInFlight('job-scope'),
          listed: paidRun.listInFlight(uid).find((run) => run.runId === 'job-scope'),
        };
      },
    );
    check('批次在飞作用域：执行中可判活、可列出（注入时钟）',
      during.active === true && during.listed?.startedAt === 7, JSON.stringify(during));
    check('批次结束释放登记',
      !paidRun.isInFlight('job-scope') && paidRun.listInFlight(uid).length === 0);
    let threw = false;
    try {
      await paidRun.withInFlightRun(
        { runId: 'job-scope-2', domain: 'deck', userId: uid },
        async () => { throw new Error('管线异常中断'); },
      );
    } catch {
      threw = true;
    }
    check('批次抛错也在 finally 释放', threw && !paidRun.isInFlight('job-scope-2'));
  }
}
