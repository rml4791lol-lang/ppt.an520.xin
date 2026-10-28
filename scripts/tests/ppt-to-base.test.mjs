// ppt_to_base 模块测试：纯函数层（EMU 换算/色彩变换/几何回退/槽位推断/路径规范化）+ 截图 AI 路线服务端（全 mock）。
// 由 scripts/test-generation.mjs 汇总调用；ctx 由套件注入。
export async function runPptToBaseTests(ctx) {
  const { check } = ctx;
  console.log('\n[7e] PPT 转模版底座（pptx-model 纯函数层）');
  const model = await import('../../src/modules/ppt-to-base/client/pptx-model.ts');

  const rgbNear = (hex, r, g, b) => {
    const n = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    return Math.abs(n[0] - r) <= 2 && Math.abs(n[1] - g) <= 2 && Math.abs(n[2] - b) <= 2;
  };

  const t = model.baseTransform(12192000, 6858000); // 标准 16:9
  check('16:9 画幅正好铺满 1536×864',
    Math.abs(t.scale * 12192000 - 1536) < 1e-6 && Math.abs(t.offsetX) < 1e-6 && Math.abs(t.offsetY) < 1e-6);
  const t43 = model.baseTransform(9144000, 6858000); // 4:3
  check('4:3 画幅 letterbox 居中留边',
    t43.offsetX > 0 && Math.abs(t43.offsetY) < 1e-6 && Math.abs(t43.scale * 6858000 - 864) < 1e-6);

  check('无变换颜色原样返回',
    model.applyColorTransforms('#4472c4', {}).color === '#4472c4'
      && model.applyColorTransforms('#4472c4', {}).alpha === 1);
  // Office 主题基准值：accent1 #4472c4，tint=0.2（界面里的"变亮 80%"）≈ #d9e2f3，shade=0.5 ≈ #203864
  check('tint 折算 lumMod+lumOff（对齐 Office 基准值）',
    rgbNear(model.applyColorTransforms('#4472c4', { tint: 0.2 }).color, 217, 226, 243)
      && rgbNear(model.applyColorTransforms('#4472c4', { tint: 0.8 }).color, 105, 142, 208));
  check('shade 折算 lumMod（对齐 Office 基准值）',
    rgbNear(model.applyColorTransforms('#4472c4', { shade: 0.5 }).color, 32, 56, 100));
  check('lumMod/lumOff/satMod 生效且 alpha 收敛',
    rgbNear(model.applyColorTransforms('#808080', { lumMod: 0.5 }).color, 64, 64, 64)
      && rgbNear(model.applyColorTransforms('#ff0000', { satMod: 0 }).color, 128, 128, 128)
      && model.applyColorTransforms('#4472c4', { alpha: 0.4 }).alpha === 0.4
      && model.applyColorTransforms('#4472c4', { alpha: 3 }).alpha === 1);

  const scheme = { accent1: '#4472c4', lt1: '#ffffff', dk1: '#000000' };
  check('schemeClr 别名映射 bg1→lt1 / tx1→dk1',
    model.resolveSchemeColor('bg1', scheme) === '#ffffff'
      && model.resolveSchemeColor('tx1', scheme) === '#000000'
      && model.resolveSchemeColor('accent1', scheme) === '#4472c4');
  check('未知 scheme 色回退 accent1 再回退默认蓝',
    model.resolveSchemeColor('accent9', scheme) === '#4472c4'
      && model.resolveSchemeColor('accent9', {}) === '#4472c4');
  check('prstClr 常见名解析、未知回退灰',
    model.resolvePrstColor('white') === '#ffffff' && model.resolvePrstColor('mystery') === '#808080');
  check('sysClr 优先 lastClr，window→白、其余→黑',
    model.resolveSysColor('windowText', '112233') === '#112233'
      && model.resolveSysColor('window', null) === '#ffffff'
      && model.resolveSysColor('windowText', null) === '#000000');

  check('几何回退：支持的保留、未识别一律 rect',
    model.geomWithFallback('roundRect') === 'roundRect'
      && model.geomWithFallback('ellipse') === 'ellipse'
      && model.geomWithFallback('sun') === 'rect'
      && model.geomWithFallback(null) === 'rect');

  check('槽位角色：占位符类型优先',
    model.inferSlotRole('title', 12) === 'title'
      && model.inferSlotRole('ctrTitle', null) === 'title'
      && model.inferSlotRole('subTitle', 40) === 'subtitle');
  check('槽位角色：无占位符按字号分位',
    model.inferSlotRole(null, 32) === 'title'
      && model.inferSlotRole(null, 24) === 'title'
      && model.inferSlotRole(null, 18) === 'body'
      && model.inferSlotRole('body', null) === 'body');

  const norm = model.normalizeSlot(1219200, 685800, 4876800, 1371600, 12192000, 6858000);
  check('槽位归一化到 0..1',
    Math.abs(norm.x - 0.1) < 1e-9 && Math.abs(norm.y - 0.1) < 1e-9
      && Math.abs(norm.w - 0.4) < 1e-9 && Math.abs(norm.h - 0.2) < 1e-9);
  const clipped = model.normalizeSlot(-100, -100, 12192000 * 2, 6858000 * 2, 12192000, 6858000);
  check('越界槽位裁剪到画布内',
    clipped.x === 0 && clipped.y === 0 && clipped.w === 1 && clipped.h === 1);

  const scene = { widthEmu: 12192000, heightEmu: 6858000, background: null, nodes: [], slots: [norm], skippedFrames: 0, media: {} };
  const json = model.buildBaseJson(scene, 'demo.pptx');
  check('base.json 契约：版本/画幅/槽位',
    json.version === 1 && json.source === 'demo.pptx'
      && json.canvas.width === 1536 && json.canvas.height === 864
      && json.slide.widthEmu === 12192000 && json.slots.length === 1);

  check('rels 路径规范化解析 .. 与 .',
    model.resolveZipPath('ppt/slides', '../media/image1.png') === 'ppt/media/image1.png'
      && model.resolveZipPath('ppt', 'slides/slide1.xml') === 'ppt/slides/slide1.xml'
      && model.resolveZipPath('ppt/slides', './../theme/./theme1.xml') === 'ppt/theme/theme1.xml');
}

/** 截图 AI 路线服务端：VLM 抽标题 + 编辑模型去风格化，全 mock 不打真实上游。 */
export async function runPptToBaseServerTests(ctx) {
  const { check, expectThrows, auth, credits, llmConfig, makeMockFetcher, editsOkHandler, PNG_1X1_B64 } = ctx;
  console.log('\n[7f] PPT 转模版底座·截图 AI 路线（服务端全 mock）');
  const baseImage = await import('../../src/modules/ppt-to-base/server/base-image.ts');
  const { getDb } = await import('../../src/lib/server/db.ts');
  const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
  const recovery = await import('../../src/lib/server/generation/recovery.ts');
  const paidRun = await import('../../src/lib/server/generation/paid-run.ts');

  const tester = await auth.registerWithPassword(
    { account: 'p2btester', password: 'password123', confirmPassword: 'password123' },
    '127.0.4.1',
  );
  const tid = tester.user.id;
  getDb().prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(tid);
  const shot = Buffer.from(PNG_1X1_B64, 'base64');
  const vlmOk = { match: '/chat/completions', payload: { choices: [{ message: { content: '{"title":"核心目的"}' } }] } };
  const refundRows = (userId) => getDb()
    .prepare("SELECT idempotency_key, delta FROM credit_ledger WHERE user_id = ? AND event_type = 'refund'")
    .all(userId)
    .map((row) => ({ key: String(row.idempotency_key), delta: Number(row.delta) }));
  const rowStatus = (jobId) => String(genDb.prepare('SELECT status FROM ppt_to_base_jobs WHERE id = ?').get(jobId)?.status || '');
  const registerUser = async (account, ip) => (await auth.registerWithPassword(
    { account, password: 'password123', confirmPassword: 'password123' },
    ip,
  )).user.id;
  // 制造「进程死在运行中途」的残留行：任务表只归模块读写，测试只铺最小现场，断言看余额/账本键/终态
  const seedResidue = ({ id, userId, requestId, chargeKey, status = 'running', updatedAt }) => {
    genDb.prepare(
      `INSERT INTO ppt_to_base_jobs (id, user_id, request_id, charge_key, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      requestId,
      chargeKey,
      status,
      status === 'failed' ? '旧进程已置失败' : '',
      updatedAt,
      updatedAt,
    );
  };
  const staleAt = Date.now() - 2 * 60 * 60 * 1000;

  const fetcher1 = makeMockFetcher([vlmOk, editsOkHandler]);
  const before = credits.getBalance(tid);
  const r1 = await baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-1' }, { fetchImpl: fetcher1, config: llmConfig });
  check('成功：抽出标题、落盘底座图、扣 5🌟',
    r1.title === '核心目的'
      && r1.imageUrl.startsWith('/api/files/generated/')
      && r1.imageUrl.includes('ppt-to-base')
      && before - r1.balance === 5);
  check('扣费键沿用历史前缀 ppt-to-base:{userId}:{requestId}',
    getDb().prepare('SELECT delta FROM credit_ledger WHERE idempotency_key = ?').get(`ppt-to-base:${tid}:p2b-1`)?.delta === -5);
  const editBody = fetcher1.calls.find((c) => c.url.includes('/images/edits'))?.init?.body;
  const editPrompt = editBody instanceof FormData ? String(editBody.get('prompt') || '') : '';
  check('提示词：点名参考图 + 改变项/不变量分离 + 中性词逐字加引号',
    editPrompt.includes('参考图是一张 PPT 幻灯片截图')
      && editPrompt.includes('去风格化')
      && editPrompt.includes('"标题"') && editPrompt.includes('"副标题"') && editPrompt.includes('"要点"')
      && editPrompt.includes('"图片"') && editPrompt.includes('"数据"')
      && editPrompt.includes('必须保持不变'),
    editPrompt.slice(0, 120));
  check('编辑请求带原图', editBody instanceof FormData && editBody.get('image') !== null);
  const vlmBody = JSON.parse(String(fetcher1.calls.find((c) => c.url.includes('/chat/completions'))?.init?.body || '{}'));
  const vlmParts = vlmBody?.messages?.[0]?.content;
  check('VLM 带图抽标题（vision 分段 + dataURL）',
    Array.isArray(vlmParts) && vlmParts.some((p) => p.type === 'image_url' && String(p.image_url?.url || '').startsWith('data:image/png;base64,')));

  const replayFetcher = makeMockFetcher([vlmOk, editsOkHandler]);
  await expectThrows('同 requestId 重放按 409 拒', () =>
    baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-1' }, {
      fetchImpl: replayFetcher, config: llmConfig,
    }), 'DUPLICATE_REQUEST');
  check('重放不再扣费、也不再打上游', credits.getBalance(tid) === r1.balance && replayFetcher.calls.length === 0);
  const replayRow = genDb
    .prepare("SELECT status FROM ppt_to_base_jobs WHERE user_id = ? AND request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(tid, 'p2b-1');
  check('重放本次生成的行置 failed（不动首笔扣费）', String(replayRow?.status) === 'failed');

  const vlmDown = makeMockFetcher([
    { match: '/chat/completions', payload: () => { throw new Error('vlm down'); } },
    editsOkHandler,
  ]);
  const r2 = await baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-2' }, { fetchImpl: vlmDown, config: llmConfig });
  check('VLM 失败降级空标题，主流程仍成功', r2.title === '' && r2.imageUrl.includes('ppt-to-base'));

  const editDown = makeMockFetcher([vlmOk, { match: '/images/edits', status: 400, payload: { error: { message: 'bad input' } } }]);
  const beforeFail = credits.getBalance(tid);
  await expectThrows('生图失败抛上游错误码', () =>
    baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-3' }, { fetchImpl: editDown, config: llmConfig }), 'IMAGE_REQUEST_INVALID');
  check('失败全额退星', credits.getBalance(tid) === beforeFail);

  const plain = await auth.registerWithPassword(
    { account: 'p2bplain', password: 'password123', confirmPassword: 'password123' },
    '127.0.4.2',
  );
  await expectThrows('开关外用户按 404 处理', () =>
    baseImage.runPptToBase(plain.user.id, { image: shot, requestId: 'p2b-x' }, {
      fetchImpl: makeMockFetcher([vlmOk, editsOkHandler]), config: llmConfig,
    }), 'NOT_FOUND');

  const poor = await auth.registerWithPassword(
    { account: 'p2bpoor', password: 'password123', confirmPassword: 'password123' },
    '127.0.4.3',
  );
  getDb().prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(poor.user.id);
  credits.debitCredits(poor.user.id, 97, { reason: '测试消耗', idempotencyKey: 'test-drain-p2b' });
  await expectThrows('余额不足 402', () =>
    baseImage.runPptToBase(poor.user.id, { image: shot, requestId: 'p2b-poor' }, {
      fetchImpl: makeMockFetcher([vlmOk, editsOkHandler]), config: llmConfig,
    }), 'INSUFFICIENT_CREDITS');
  const poorRow = genDb.prepare("SELECT status FROM ppt_to_base_jobs WHERE user_id = ? AND request_id = 'p2b-poor'").get(poor.user.id);
  check('扣费失败：claim 行已落且置 failed（行先于扣费）', String(poorRow?.status) === 'failed');

  await expectThrows('缺 requestId 校验失败', () =>
    baseImage.runPptToBase(tid, { image: shot, requestId: '' }, { fetchImpl: makeMockFetcher([]), config: llmConfig }),
    'VALIDATION_ERROR');
  check('估价动作键已接入（5🌟/张）', credits.estimateCredits({ action: 'ppt_to_base' }).credits === 5);

  // --- 计费运行接入：运行中以扣费键登记在飞，恢复判活认这把键（心跳过期也不误杀在途运行）---
  const json = (payload) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  let releaseEdit = () => {};
  const editGate = new Promise((resolve) => { releaseEdit = resolve; });
  let editStarted = false;
  const liveFetcher = async (url) => {
    const target = String(url);
    if (target.includes('/chat/completions')) return json({ choices: [{ message: { content: '{"title":"运行中"}' } }] });
    if (target.includes('/images/edits')) {
      editStarted = true;
      await editGate;
      return json({ data: [{ b64_json: PNG_1X1_B64 }] });
    }
    throw new Error(`未预期的上游调用：${target}`);
  };
  const liveKey = `ppt-to-base:${tid}:p2b-live`;
  const beforeLive = credits.getBalance(tid);
  const livePromise = baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-live' }, { fetchImpl: liveFetcher, config: llmConfig });
  for (let i = 0; i < 400 && !editStarted; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const liveEntry = paidRun.listInFlight(tid).find((run) => run.runId === liveKey);
  check('运行中：在飞注册表登记键 = 扣费键（域/动作可读）',
    editStarted && liveEntry?.domain === 'ppt-to-base' && liveEntry?.action === 'ppt_to_base',
    JSON.stringify(paidRun.listInFlight(tid)));
  genDb.prepare("UPDATE ppt_to_base_jobs SET updated_at = ? WHERE user_id = ? AND request_id = 'p2b-live'").run(staleAt, tid);
  check('运行中且心跳过期：恢复不误收敛、不提前退款',
    recovery.reconcileUser(tid) === 0 && credits.getBalance(tid) === beforeLive - 5,
    `实际 ${credits.getBalance(tid)} / ${JSON.stringify(paidRun.listInFlight(tid))}`);
  releaseEdit();
  const liveResult = await livePromise;
  check('放行后成功：余额保持实扣、无退款、在飞清空',
    liveResult.balance === beforeLive - 5
      && refundRows(tid).every((row) => row.key !== credits.deriveRefundKey(liveKey))
      && !paidRun.listInFlight(tid).some((run) => run.runId === liveKey));

  // --- 崩溃窗口一：扣费后进程死亡 → 恢复按实扣金额补退一次 ---
  const crashJobId = 'ptb_crash';
  const crashChargeKey = `ppt-to-base:${tid}:p2b-crash`;
  const beforeCrash = credits.getBalance(tid);
  credits.debitCredits(tid, 5, {
    reason: 'PPT 转模版底座', idempotencyKey: crashChargeKey, refType: 'ppt-to-base', refId: 'p2b-crash',
  });
  seedResidue({ id: crashJobId, userId: tid, requestId: 'p2b-crash', chargeKey: crashChargeKey, updatedAt: Date.now() });
  check('中断现场：已扣 5🌟 且未退回', credits.getBalance(tid) === beforeCrash - 5);
  check('在途未超时不误收敛',
    recovery.reconcileUser(tid) === 0 && credits.getBalance(tid) === beforeCrash - 5);
  genDb.prepare('UPDATE ppt_to_base_jobs SET created_at = ?, updated_at = ? WHERE id = ?').run(staleAt, staleAt, crashJobId);
  // 余额读接口（站点头部每次加载）：不写恢复代码也能补退中断的底座任务
  const balanceRoute = await import('../../src/app/api/credits/balance/route.ts');
  const balanceResponse = await balanceRoute.GET(new Request('http://localhost/api/credits/balance', {
    headers: { cookie: `anppt_v2_session=${encodeURIComponent(auth.createSessionForUser(tid))}` },
  }));
  const balanceBody = await balanceResponse.json();
  check('超时残留行被余额读点收敛（无恢复调用）', balanceBody?.data?.balance === beforeCrash, `实际 ${balanceBody?.data?.balance}`);
  check('残留行置 failed 带中断文案',
    rowStatus(crashJobId) === 'failed'
      && String(genDb.prepare('SELECT error FROM ppt_to_base_jobs WHERE id = ?').get(crashJobId)?.error).includes('中断'));
  const crashRefunds = refundRows(tid).filter((row) => row.key === credits.deriveRefundKey(crashChargeKey));
  check('补退按实扣金额、退款键定长派生、只一笔',
    crashRefunds.length === 1 && crashRefunds[0].delta === 5, JSON.stringify(crashRefunds));
  check('恢复幂等：重复收敛不重复退款',
    recovery.reconcileUser(tid) === 0 && credits.getBalance(tid) === beforeCrash);

  // --- 崩溃窗口二：退款已落账、failed 未写（死在两者之间）→ 恢复补齐终态且不双退 ---
  const refundCrashUser = await registerUser('p2bcrashrefund', '127.0.4.4');
  const refundCrashKey = `ppt-to-base:${refundCrashUser}:p2b-crash-refund`;
  const refundCrashBefore = credits.getBalance(refundCrashUser);
  credits.debitCredits(refundCrashUser, 5, {
    reason: 'PPT 转模版底座', idempotencyKey: refundCrashKey, refType: 'ppt-to-base', refId: 'p2b-crash-refund',
  });
  credits.refundCredits(refundCrashUser, 5, {
    reason: '底座生成失败退回',
    idempotencyKey: credits.deriveRefundKey(refundCrashKey),
    refType: 'ppt-to-base',
    refId: 'p2b-crash-refund',
  });
  seedResidue({
    id: 'ptb_crash_refund',
    userId: refundCrashUser,
    requestId: 'p2b-crash-refund',
    chargeKey: refundCrashKey,
    updatedAt: staleAt,
  });
  check('退款后崩溃：退款已落账、行仍在途',
    credits.getBalance(refundCrashUser) === refundCrashBefore && refundRows(refundCrashUser).length === 1);
  check('退款后崩溃：恢复补齐 failed 终态、不重复退款',
    recovery.reconcileUser(refundCrashUser) === 1
      && credits.getBalance(refundCrashUser) === refundCrashBefore
      && refundRows(refundCrashUser).length === 1
      && rowStatus('ptb_crash_refund') === 'failed');
  check('重复恢复：后续不再退款',
    recovery.reconcileUser(refundCrashUser) === 0 && refundRows(refundCrashUser).length === 1);

  // --- 崩溃窗口三：已置终态（failed）后再恢复 → 不列、不退、不改 ---
  const terminalUser = await registerUser('p2bterminal', '127.0.4.5');
  const terminalKey = `ppt-to-base:${terminalUser}:p2b-terminal`;
  const terminalBefore = credits.getBalance(terminalUser);
  credits.debitCredits(terminalUser, 5, {
    reason: 'PPT 转模版底座', idempotencyKey: terminalKey, refType: 'ppt-to-base', refId: 'p2b-terminal',
  });
  credits.refundCredits(terminalUser, 5, {
    reason: '底座生成失败退回',
    idempotencyKey: credits.deriveRefundKey(terminalKey),
    refType: 'ppt-to-base',
    refId: 'p2b-terminal',
  });
  seedResidue({
    id: 'ptb_terminal',
    userId: terminalUser,
    requestId: 'p2b-terminal',
    chargeKey: terminalKey,
    status: 'failed',
    updatedAt: staleAt,
  });
  check('终态后恢复：不列终态行、不再退款、不改终态',
    recovery.reconcileUser(terminalUser) === 0
      && credits.getBalance(terminalUser) === terminalBefore
      && refundRows(terminalUser).length === 1
      && rowStatus('ptb_terminal') === 'failed');
}
