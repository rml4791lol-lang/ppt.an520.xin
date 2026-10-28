// [4j] 视觉计划（src/lib/server/generation/visual-plan.ts）契约：
// 页型只解析一次（pageType + title + goal + role），模板映射与提示词读同一键；
// 参考优先级 anchor > template > style、读取时首个可读候选胜出（读失败顺延）；
// 改图后缀归模块；复刻是计划的一个 mode（保壳世界）；蓝图失败在接口内降级为空串。
// 原孤儿脚本 test-page-types/test-mapping/test-prompt 中未被门覆盖的断言并入本段。
// 由 scripts/test-generation.mjs 汇总调用。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export async function runVisualPlanTests(ctx) {
  const { check, llmConfig } = ctx;
  console.log('\n[4j] 视觉计划：页型单源 / 参考优先级 / 复刻模式 / 改图后缀 / 蓝图降级');

  const visualPlan = await import('../../src/lib/server/generation/visual-plan.ts');
  const mapping = await import('../../src/lib/server/generation/mapping.ts');
  const pageTypes = await import('../../src/lib/server/generation/page-types.ts');
  const stylePacks = await import('../../src/lib/server/generation/style-packs.ts');
  const templates = await import('../../src/lib/server/templates.ts');

  const pack = stylePacks.resolveStylePack('anppt-original-innovation-20260822');
  check('测试风格包可用', Boolean(pack));
  // 假模板：pain-analysis 载体在 1 号，content 兜底在 2 号
  const templatePages = [
    { pageType: 'cover', imageUrl: '/assets/tpl/01-cover.png' },
    { pageType: 'pain-analysis', imageUrl: '/assets/tpl/02-pain.png' },
    { pageType: 'content', imageUrl: '/assets/tpl/03-content.png' },
  ];
  const deckContext = { totalPages: 5, pageIndex: 3, chapter: '问题', deckTitle: '智慧农业' };
  // 分歧案例：pageType 为空，只有标题命中「痛点分析」
  const divergentSlide = {
    pageIndex: 3,
    pageType: '',
    role: 'content',
    title: '痛点分析',
    goal: '',
    summary: ['传统种植决策依赖经验'],
    structuredContent: '',
    visualNote: '',
  };

  const resolved = pageTypes.resolveSlidePageType(divergentSlide);
  check('页型解析证据含标题：空 pageType + 标题命中痛点分析页', resolved.key === 'pain-analysis', `实际 ${resolved.key}`);
  const mappingRows = mapping.buildOutlinePageMapping([divergentSlide], templatePages);
  check('模板映射与提示词读同一页型键（映射不再只看 pageType）',
    mappingRows[0].logicalPageType === resolved.key,
    `映射 ${mappingRows[0].logicalPageType} / 解析 ${resolved.key}`);

  // 整套批量解析与逐页计划必须用同一份标题证据（结构化文案标题优先）
  const dslSlide = {
    pageIndex: 7,
    pageType: '',
    role: 'content',
    title: '本页内容',
    goal: '',
    summary: [],
    structuredContent: '【标题】痛点分析\n【正文】传统种植决策依赖经验',
    visualNote: '',
  };
  const dslIdentities = visualPlan.resolveVisualPlanPageTypes([dslSlide]);
  const dslPlan = visualPlan.buildVisualPlan({
    slide: dslSlide,
    deckContext,
    stylePack: pack,
    template: null,
    mode: 'generate',
  });
  check('整套批量页型与逐页计划的标题证据一致（结构化文案标题优先）',
    dslIdentities[0].key === 'pain-analysis' && dslPlan.pageTypeKey === dslIdentities[0].key,
    `批量 ${dslIdentities[0].key} / 计划 ${dslPlan.pageTypeKey}`);
  const keyedPlan = visualPlan.buildVisualPlan({
    slide: dslSlide,
    deckContext,
    stylePack: pack,
    template: null,
    mode: 'generate',
    pageType: pageTypes.resolvePageType('数据图表', 'content'),
  });
  check('传入已解析页型时计划不再重新解析（提示词读同一键）',
    keyedPlan.pageTypeKey === 'data-chart' && keyedPlan.prompt.includes('页型协议 · 数据图表页'),
    `实际 ${keyedPlan.pageTypeKey}`);

  const plan = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext,
    stylePack: pack,
    template: { pages: templatePages, mapping: mappingRows },
    anchorImagePath: '/storage/user-1/anchor.png',
    mode: 'generate',
  });
  check('计划输出页型键与模板映射一致',
    plan.pageTypeKey === mappingRows[0].logicalPageType && plan.pageTypeKey === 'pain-analysis',
    `实际 ${plan.pageTypeKey}`);
  check('模板参考按同一页型键选中 pain-analysis 载体',
    plan.references.find((item) => item.source === 'template')?.path === '/assets/tpl/02-pain.png',
    JSON.stringify(plan.references));

  // 优先级：anchor > template > style；锚点 override 不丢其余候选
  check('参考优先级 = 锚点 > 模板样张 > 风格样张',
    plan.references.map((item) => item.source).join(',') === 'anchor,template,style',
    plan.references.map((item) => item.source).join(','));
  check('锚点 override 后主参考是锚点、模板与风格候选都还在',
    plan.primaryReference?.source === 'anchor' && plan.references.length === 3);
  check('每个候选都带非空路径', plan.references.every((item) => Boolean(item.path)));

  const noAnchor = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext,
    stylePack: pack,
    template: { pages: templatePages, mapping: mappingRows },
    mode: 'generate',
  });
  check('无锚点时主参考是模板样张，风格样张保留为后备',
    noAnchor.primaryReference?.source === 'template'
      && noAnchor.references.map((item) => item.source).join(',') === 'template,style');

  const noTemplate = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext,
    stylePack: pack,
    template: null,
    anchorImagePath: '/storage/user-1/anchor.png',
    mode: 'generate',
  });
  check('模板路由缺席时仍保留锚点与风格候选',
    noTemplate.references.map((item) => item.source).join(',') === 'anchor,style');

  const styleOnly = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext,
    stylePack: pack,
    template: null,
    mode: 'generate',
  });
  check('无锚点无模板时回退风格样张',
    styleOnly.primaryReference?.source === 'style' && styleOnly.references.length === 1);

  // 读取顺序：调用方按计划优先级取第一个可读候选；读失败顺延，不整条丢参考
  const styleReferencePath = plan.references.find((item) => item.source === 'style')?.path;
  const anchorBytes = Buffer.from('anchor-image');
  const readPublic = (refPath) => (refPath === '/assets/tpl/02-pain.png'
    ? 'data:image/png;base64,TEMPLATE'
    : refPath === styleReferencePath ? 'data:image/png;base64,STYLE' : null);
  check('参考图读取：锚点可读时用锚点（且按计划优先级先读锚点）',
    await visualPlan.resolveVisualPlanReference(plan, { readAnchor: async () => anchorBytes, readPublic })
      === `data:image/png;base64,${anchorBytes.toString('base64')}`);
  check('参考图读取：锚点不可读时顺延到模板样张',
    await visualPlan.resolveVisualPlanReference(plan, { readAnchor: async () => null, readPublic })
      === 'data:image/png;base64,TEMPLATE');
  check('参考图读取：模板样张不可读时顺延到风格样张',
    await visualPlan.resolveVisualPlanReference(plan, {
      readAnchor: async () => null,
      readPublic: (refPath) => (refPath === '/assets/tpl/02-pain.png' ? null : readPublic(refPath)),
    }) === 'data:image/png;base64,STYLE');
  check('参考图读取：全部候选不可读时返回 null（不抛错）',
    await visualPlan.resolveVisualPlanReference(plan, { readAnchor: async () => null, readPublic: () => null }) === null);

  // 复刻是计划的一个 mode：壳页结构卡参与页型证据，世界约束进提示词，不取额外参考图
  const shellCard = {
    family: 'table',
    zones: '顶栏标题，下方三行参数表',
    slots: '1 张 5 列表格',
    hierarchy: '标题最大',
    world: '水彩森林中的石板路',
    forbidden: ['旧标题'],
  };
  const replicateSlide = {
    pageIndex: 2,
    pageType: '',
    role: 'content',
    title: '参数明细',
    goal: '',
    summary: ['处理器 A', '功耗 12W'],
    structuredContent: '',
  };
  const replicatePlan = visualPlan.buildVisualPlan({
    slide: replicateSlide,
    deckContext: { totalPages: 1, pageIndex: 2 },
    stylePack: pack,
    template: { pages: templatePages, mapping: mappingRows },
    mode: 'replicate',
    replicate: { structure: shellCard, colorMode: 'follow-shell' },
  });
  check('复刻模式：页型证据纳入壳页结构卡（table + 标题）',
    replicatePlan.pageTypeKey === 'table', `实际 ${replicatePlan.pageTypeKey}`);
  check('复刻模式不取额外参考图（壳图由调用方作为改图底图）',
    replicatePlan.references.length === 0 && replicatePlan.primaryReference === null);
  check('复刻模式提示词保留壳世界：保画面 + 画面世界 + 跟随底图配色',
    replicatePlan.prompt.includes('保画面')
      && replicatePlan.prompt.includes('水彩森林中的石板路')
      && replicatePlan.prompt.includes('跟随底图的主辅色'));
  check('复刻模式提示词逐字带入页面文案',
    replicatePlan.prompt.includes('参数明细') && replicatePlan.prompt.includes('处理器 A'));
  check('复刻模式不注入八段主题推断段（避免冲掉壳画风）',
    !replicatePlan.prompt.includes('页型协议')
      && !replicatePlan.prompt.includes('全套全局视觉规范')
      && !replicatePlan.prompt.includes('专业演示 PPT'));
  const replicateNewTheme = visualPlan.buildVisualPlan({
    slide: replicateSlide,
    deckContext: { totalPages: 1, pageIndex: 2 },
    stylePack: pack,
    template: null,
    mode: 'replicate',
    replicate: { structure: shellCard, colorMode: 'new-theme' },
  });
  check('复刻模式配色策略分叉：new-theme 只换色板',
    replicateNewTheme.prompt.includes('只换色板') && !replicateNewTheme.prompt.includes('跟随底图的主辅色'));
  const replicateEmptyShell = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext: { totalPages: 1, pageIndex: 0 },
    stylePack: null,
    template: null,
    mode: 'replicate',
    replicate: { structure: null, colorMode: 'follow-shell' },
  });
  check('复刻模式结构卡缺失时降级为从底图归纳，页型仍按标题证据解析',
    replicateEmptyShell.pageTypeKey === 'pain-analysis'
      && replicateEmptyShell.prompt.includes('从底图自行归纳'));

  // 真模板映射（推导型模板页）+ 双路线提示词（原 test-mapping.mjs 并入）
  const derivedPack = templates.getTemplate('anppt-original-innovation-20260822');
  const derivedPages = templates.getTemplatePages(derivedPack);
  const derivedSlides = [
    { pageIndex: 0, pageType: '封面', role: 'cover', title: '封面' },
    { pageIndex: 1, pageType: '团队介绍', role: 'content', title: '团队' },
    { pageIndex: 2, pageType: '项目设计', role: 'content', title: '设计' },
    { pageIndex: 3, pageType: '工作流程', role: 'content', title: '流程' },
    { pageIndex: 4, pageType: '技能要点', role: 'content', title: '技能' },
    { pageIndex: 5, pageType: '项目成果', role: 'content', title: '成果' },
    { pageIndex: 6, pageType: '创新点', role: 'content', title: '创新' },
    { pageIndex: 7, pageType: '应用价值', role: 'content', title: '价值' },
    { pageIndex: 8, pageType: '谢谢', role: 'ending', title: '结尾' },
    { pageIndex: 9, pageType: '痛点分析', role: 'content', title: '痛点' },
    { pageIndex: 10, pageType: '大数字指标', role: 'content', title: '数据' },
  ];
  const derivedMapping = mapping.buildOutlinePageMapping(derivedSlides, derivedPages);
  check('推导型真模板映射无 -1（每页都有载体）',
    derivedMapping.every((row) => row.templatePageIndex >= 0));
  check('推导型真模板：封面命中 cover 桶、数据页命中 data 桶',
    derivedPages[derivedMapping[0].templatePageIndex]?.pageType === 'cover'
      && derivedPages[derivedMapping[10].templatePageIndex]?.pageType === 'data');
  check('空映射取模板参考图为 null', mapping.resolveTemplateReferenceImage(derivedPages, [], 0) === null);
  const derivedStylePack = stylePacks.resolveStylePack(derivedPack.id);
  const dualSlide = {
    role: 'content',
    pageType: '工作流程',
    title: 'T',
    goal: '',
    copyLines: ['一步', '二步'],
    visualNote: '',
  };
  const templateRoutePrompt = stylePacks.buildSlideImagePrompt(dualSlide, derivedStylePack, {
    withStyleReferenceHint: true,
    referenceMode: 'template',
  });
  const styleRoutePrompt = stylePacks.buildSlideImagePrompt(dualSlide, derivedStylePack, {
    withStyleReferenceHint: true,
    referenceMode: 'style',
  });
  check('template 路线提示=复刻版式骨架灌内容',
    templateRoutePrompt.includes('真模板参考页')
      && templateRoutePrompt.includes('复刻它的版式骨架')
      && templateRoutePrompt.includes('把本页文案准确填入'));
  check('style 路线提示=只借风格，两条路线提示不同',
    styleRoutePrompt.includes('同风格参考样张')
      && styleRoutePrompt.includes('只提取它的色板')
      && templateRoutePrompt !== styleRoutePrompt);
  check('kind 判断：模板包 vs 风格包',
    templates.resolveTemplateKind(derivedPack) === 'template'
      && templates.resolveTemplateKind('cmrk8asi10033v7fx2zbu1y2o') === 'style');

  // 改图后缀归模块
  const refined = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext,
    stylePack: pack,
    template: { pages: templatePages, mapping: mappingRows },
    anchorImagePath: '/storage/user-1/anchor.png',
    mode: 'refine',
    refineInstruction: '把标题放大一点',
  });
  check('改图后缀由计划模块产出',
    refined.prompt.includes('改图要求（在保持整体风格与版式的前提下执行）：把标题放大一点'),
    refined.prompt.slice(-80));
  check('生成模式不出现改图后缀', !plan.prompt.includes('改图要求'));
  check('两种模式共用同一页型键与参考优先级',
    refined.pageTypeKey === plan.pageTypeKey
      && refined.references.map((item) => item.source).join(',') === 'anchor,template,style');
  // 改图意图 → 指令/降级说明：微调、图上改字、涂抹、融合的模板话术只在计划模块一份
  {
    const plain = visualPlan.buildRefineCopy({ kind: 'instruction', instruction: '把标题放大一点' });
    check('改图意图（微调）：只透传用户要求', plain.instruction === '把标题放大一点' && !plain.extraNote);
    const editText = visualPlan.buildRefineCopy({ kind: 'edit-text', instruction: '把标题改成年度报告' });
    check('改图意图（图上改字）：用户指令 + 只改指定文字的硬约束',
      editText.instruction.includes('把标题改成年度报告') && editText.instruction.includes('只改指定文字')
        && editText.instruction.includes('保持不变'));
    const erase = visualPlan.buildRefineCopy({ kind: 'erase' });
    check('改图意图（涂抹）：擦除指令与去红约束归计划模块',
      erase.instruction.includes('红色涂抹区') && erase.instruction.includes('不得出现红色标记')
        && Boolean(erase.extraNote?.includes('红色涂抹标记图未能传递')));
    const fuse = visualPlan.buildRefineCopy({
      kind: 'fuse',
      templateName: '水彩森林模板',
      visualKeywords: ['水彩', '森林', '留白'],
      instruction: '更商务一点',
    });
    check('改图意图（融合）：骨架保留 + 补充要求 + 丢图降级说明都归计划模块',
      fuse.instruction.includes('版式骨架保留') && fuse.instruction.includes('补充要求：更商务一点')
        && fuse.extraNote?.includes('水彩森林模板') && fuse.extraNote?.includes('水彩、森林、留白'));
    const actionsSrc = readFileSync(
      new URL('../../src/lib/server/generation/actions.ts', import.meta.url),
      'utf8',
    );
    check('动作层不再手写改图模板话术（涂抹/改字/融合文案只在视觉计划）',
      !actionsSrc.includes('红色涂抹区') && !actionsSrc.includes('图上改字：')
        && !actionsSrc.includes('版式骨架保留') && !actionsSrc.includes('融合参考图'));
  }

  // 八段提示词契约补强（原 test-prompt.mjs 中未被门覆盖的断言并入）
  const contractSlide = {
    role: 'content',
    pageType: '痛点分析',
    title: '传统种植决策依赖经验，损失率高',
    goal: '建立问题链',
    copyLines: ['经验判断导致灌溉时机误差大', '病虫害发现滞后，扩散快'],
    visualNote: '',
  };
  const blueprintText = '一、画面氛围：冷峻科技感。\n二、色彩与材质：深海蓝底、琥珀橙强调。';
  const contractPrompt = stylePacks.buildSlideImagePrompt(contractSlide, pack, {
    withStyleReferenceHint: true,
    deckContext: { totalPages: 9, pageIndex: 2, blueprint: blueprintText, deckTitle: '智慧农业' },
  });
  check('提示词含全局视觉规范段并完整注入蓝图正文',
    contractPrompt.includes('全套全局视觉规范') && contractPrompt.includes(blueprintText));
  check('页型协议五层（文字忠实/信息任务/构图/配图基因/禁忌）与防幻觉约束齐全',
    ['1. 文字忠实', '2. 信息任务', '3. 构图与版式', '4. 配图基因', '5. 禁忌']
      .every((layer) => contractPrompt.includes(layer))
      && contractPrompt.includes('防幻觉约束'));
  check('旧版式拼接已移除', !contractPrompt.includes('版式要求：'));
  const noBlueprintPrompt = stylePacks.buildSlideImagePrompt(contractSlide, pack, {
    deckContext: { totalPages: 9, pageIndex: 2 },
  });
  check('无蓝图时不出现规范段', !noBlueprintPrompt.includes('全套全局视觉规范'));
  const coverContractPrompt = stylePacks.buildSlideImagePrompt(
    { role: 'cover', pageType: '封面', title: '智慧农业', goal: '', copyLines: ['智慧农业'], visualNote: '' },
    pack,
    { deckContext: { totalPages: 9, pageIndex: 0 } },
  );
  check('封面协议与正文协议分层不同',
    coverContractPrompt.includes('页型协议 · 封面页') && coverContractPrompt.includes('严禁出现数据图表'));
  const competitorFingerprints = ['花卷', '抖研', 'MANDATORY TEXT CONTENT', 'PPT COVER MASTER', 'SMART TEMPLATE', 'flash-lite', 'gemini-3'];
  check('提示词无竞品原文案残留',
    competitorFingerprints.every((fingerprint) => !contractPrompt.includes(fingerprint) && !coverContractPrompt.includes(fingerprint)));

  // 蓝图：成功透出、失败在接口内降级为空串（调用方不再 catch）
  const bpDeck = { id: 'deck-visual-plan-bp', title: '蓝图接口测试', stylePackId: pack.id, sourceText: '素材' };
  const bpSlides = [{ pageType: 'cover', role: 'cover', title: '封面' }];
  const okBlueprint = await visualPlan.ensureVisualPlanBlueprint(bpDeck, bpSlides, {
    config: llmConfig,
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '一、画面氛围：统一' } }] }), { status: 200 }),
  });
  check('蓝图接口成功时透出规范正文', okBlueprint.includes('画面氛围'), okBlueprint);
  const failedBlueprint = await visualPlan.ensureVisualPlanBlueprint(
    { ...bpDeck, id: 'deck-visual-plan-bp-down' },
    bpSlides,
    { config: llmConfig, fetchImpl: async () => { throw new Error('mock LLM down'); } },
  );
  check('蓝图失败在接口内降级为空串、不向上抛', failedBlueprint === '');
  const emptyBlueprintPrompt = visualPlan.buildVisualPlan({
    slide: divergentSlide,
    deckContext: { ...deckContext, blueprint: failedBlueprint || undefined },
    stylePack: pack,
    template: { pages: templatePages, mapping: mappingRows },
    mode: 'generate',
  });
  check('空蓝图不留下空规范段', !emptyBlueprintPrompt.prompt.includes('全套全局视觉规范'));

  // 蓝图缓存与指纹（原 test-prompt.mjs 并入）：同输入不重复调 LLM，大纲变化才重算
  let bpFetchCount = 0;
  const bpCachedFetch = async () => {
    bpFetchCount += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '一、画面氛围：缓存命中。' } }] }), { status: 200 });
  };
  const cacheDeck = { id: 'deck-visual-plan-bp-cache', title: '蓝图缓存测试', stylePackId: pack.id, sourceText: '素材' };
  const cachedFirst = await visualPlan.ensureVisualPlanBlueprint(cacheDeck, bpSlides, {
    config: llmConfig,
    fetchImpl: bpCachedFetch,
  });
  check('蓝图生成后落盘缓存',
    cachedFirst.includes('缓存命中')
      && existsSync(path.join(llmConfig.dataDir, 'blueprints', 'deck-visual-plan-bp-cache.json')));
  const cachedSecond = await visualPlan.ensureVisualPlanBlueprint(cacheDeck, bpSlides, {
    config: llmConfig,
    fetchImpl: bpCachedFetch,
  });
  check('蓝图缓存命中不再调 LLM', cachedSecond === cachedFirst && bpFetchCount === 1);
  const cacheInvalidated = await visualPlan.ensureVisualPlanBlueprint(
    cacheDeck,
    [{ pageType: 'cover', role: 'cover', title: '改了标题' }],
    { config: llmConfig, fetchImpl: bpCachedFetch },
  );
  check('蓝图指纹随大纲变化失效重算', bpFetchCount === 2 && cacheInvalidated === cachedFirst);
}
