// 插件运行时测试：运行时三件 + pricing/models 先锋插件 + 插拔实证。
// 由 scripts/test-generation.mjs 汇总调用；ctx 由套件注入（只需要 check/expectThrows）。
export async function runPluginRuntimeTests(ctx) {
  const { check } = ctx;
  console.log('\n[20] 插件运行时（ctx/profile 三件 + pricing/models 先锋）');
  const { boot } = await import('../../src/lib/plugin/profile.ts');
  const { createCtx } = await import('../../src/lib/plugin/ctx.ts');
  const { defaultProfile } = await import('../../src/plugins/default-profile.ts');
  const { modelsPlugin } = await import('../../src/plugins/models/plugin.ts');

  const pluginCtx = await boot(defaultProfile);
  check('默认 profile boot 后 pricing/models 服务可用',
    pluginCtx.has('pricing') && pluginCtx.has('models')
      && pluginCtx.keys().join(',') === 'pricing,models');

  const pricing = pluginCtx.use('pricing');
  check('pricing.quote：整页生成 10🌟 / 改图 5🌟 / 可编辑导出 20🌟',
    pricing.quote('generate.page') === 10
      && pricing.quote('edit.page') === 5
      && pricing.quote('export.editable') === 20
      && pricing.quote('export.editable-text') === 5);
  check('pricing.quote：未定价动作返回 0 且不在价格表内（免费是合法形态）',
    pricing.quote('unknown.action') === 0 && !('unknown.action' in pricing.table()));
  check('pricing.table：只含已映射动作，outline 显式 0🌟也在表内',
    Object.keys(pricing.table()).length === 7
      && pricing.table().outline === 0 && pricing.table()['export.image'] === 0
      && pricing.table()['tool.ppt-to-base'] === 5);

  const models = pluginCtx.use('models');
  const { getGenerationConfig } = await import('../../src/lib/server/generation/config.ts');
  const liveConfig = getGenerationConfig();
  const textChain = models.text();
  check('models.text() 非空：主模型在链首、回退模型在链上',
    textChain.length >= 1 && textChain[0] === liveConfig.llmModel
      && liveConfig.llmFallbackModels.every((model) => textChain.includes(model)));
  check('models.image() 非空且去重（文生图/改图同模型只出现一次）',
    models.image().length === 1 && models.image()[0] === 'gpt-image-2');
  check('models.fallback 沿链推进，链尾与未知模型返回 null',
    models.fallback(textChain[0]) === (textChain[1] ?? null)
      && models.fallback(textChain[textChain.length - 1]) === null
      && models.fallback('不存在的模型') === null);

  // 插拔实证：同键替换 pricing 实现，消费函数原样复用
  const quoteGenerate = (c) => c.use('pricing').quote('generate.page');
  const fakePricingPlugin = {
    key: 'pricing-fake',
    version: '0.0.0-test',
    provides: ['pricing'],
    register(c) {
      c.register('pricing', { quote: () => 99, table: () => ({ 'generate.page': 99 }) });
    },
  };
  const altCtx = await boot({ name: 'alt-pricing', plugins: [fakePricingPlugin, modelsPlugin] });
  check('插拔实证：换价格 = 只换 profile，调用方代码不变、新价格生效',
    quoteGenerate(pluginCtx) === 10 && quoteGenerate(altCtx) === 99
      && altCtx.has('models'));

  const rawCtx = createCtx();
  rawCtx.register('pricing', { quote: () => 1 });
  let missMsg = '';
  try {
    rawCtx.use('nonexistent');
  } catch (error) {
    missMsg = error?.message || '';
  }
  check('use 未注册键启动期报错，信息含已注册键清单',
    missMsg.includes('nonexistent') && missMsg.includes('pricing'));
  let conflictMsg = '';
  try {
    rawCtx.register('pricing', { quote: () => 2 });
  } catch (error) {
    conflictMsg = error?.message || '';
  }
  check('重复注册同键报冲突错', conflictMsg.includes('冲突') && conflictMsg.includes('pricing'));
  let dupMsg = '';
  try {
    await boot({ name: 'dup', plugins: [modelsPlugin, modelsPlugin] });
  } catch (error) {
    dupMsg = error?.message || '';
  }
  check('boot 同一 profile 内插件键重复即报错', dupMsg.includes('重复') && dupMsg.includes('models'));
  rawCtx.reset();
  check('reset 清空注册表（测试用）', !rawCtx.has('pricing') && rawCtx.keys().length === 0);

  // ---- Phase 2：生产读价路径（credits.estimateCredits）走服务键 ----
  const { expectThrows } = ctx;
  const credits = await import('../../src/lib/server/credits.ts');
  const { getDefaultCtx } = await import('../../src/lib/plugin/default.ts');
  check('默认 ctx 懒同步启动且复用同一实例', getDefaultCtx() === getDefaultCtx() && getDefaultCtx().has('pricing'));
  const est = credits.estimateCredits({ action: 'deck_page_generate', pages: 3 });
  check('estimateCredits 经 ctx.pricing 读价：3 页 = 30🌟', est.credits === 30 && est.unitPrice === 10);
  const estRefine = credits.estimateCredits({ action: 'deck_page_refine', pages: 2 });
  check('estimateCredits 改图档经服务键：2 页 = 10🌟', estRefine.credits === 10);
  await expectThrows('未知计费动作仍被拒（语义不变）', async () =>
    credits.estimateCredits({ action: 'not_a_real_action' }), 'VALIDATION_ERROR');
  const { pricingPlugin } = await import('../../src/plugins/pricing/plugin.ts');
  const { bootSync } = await import('../../src/lib/plugin/profile.ts');
  let asyncMsg = '';
  try {
    bootSync({
      name: 'async-bad',
      plugins: [{ key: 'async-x', version: '0', provides: [], register: async () => {} }],
    });
  } catch (error) {
    asyncMsg = error?.message || '';
  }
  check('bootSync 遇异步 register 即 fail fast', asyncMsg.includes('异步') && asyncMsg.includes('async-x'));
  check('pricing 插件动作键与契约一致', pricingPlugin.pricing.join(',') === 'generate.page,edit.page,export.editable,export.editable-text,export.image,outline,tool.ppt-to-base');
}
