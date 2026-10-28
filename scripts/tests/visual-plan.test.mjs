// [4j] 视觉计划（src/lib/server/generation/visual-plan.ts）契约：
// 页型只解析一次（pageType + title + goal + role），模板映射与提示词读同一键；
// 参考优先级 anchor > template > style 且任何分支不丢候选；改图后缀归模块；
// 蓝图失败在接口内降级为空串。由 scripts/test-generation.mjs 汇总调用。
export async function runVisualPlanTests(ctx) {
  const { check, llmConfig } = ctx;
  console.log('\n[4j] 视觉计划：页型单源 / 参考优先级 / 改图后缀 / 蓝图降级');

  const visualPlan = await import('../../src/lib/server/generation/visual-plan.ts');
  const mapping = await import('../../src/lib/server/generation/mapping.ts');
  const pageTypes = await import('../../src/lib/server/generation/page-types.ts');
  const stylePacks = await import('../../src/lib/server/generation/style-packs.ts');

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
}
