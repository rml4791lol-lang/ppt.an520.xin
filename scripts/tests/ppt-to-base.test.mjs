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

  const tester = await auth.registerWithPassword(
    { account: 'p2btester', password: 'password123', confirmPassword: 'password123' },
    '127.0.4.1',
  );
  const tid = tester.user.id;
  getDb().prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(tid);
  const shot = Buffer.from(PNG_1X1_B64, 'base64');
  const vlmOk = { match: '/chat/completions', payload: { choices: [{ message: { content: '{"title":"核心目的"}' } }] } };

  const fetcher1 = makeMockFetcher([vlmOk, editsOkHandler]);
  const before = credits.getBalance(tid);
  const r1 = await baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-1' }, { fetchImpl: fetcher1, config: llmConfig });
  check('成功：抽出标题、落盘底座图、扣 5🌟',
    r1.title === '核心目的'
      && r1.imageUrl.startsWith('/api/files/generated/')
      && r1.imageUrl.includes('ppt-to-base')
      && before - r1.balance === 5);
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

  await expectThrows('同 requestId 重放按 409 拒', () =>
    baseImage.runPptToBase(tid, { image: shot, requestId: 'p2b-1' }, {
      fetchImpl: makeMockFetcher([vlmOk, editsOkHandler]), config: llmConfig,
    }), 'DUPLICATE_REQUEST');
  check('重放不再扣费', credits.getBalance(tid) === r1.balance);

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

  await expectThrows('缺 requestId 校验失败', () =>
    baseImage.runPptToBase(tid, { image: shot, requestId: '' }, { fetchImpl: makeMockFetcher([]), config: llmConfig }),
    'VALIDATION_ERROR');
  check('估价动作键已接入（5🌟/张）', credits.estimateCredits({ action: 'ppt_to_base' }).credits === 5);

  // --- 崩溃恢复：扣费后残留 running 行 → 懒恢复按实扣金额补退（幂等）---
  const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
  const crashJobId = 'ptb_crash';
  const crashChargeKey = `ppt-to-base:${tid}:p2b-crash`;
  const beforeCrash = credits.getBalance(tid);
  credits.debitCredits(tid, 5, {
    reason: 'PPT 转模版底座', idempotencyKey: crashChargeKey, refType: 'ppt-to-base', refId: 'p2b-crash',
  });
  genDb.prepare(
    "INSERT INTO ppt_to_base_jobs (id, user_id, request_id, charge_key, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', '', ?, ?)",
  ).run(crashJobId, tid, 'p2b-crash', crashChargeKey, Date.now(), Date.now());
  check('中断现场：已扣 5🌟 且未退回', credits.getBalance(tid) === beforeCrash - 5);
  check('在途未超时不误收敛',
    baseImage.reconcilePptToBase(tid) === false && credits.getBalance(tid) === beforeCrash - 5);
  const staleAt = Date.now() - 2 * 60 * 60 * 1000;
  genDb.prepare('UPDATE ppt_to_base_jobs SET created_at = ?, updated_at = ? WHERE id = ?').run(staleAt, staleAt, crashJobId);
  check('超时残留行被懒恢复收敛', baseImage.reconcilePptToBase(tid) === true);
  check('中断任务补退实扣金额（余额回原值）', credits.getBalance(tid) === beforeCrash, `实际 ${credits.getBalance(tid)}`);
  const crashRow = genDb.prepare('SELECT status, error FROM ppt_to_base_jobs WHERE id = ?').get(crashJobId);
  check('残留行置 failed 带中断文案',
    String(crashRow?.status) === 'failed' && String(crashRow?.error).includes('中断'));
  check('恢复幂等：重复收敛不重复退款',
    baseImage.reconcilePptToBase(tid) === false && credits.getBalance(tid) === beforeCrash);
}
