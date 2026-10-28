// deck 意图解析器契约测试：kind → 解析器是「什么 payload 合法」的唯一回答。
// 解析器是纯函数（前后端共用、不含 IO）：类型、字符串上限、布尔归一、数组清洗在它内部；
// 计费/幂等/权限/开关等业务硬门不在解析器里，仍由 src/lib/server/generation/actions.ts 决定。
// 由 scripts/test-generation.mjs 汇总调用。

export async function runDeckIntentParserTests({ check }) {
  const intents = await import('../../src/lib/deck-intents.ts');
  const envelope = await import('../../src/lib/intent-envelope.ts');
  const server = await import('../../src/lib/server/intents.ts');
  const table = intents.DECK_INTENT_PARAMS;
  const parse = (kind, params) => envelope.parseIntent({ kind, params }, table);
  const rejection = (run) => {
    try {
      run();
      return null;
    } catch (error) {
      return error;
    }
  };

  console.log('\n[4h] deck 意图解析器：kind → 解析（类型 / 上限 / 布尔归一 / 数组清洗）');

  // ---------- 骨架：一次 parse 得到类型化参数，或带文案的失败 ----------
  const trimmed = parse('removeSlide', { slideId: '  s1  ' });
  check('解析成功：字段按解析器清洗后进类型化参数',
    trimmed?.ok === true && trimmed.kind === 'removeSlide' && trimmed.params.slideId === 's1',
    JSON.stringify(trimmed));

  const missing = parse('removeSlide', {});
  check('解析失败：失败结果带解析器文案，不抛异常',
    missing?.ok === false && missing.message === '缺少 slideId',
    JSON.stringify(missing));

  const adapterRejection = rejection(() =>
    server.readIntentParams({ intent: { kind: 'removeSlide', params: {} } }, table));
  check('服务器适配器：解析失败套成统一 400（VALIDATION_ERROR + 解析器文案）',
    adapterRejection?.code === 'VALIDATION_ERROR' && adapterRejection?.status === 400
      && adapterRejection?.message === '缺少 slideId',
    `${adapterRejection?.code} ${adapterRejection?.status} ${adapterRejection?.message}`);

  // ---------- 20 个 kind：合法 payload 全通过，非法 payload 统一失败 ----------
  const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const LEGAL_PAYLOADS = {
    generateOutline: { force: true },
    addSlide: { atIndex: 1, slide: { role: 'content', chapter: '业绩', title: '年度回顾' } },
    removeSlide: { slideId: 'slide-1' },
    reorderSlides: { order: ['slide-2', 'slide-1'] },
    splitSlide: { slideId: 'slide-1', into: 3 },
    updateSlide: {
      slideId: 'slide-1',
      title: '新标题',
      rawText: '2025 年营收 1200 万元。',
      summary: ['营收 1200 万元'],
      structuredContent: '【标题】新标题\n【正文】营收 1200 万元。',
    },
    commitVersion: { slideId: 'slide-1', versionId: 'version-1' },
    structureSlides: { force: true },
    structureSlide: { slideId: 'slide-1' },
    confirmStructure: {},
    unlockStructure: {},
    setStyle: { stylePackId: 'pack-1' },
    setReferenceImage: { slideId: null },
    generateSlides: { forceRegenerate: true },
    retryFailedSlides: {},
    generateSlide: { slideId: 'slide-1' },
    refineSlide: { slideId: 'slide-1', editInstruction: '把标题放大一点' },
    eraseSlide: { slideId: 'slide-1', markImageDataUrl: IMAGE_DATA_URL },
    editSlideText: { slideId: 'slide-1', editInstruction: '把标题改成「年度报告」' },
    fuseSlide: { slideId: 'slide-1', fusionPackId: 'pack-2', editInstruction: '向商务风靠拢' },
  };
  const kinds = intents.DECK_INTENT_KINDS;
  check('表项全是解析器函数，且表键与 20 个 kind 一一对应',
    kinds.length === 20 && new Set(kinds).size === 20
      && kinds.every((kind) => typeof table[kind] === 'function'),
    `kinds=${kinds.length}`);
  const legalFailures = kinds
    .filter((kind) => parse(kind, LEGAL_PAYLOADS[kind])?.ok !== true);
  check('20 个 kind 的合法 payload 全部解析通过（表穷尽，不落默认拒绝）',
    legalFailures.length === 0, legalFailures.join(', '));

  // 形状不合法一律失败：每个 kind 都有能说清楚为什么的拒绝面
  const ILLEGAL_PAYLOADS = {
    generateOutline: { force: 'maybe' },
    addSlide: { atIndex: 1.5 },
    removeSlide: {},
    reorderSlides: { order: 'slide-1' },
    splitSlide: { slideId: 'slide-1', into: 'many' },
    updateSlide: { slideId: 'slide-1', role: 'boss' },
    commitVersion: { slideId: 'slide-1' },
    structureSlides: { force: 'maybe' },
    structureSlide: {},
    confirmStructure: [],
    unlockStructure: [],
    setStyle: { stylePackId: { id: 'pack' } },
    setReferenceImage: { slideId: { id: 'slide' } },
    generateSlides: { forceRegenerate: 'maybe' },
    retryFailedSlides: 'not-an-object',
    generateSlide: {},
    refineSlide: { slideId: 'slide-1' },
    eraseSlide: { slideId: 'slide-1', markImageDataUrl: 'not-a-data-url' },
    editSlideText: { slideId: 'slide-1' },
    fuseSlide: { slideId: 'slide-1' },
  };
  const illegalSurvivors = kinds.filter((kind) => parse(kind, ILLEGAL_PAYLOADS[kind])?.ok !== false);
  check('20 个 kind 的非法 payload 全部拒绝（每个 kind 都有拒绝面）',
    illegalSurvivors.length === 0, illegalSurvivors.join(', '));

  // 解析器是纯函数：垃圾输入不抛异常，结果恒为 {ok}
  const garbage = [null, 1, 'x', [], { slideId: {} }, { slideId: [1] }, { order: 'slide-1' }, { force: 'maybe' },
    { into: 1.5 }, { markImageDataUrl: 'not-a-data-url' }, { summary: [1] }, { slide: [] }];
  const garbageSurvivors = kinds.filter((kind) =>
    garbage.some((params) => {
      try {
        const result = table[kind](params);
        return !result || typeof result.ok !== 'boolean';
      } catch {
        return true;
      }
    }));
  check('垃圾 payload 不抛异常、结果恒为 {ok}（解析器是纯函数）',
    garbageSurvivors.length === 0, garbageSurvivors.join(', '));

  // ---------- 归一：布尔 / 整数 / 字符串上限 / 数组清洗 ----------
  check('布尔归一："true"/1 → true，"false"/0 → false，其余值拒绝',
    parse('generateOutline', { force: 'true' })?.params?.force === true
      && parse('generateOutline', { force: 1 })?.params?.force === true
      && parse('generateOutline', { force: 'FALSE' })?.params?.force === false
      && parse('generateOutline', { force: 0 })?.params?.force === false
      && parse('generateOutline', { force: 'yes' })?.ok === false);
  check('整数归一：splitSlide.into 夹在 2–5，缺省按 2；atIndex 必须是整数',
    parse('splitSlide', { slideId: 's', into: 9 })?.params?.into === 5
      && parse('splitSlide', { slideId: 's', into: 1 })?.params?.into === 2
      && parse('splitSlide', { slideId: 's' })?.params?.into === 2
      && parse('addSlide', { atIndex: 2 })?.params?.atIndex === 2
      && parse('addSlide', { atIndex: 1.5 })?.ok === false);
  check('字符串上限与洗空白：slideId ≤80、editInstruction ≤1000、draft 标题 ≤200 / 原文 ≤8000',
    parse('refineSlide', { slideId: 'x'.repeat(200), editInstruction: ' y '.repeat(1200) })?.params?.slideId.length === 80
      && parse('refineSlide', { slideId: 's', editInstruction: ' y '.repeat(1200) })?.params?.editInstruction.length === 1000
      && parse('addSlide', { slide: { title: 't'.repeat(300), rawText: 'r'.repeat(9000) } })?.params?.slide.title.length === 200
      && parse('addSlide', { slide: { title: 't'.repeat(300), rawText: 'r'.repeat(9000) } })?.params?.slide.rawText.length === 8000);
  check('数组清洗：order 去空白、丢空项；非数组/非字符串元素拒绝',
    JSON.stringify(parse('reorderSlides', { order: [' s2 ', '', 's1 '] })?.params?.order) === '["s2","s1"]'
      && parse('reorderSlides', { order: 's1' })?.ok === false
      && parse('reorderSlides', { order: [1] })?.ok === false);
  const cleanedPatch = parse('updateSlide', {
    slideId: ' s1 ',
    title: ' 新标题 ',
    summary: [' 要点 ', ''],
    extra: '丢弃',
  })?.params;
  check('updateSlide：只保留已知 patch 字段并清洗（未知字段不进动作）',
    cleanedPatch?.slideId === 's1' && cleanedPatch?.title === '新标题'
      && JSON.stringify(cleanedPatch?.summary) === '["要点"]'
      && !('extra' in cleanedPatch),
    JSON.stringify(cleanedPatch));
  check('updateSlide：role 只认五种页角色，非法枚举拒绝',
    parse('updateSlide', { slideId: 's', role: 'cover' })?.params?.role === 'cover'
      && parse('updateSlide', { slideId: 's', role: 'boss' })?.ok === false);
  check('updateSlide：structuredContent 去空白后为空 → 400（文案沿用旧文案）',
    parse('updateSlide', { slideId: 's', structuredContent: '   ' })?.message === '梳理内容不能为空');
  check('setReferenceImage：null 原样（取消锚点），字符串清洗',
    parse('setReferenceImage', { slideId: null })?.params?.slideId === null
      && parse('setReferenceImage', { slideId: ' p1 ' })?.params?.slideId === 'p1');

  // ---------- 图片字段：dataURL 形状/大小在解析器回答（动作只负责解码与生图） ----------
  check('eraseSlide：非 dataURL / 空内容 / 超 2MB 均拒绝且文案不变',
    parse('eraseSlide', { slideId: 's', markImageDataUrl: 'not-a-data-url' })?.message === '涂抹标记图 必须是图片 base64 dataURL'
      && parse('eraseSlide', { slideId: 's', markImageDataUrl: 'data:image/png;base64,==' })?.message === '涂抹标记图 内容为空'
      && parse('eraseSlide', { slideId: 's', markImageDataUrl: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` })?.message === '涂抹标记图 超过大小上限（2MB）'
      && parse('eraseSlide', { slideId: 's', markImageDataUrl: IMAGE_DATA_URL })?.ok === true);

  // ---------- 必填字段与无参意图 ----------
  check('缺少必填字段：统一 400 文案仍逐字沿用旧文案',
    parse('commitVersion', { slideId: 's' })?.message === '缺少 slideId 或 versionId'
      && parse('refineSlide', { slideId: 's' })?.message === '缺少 editInstruction'
      && parse('structureSlide', {})?.message === '缺少 slideId'
      && parse('fuseSlide', { slideId: 's' })?.message === '缺少 fusionPackId');
  check('无参意图只回空对象（未知参数不进动作）',
    JSON.stringify(parse('retryFailedSlides', { slideId: 'x' })?.params) === '{}'
      && JSON.stringify(parse('unlockStructure', { force: true })?.params) === '{}');

  // ---------- 解析器不碰业务硬门（动作仍拥有拒绝权） ----------
  check('解析器只回答形状：未知风格包/融合包解析通过，由动作在业务层拒绝',
    parse('setStyle', { stylePackId: 'no-such-pack' })?.ok === true
      && parse('fuseSlide', { slideId: 's', fusionPackId: 'no-such-pack' })?.ok === true);
  check('解析器不碰计费/权限：合法形状的生成意图不因余额或开关在解析期被拒',
    parse('generateSlides', {})?.ok === true
      && parse('eraseSlide', { slideId: 's', markImageDataUrl: IMAGE_DATA_URL })?.ok === true);
}
