// ppt_replicate 模块测试：复刻 PPT（结构参考 + 真设计）全链路，全 mock。
// 由 scripts/test-generation.mjs 汇总调用；ctx 由套件注入（fixture 与套件同生命周期）。
import { existsSync, utimesSync } from 'node:fs';

export async function runPptReplicateTests(ctx) {
  const {
    check, expectThrows, auth, credits, uid, llmConfig,
    singlePages, projects, makeMockFetcher, editsOkHandler, imageOkHandler, PNG_1X1_B64,
  } = ctx;
  console.log('\n[7c] 复刻 PPT（结构参考 + 真设计）');
  {
    const replicate = await import('../../src/modules/ppt-replicate/server/replicate.ts');
    const storage = await import('../../src/lib/server/generation/storage.ts');
    const urls = await import('../../src/modules/ppt-replicate/client/replicate-urls.ts');
    check('复刻预览 URL 只允许 /api/files/ 与 data:image',
      urls.safeReplicateFileUrl('/api/files/generated/a.png') === '/api/files/generated/a.png'
        && urls.safeReplicateFileUrl('/api/files/../etc') === ''
        && urls.safeReplicateFileUrl('https://evil.example/x.png') === ''
        && urls.safeReplicateShellSrc('data:image/png;base64,abc') === 'data:image/png;base64,abc'
        && urls.safeReplicateShellSrc('javascript:alert(1)') === '');
    check('美化页路径只接受干净 projectId',
      urls.beautifyHref('abc') === '/beautify?projectId=abc'
        && urls.beautifyHref('') === '/beautify'
        && urls.beautifyHref('../x') === '/beautify'
        && urls.beautifyHref('a&b') === '/beautify');
    const pagesLogic = await import('../../src/modules/ppt-replicate/client/beautify-pages.ts');
    const samplePages = [
      pagesLogic.emptyBeautifyPage('a', { copy: '封面', imageUrl: '/api/files/generated/a.png' }),
      pagesLogic.emptyBeautifyPage('b', { copy: '流程' }),
      pagesLogic.emptyBeautifyPage('c', { copy: '' }),
    ];
    check('已生成页不进待扣费名单，空文案也不扣',
      pagesLogic.indexesNeedingGenerate(samplePages).join(',') === '1'
        && pagesLogic.remainingGenerateCredits(samplePages, 10) === 10
        && pagesLogic.remainingEditableCredits(samplePages, 20) === 20);
    check('单价由入参决定（客户端不再硬编码 10/20）',
      pagesLogic.remainingGenerateCredits(samplePages, 12) === 12
        && pagesLogic.remainingEditableCredits(samplePages, 25) === 25);
    check('单页单价走 /api/credits/estimate 同一份配置',
      credits.estimateCredits({ action: 'single_page_generate', pages: 1 }).unitPrice === llmConfig.singlePageCredits
        && credits.estimateCredits({ action: 'single_page_generate', pages: 3 }).credits === llmConfig.singlePageCredits * 3
        && credits.estimateCredits({ action: 'single_page_refine', pages: 1 }).unitPrice === llmConfig.singlePageCredits);
    check('星星不足横幅不被成功文案盖掉',
      pagesLogic.buildGenerateFinishBanner({
        newlyOk: 2, failed: 0, skippedDone: 0, stoppedForCredits: true, creditsMessage: '星星不足',
      })?.kind === 'err'
        && pagesLogic.buildGenerateFinishBanner({
          newlyOk: 2, failed: 0, skippedDone: 0, stoppedForCredits: true, creditsMessage: '星星不足',
        })?.text.includes('仍保留'));
    check('已全部生成时提示走重试而不是再扣星',
      pagesLogic.buildGenerateFinishBanner({
        newlyOk: 0, failed: 0, skippedDone: 3, stoppedForCredits: false,
      })?.text.includes('不会再扣星'));
    const plannedPages = pagesLogic.applyPlanToPages(
      [pagesLogic.emptyBeautifyPage('p0'), pagesLogic.emptyBeautifyPage('p1')],
      [{ title: '岗前', content: '要点', source: 'outline' }, { title: '', content: '', source: 'skip' }],
      [{ family: 'cover' }, null],
    );
    check('计划回写保留结构卡并标记已读',
      plannedPages[0].copy.includes('岗前') && plannedPages[0].structureReady && plannedPages[0].source === 'outline'
        && plannedPages[1].status === '跳过' && plannedPages[1].structureReady);
    const plannedWithImage = pagesLogic.applyPlanToPages(
      [pagesLogic.emptyBeautifyPage('p0', { copy: '旧封面', imageUrl: '/api/files/generated/old.png' })],
      [{ title: '新封面', content: '新要点', source: 'outline' }],
      [null],
    );
    const plannedSameCopy = pagesLogic.applyPlanToPages(
      [pagesLogic.emptyBeautifyPage('p0', { copy: '岗前\n要点', imageUrl: '/api/files/generated/old.png' })],
      [{ title: '岗前', content: '要点', source: 'outline' }],
      [null],
    );
    check('文案变更后清成品图，避免整批跳过旧画面',
      plannedWithImage[0].imageUrl === '' && plannedWithImage[0].status.includes('需重新生成'));
    check('文案不变则保留成品图', plannedSameCopy[0].imageUrl === '/api/files/generated/old.png');
    check('美化 requestId 每次不同，刷新重试不会撞幂等键',
      pagesLogic.newBeautifyRequestId('p0') !== pagesLogic.newBeautifyRequestId('p0')
        && pagesLogic.newBeautifyRequestId('p0', 'tw').includes('-tw-'));
    check('脏草稿被丢掉，合法草稿配色回落到 follow-shell',
      pagesLogic.parseBeautifyDraft('not-json') === null
        && pagesLogic.parseBeautifyDraft('{"topic":"培训","colorMode":"nope"}')?.colorMode === 'follow-shell'
        && pagesLogic.parseBeautifyDraft('{"topic":"培训","copyMode":"strict"}')?.copyMode === 'strict');
    check('打开旧项目提示结构要重读、已生成不重复扣星',
      pagesLogic.restoreProjectHint([{ imagePath: 'uploads/u/a.png', imageUrl: '/api/files/generated/x.png' }]).includes('不会重复扣星')
        && pagesLogic.restoreProjectHint([{ imagePath: '', imageUrl: '' }]).includes('参考稿已过期'));
    check('导出后续批次失败仍交代已排队批次',
      pagesLogic.buildExportFinishBanner({ queued: 1, error: '网络中断' }).kind === 'warn'
        && pagesLogic.buildExportFinishBanner({ queued: 1, error: '网络中断' }).text.includes('下载中心'));
    credits.refundCredits(uid, 80, { reason: '测试补贴', idempotencyKey: 'test-topup-7c' });

    const card = replicate.parseStructureCard('```json\n{"family":"cards","zones":"顶栏标题，下方三卡","slots":"3 张卡","hierarchy":"标题最大","world":"水彩森林里的七步路径","forbidden":["旧 Logo"]}\n```');
    check('结构卡解析围栏 JSON', Boolean(card?.family === 'cards' && card.slots.includes('3') && card.forbidden.includes('旧 Logo')));
    check('结构卡解析画面世界', Boolean(card?.world?.includes('水彩森林')));
    check('结构卡垃圾输入为空', replicate.parseStructureCard('不是 JSON') === null);
    check('配色默认 follow-shell，显式 new-theme',
      replicate.resolveReplicateColorMode('nope') === 'follow-shell'
        && replicate.resolveReplicateColorMode('new-theme') === 'new-theme');
    check('结构卡对象可解析', replicate.parseIncomingStructure({
      family: 'cards', zones: '三卡', slots: '3', world: '水彩',
    })?.family === 'cards');
    check('视觉抽取预算按窗口剩余与单次上限封顶',
      replicate.budgetReplicateExtracts(100, 48) === replicate.REPLICATE_VLM_PER_PLAN
        && replicate.budgetReplicateExtracts(10, 3) === 3
        && replicate.budgetReplicateExtracts(10, 0) === 0);
    const newTheme = replicate.buildReplicateInstruction({ structure: card, colorMode: 'new-theme' });
    const follow = replicate.buildReplicateInstruction({ structure: card, colorMode: 'follow-shell' });
    check('复刻指令保画面且两种配色分叉',
      newTheme.includes('保画面') && newTheme.includes('只换色板') && !newTheme.includes('跟随底图的主辅色')
        && !newTheme.includes('结构草图') && follow.includes('跟随底图的主辅色') && follow.includes('水彩森林')
        && follow.includes('3 张卡'));

    check('读盘路径拒绝 .. 穿越到他人目录', storage.absPathForRelPath(`uploads/${uid}/../victim_user/shell/x.png`, llmConfig) === null);
    check('读盘路径拒绝编码后的 ..', storage.absPathForRelPath(`uploads/${uid}/%2e%2e/victim_user/shell/x.png`, llmConfig) === null);
    const shell = await storage.saveFile('uploads', uid, Buffer.from(PNG_1X1_B64, 'base64'), { kind: 'shell', ext: '.png' }, llmConfig);
    check('归属校验接受自己的上传路径', storage.parseOwnedUploadRelPath(uid, shell.relPath) === shell.relPath);
    const victimShell = await storage.saveFile('uploads', 'victim_user', Buffer.from(PNG_1X1_B64, 'base64'), { kind: 'shell', ext: '.png' }, llmConfig);
    const traversalPath = `uploads/${uid}/../${victimShell.relPath.slice('uploads/'.length)}`;
    const alignedPaths = replicate.ownedReplicateImagePaths(
      JSON.stringify(['', shell.relPath, `/api/files/${victimShell.relPath}`]),
      uid,
      3,
    );
    check('壳图路径定长按页对齐（缺失留空、越权作废）',
      alignedPaths.length === 3 && alignedPaths[0] === '' && alignedPaths[1] === shell.relPath && alignedPaths[2] === '');
    const gapFetcher = makeMockFetcher([{
      match: '/chat/completions',
      payload: { choices: [{ message: { content: '{"family":"cards","zones":"三卡","slots":"3 张卡","world":"水彩","forbidden":[]}' } }] },
    }]);
    const gapExtract = await replicate.extractReplicatePageHints(
      [Buffer.alloc(0), Buffer.from(PNG_1X1_B64, 'base64')],
      { fetchImpl: gapFetcher, config: llmConfig },
      { maxCount: 1 },
    );
    check('缺失壳图不吃抽取名额，结构卡按页对齐',
      gapExtract.extracted === 1 && gapExtract.cards[0] === null && Boolean(gapExtract.cards[1])
        && gapFetcher.calls.length === 1);
    check('归属校验拒绝 .. 穿越', storage.parseOwnedUploadRelPath(uid, traversalPath) === null);
    await expectThrows('复刻 imagePath 带 .. 返回 403', () =>
      singlePages.generateSinglePage(uid, {
        pageId: 'rp-traverse', content: '越权', imagePath: traversalPath, mode: 'replicate',
      }, { fetchImpl: makeMockFetcher([editsOkHandler]), config: llmConfig }), 'FILE_FORBIDDEN');
    await expectThrows('复刻缺壳图校验失败', () =>
      singlePages.generateSinglePage(uid, { pageId: 'rpnopath', content: '新标题\n要点一', mode: 'replicate' }, {
        fetchImpl: makeMockFetcher([editsOkHandler]),
        config: llmConfig,
      }), 'VALIDATION_ERROR');

    const vlmPayload = {
      choices: [{ message: { content: JSON.stringify({
        family: 'metric', zones: '左侧大数字', slots: '1 个指标', hierarchy: '数字最大', forbidden: ['旧营收数字'],
      }) } }],
    };
    const okFetcher = makeMockFetcher([
      { match: '/chat/completions', payload: vlmPayload },
      editsOkHandler,
    ]);
    const beforeRp = credits.getBalance(uid);
    const rp1 = await singlePages.generateSinglePage(uid, {
      pageId: 'rpok1', title: '新指标', content: '完成率 86%', imagePath: shell.relPath,
      mode: 'replicate', colorMode: 'new-theme',
      structureProvided: true,
      structure: { family: 'metric', zones: '左侧大数字', slots: '1 个指标', hierarchy: '数字最大', forbidden: ['旧营收数字'] },
    }, { fetchImpl: okFetcher, config: llmConfig });
    const editForm = okFetcher.calls.find((c) => c.url.includes('/images/edits'))?.init?.body;
    const rpPrompt = editForm instanceof FormData ? String(editForm.get('prompt') || '') : '';
    check('复刻走 edits 且扣 10🌟', rp1.status === 'succeeded' && beforeRp - rp1.balance === 10);
    check('生图不再抽 VLM，结构卡由计划回传',
      okFetcher.calls.every((c) => !c.url.includes('/chat/completions')));
    check('复刻 prompt 保画面、含结构卡、不走商务演示语境',
      rpPrompt.includes('保画面') && rpPrompt.includes('metric') && rpPrompt.includes('只换色板')
        && !rpPrompt.includes('全面重新设计') && !rpPrompt.includes('专业演示 PPT') && !rpPrompt.includes('结构草图'),
      rpPrompt.slice(0, 180));
    const rpListed = projects.listProjects(uid).items.find((item) => item.id === rp1.page.projectId);
    check('复刻项目在列表中标记 source=replicate', rpListed?.source === 'replicate');
    check('详情透出 source 与壳路径',
      singlePages.getSingleProjectDetail(uid, rp1.page.projectId).project.source === 'replicate'
        && singlePages.getOwnedPage(uid, 'rpok1').shellPath === shell.relPath);
    let mixErr = null;
    try {
      await singlePages.generateSinglePage(uid, {
        pageId: 'rp-mix', projectId: rp1.page.projectId, content: '冲掉画面',
      }, { fetchImpl: makeMockFetcher([imageOkHandler]), config: llmConfig });
    } catch (error) {
      mixErr = error;
    }
    check('工作台单页生成不能写入复刻项目', mixErr?.code === 'REPLICATE_PROJECT');
    check('工作台 409 指向 PPT 美化', String(mixErr?.message || '').includes('PPT 美化'));
    await expectThrows('开关外用户不能改美化页', () =>
      singlePages.refineSinglePage(uid, { pageId: 'rpok1', editInstruction: '只改标题字号' }, {
        fetchImpl: makeMockFetcher([editsOkHandler]),
        config: llmConfig,
      }), 'NOT_FOUND');

    const degradeFetcher = makeMockFetcher([
      { match: '/chat/completions', payload: () => { throw new Error('vlm down'); } },
      editsOkHandler,
    ]);
    const rp2 = await singlePages.generateSinglePage(uid, {
      pageId: 'rpok2', title: '跟随色', content: '完成率 86%', imagePath: shell.relPath,
      mode: 'replicate', colorMode: 'follow-shell',
    }, { fetchImpl: degradeFetcher, config: llmConfig });
    const followForm = degradeFetcher.calls.find((c) => c.url.includes('/images/edits'))?.init?.body;
    const followPrompt = followForm instanceof FormData ? String(followForm.get('prompt') || '') : '';
    check('结构卡失败仍能复刻成功', rp2.status === 'succeeded');
    check('follow-shell 指令跟随底图色板与媒介', followPrompt.includes('跟随底图的主辅色') && followPrompt.includes('保画面'));

    const skipVlm = makeMockFetcher([
      { match: '/chat/completions', payload: vlmPayload },
      editsOkHandler,
    ]);
    const rpHint = await singlePages.generateSinglePage(uid, {
      pageId: 'rpok3', title: '复用结构', content: '完成率 86%', imagePath: shell.relPath,
      mode: 'replicate', structureProvided: true,
      structure: { family: 'cards', zones: '三卡', slots: '3 张卡', world: '水彩森林', forbidden: [] },
    }, { fetchImpl: skipVlm, config: llmConfig });
    const hintForm = skipVlm.calls.find((c) => c.url.includes('/images/edits'))?.init?.body;
    const hintPrompt = hintForm instanceof FormData ? String(hintForm.get('prompt') || '') : '';
    check('客户端结构卡跳过 VLM 且默认跟随底图色',
      rpHint.status === 'succeeded'
        && skipVlm.calls.every((c) => !c.url.includes('/chat/completions'))
        && hintPrompt.includes('3 张卡')
        && hintPrompt.includes('跟随底图的主辅色'));
    const skipNull = makeMockFetcher([
      { match: '/chat/completions', payload: vlmPayload },
      editsOkHandler,
    ]);
    const rpNull = await singlePages.generateSinglePage(uid, {
      pageId: 'rpok4', content: '完成率 86%', imagePath: shell.relPath,
      mode: 'replicate', structureProvided: true, structure: null, colorMode: 'new-theme',
    }, { fetchImpl: skipNull, config: llmConfig });
    check('显式空结构卡跳过 VLM 仍保画面',
      rpNull.status === 'succeeded'
        && skipNull.calls.every((c) => !c.url.includes('/chat/completions')));
    const extractFetcher = makeMockFetcher([{ match: '/chat/completions', payload: vlmPayload }]);
    const extracted = await replicate.extractReplicatePageHints(
      [Buffer.from(PNG_1X1_B64, 'base64'), Buffer.from(PNG_1X1_B64, 'base64'), Buffer.from(PNG_1X1_B64, 'base64')],
      { fetchImpl: extractFetcher, config: llmConfig },
      { maxCount: 1 },
    );
    check('结构抽取尊重单次上限',
      extracted.extracted === 1
        && extractFetcher.calls.filter((c) => c.url.includes('/chat/completions')).length === 1
        && extracted.cards.length === 3
        && extracted.cards[1] === null);
    const deadFetcher = makeMockFetcher([{ match: '/chat/completions', payload: vlmPayload }]);
    const dead = await replicate.extractReplicatePageHints(
      [Buffer.from(PNG_1X1_B64, 'base64')],
      { fetchImpl: deadFetcher, config: llmConfig },
      { deadlineAt: Date.now() - 1 },
    );
    check('结构抽取超过截止时间则降级为空卡',
      dead.extracted === 0 && deadFetcher.calls.length === 0);
    const vlmDownFetcher = makeMockFetcher([{ match: '/chat/completions', payload: () => { throw new Error('vlm down'); } }]);
    const degraded = await replicate.extractReplicatePageHints(
      [Buffer.from(PNG_1X1_B64, 'base64')],
      { fetchImpl: vlmDownFetcher, config: llmConfig },
    );
    check('VLM 失败不算已读到结构（structureExtracted 不虚报）',
      degraded.extracted === 0 && degraded.cards[0] === null && degraded.text.includes('结构未知'));

    const planRaw = JSON.stringify({
      slides: [
        { title: '开场', content: '妇科门诊培训目标\n掌握问诊流程', source: 'material' },
      ],
    });
    const planned = replicate.parseReplicatePlan(planRaw, 3, '妇科门诊培训', 'topic');
    check('文案计划补足到壳页数且缺页按主题补',
      planned?.length === 3 && planned[0].source === 'material' && planned[1].source === 'topic'
        && planned[1].title.includes('妇科门诊培训') && !planned[1].content.includes('材料未覆盖'));
    const skipped = replicate.parseReplicatePlan(planRaw, 2, '妇科门诊培训', 'skip');
    check('缺页 skip 策略留空', skipped?.[1].source === 'skip' && skipped[1].content === '');
    const planFetcher = makeMockFetcher([{
      match: '/chat/completions',
      payload: { choices: [{ message: { content: planRaw } }] },
    }]);
    const auto = await replicate.planReplicateCopy(
      { topic: '妇科门诊培训', sourceText: '掌握问诊与隐私保护', pageCount: 3, gapPolicy: 'topic' },
      { fetchImpl: planFetcher, config: llmConfig },
    );
    check('按主题拆文案返回与页数一致', auto.length === 3 && auto[0].title === '开场');
    check('copyMode 默认完善、显式 strict',
      replicate.resolveReplicateCopyMode('nope') === 'improve'
        && replicate.resolveReplicateCopyMode('strict') === 'strict');
    const improveMsg = replicate.buildCopyPlanUserMessage({
      topic: '妇科门诊培训',
      sourceText: '掌握问诊',
      outlineText: '1 封面\n2 接诊流程\n3 考核',
      pageCount: 10,
      gapPolicy: 'topic',
      copyMode: 'improve',
    });
    check('有大纲时提示词含大纲并允许完善创新',
      improveMsg.includes('1 封面') && improveMsg.includes('接诊流程') && improveMsg.includes('完善'));
    const hintText = replicate.formatReplicatePageHints([card, null]);
    const hintedMsg = replicate.buildCopyPlanUserMessage({
      topic: '妇科门诊培训',
      sourceText: '掌握问诊',
      outlineText: '',
      pageCount: 2,
      gapPolicy: 'topic',
      copyMode: 'improve',
      pageHints: hintText,
    });
    check('壳页结构写入拆文案提示词',
      hintText.includes('水彩森林') && hintText.includes('第2页') && hintedMsg.includes('壳页结构') && hintedMsg.includes('3 张卡'));
    const strictMsg = replicate.buildCopyPlanUserMessage({
      topic: '妇科门诊培训',
      sourceText: '掌握问诊',
      outlineText: '',
      pageCount: 3,
      gapPolicy: 'topic',
      copyMode: 'strict',
    });
    check('strict 模式强调少发挥', strictMsg.includes('严格') && !strictMsg.includes('可以改写'));
    const outlineParsed = replicate.parseReplicatePlan(
      JSON.stringify({ slides: [{ title: '接诊', content: '核对身份', source: 'outline' }] }),
      1,
      '妇科门诊培训',
      'topic',
    );
    check('大纲来源可解析', outlineParsed?.[0].source === 'outline' && outlineParsed[0].title === '接诊');
    const outlineFetcher = makeMockFetcher([{
      match: '/chat/completions',
      payload: { choices: [{ message: { content: planRaw } }] },
    }]);
    const fromOutline = await replicate.planReplicateCopy(
      { topic: '', outlineText: '妇科门诊护士岗前培训\n接诊流程', pageCount: 3, gapPolicy: 'topic' },
      { fetchImpl: outlineFetcher, config: llmConfig },
    );
    check('无主题有大纲仍能拆文案', fromOutline.length === 3 && fromOutline[0].title === '开场');
    const outlineCall = outlineFetcher.calls.find((c) => String(c.url).includes('/chat/completions'));
    const outlineBody = JSON.parse(outlineCall?.init?.body || '{}');
    const outlinePrompt = String(outlineBody?.messages?.[0]?.content || '');
    check('无主题时用大纲首行充当主题写入提示词', outlinePrompt.includes('妇科门诊护士岗前培训'));
    await expectThrows('拆文案缺主题被拒', () =>
      replicate.planReplicateCopy({ topic: '', pageCount: 2 }, { fetchImpl: planFetcher, config: llmConfig }),
      'VALIDATION_ERROR');
    const rateLimitMod = await import('../../src/lib/server/rate-limit.ts');
    const planUser = await auth.registerWithPassword(
      { account: 'rpplan01', password: 'password123', confirmPassword: 'password123' },
      '127.0.1.9',
    );
    const planUid = planUser.user.id;
    for (let i = 0; i < 30; i += 1) {
      rateLimitMod.hitRateLimit(`llm-free:${planUid}`, { windowMs: 10 * 60 * 1000, max: 30 });
    }
    const isoFetcher = makeMockFetcher([{
      match: '/chat/completions',
      payload: { choices: [{ message: { content: planRaw } }] },
    }]);
    const isolated = await replicate.runReplicatePlan(
      planUid,
      { topic: '妇科门诊培训', pageCount: 1 },
      { fetchImpl: isoFetcher, config: llmConfig },
    );
    check('拆文案不占用大纲 llm-free 桶', isolated.slides.length === 1);
    for (let i = 0; i < 29; i += 1) {
      rateLimitMod.hitRateLimit(replicate.replicatePlanRateKey(planUid), {
        windowMs: replicate.REPLICATE_PLAN_WINDOW_MS,
        max: replicate.REPLICATE_PLAN_WINDOW_MAX,
      });
    }
    await expectThrows('复刻拆文案第 31 次 429', () =>
      replicate.runReplicatePlan(
        planUid,
        { topic: '妇科门诊培训', pageCount: 1 },
        { fetchImpl: isoFetcher, config: llmConfig },
      ),
      'LLM_RATE_LIMITED');
    check('页数上限与整套解析对齐', replicate.REPLICATE_MAX_PAGES === 40);
    await expectThrows('拆文案超过 40 页被拒', () =>
      replicate.planReplicateCopy({ topic: '妇科门诊培训', pageCount: 41 }, { fetchImpl: planFetcher, config: llmConfig }),
      'VALIDATION_ERROR');

    const rpShell = await storage.saveFile('uploads', uid, Buffer.from(PNG_1X1_B64, 'base64'), { kind: 'replicate', ext: '.png' }, llmConfig);
    const rpPurge = await singlePages.generateSinglePage(uid, {
      pageId: 'rp-purge', content: '过期清理', imagePath: rpShell.relPath, mode: 'replicate',
    }, { fetchImpl: makeMockFetcher([editsOkHandler]), config: llmConfig });
    projects.deleteProject(uid, rpPurge.page.projectId);
    const genDbMod = await import('../../src/lib/server/generation/db.ts');
    genDbMod.getGenDb().prepare('UPDATE single_page_projects SET deleted_at = ? WHERE id = ?').run(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      rpPurge.page.projectId,
    );
    projects.listProjects(uid);
    check('过期复刻项目清理删除壳图', !existsSync(rpShell.absPath));

    const orphan = await storage.saveFile('uploads', uid, Buffer.from(PNG_1X1_B64, 'base64'), { kind: 'replicate', ext: '.png' }, llmConfig);
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(orphan.absPath, past, past);
    const removed = await storage.purgeExpiredKindUploads(uid, 'replicate', [], Date.now() - 7 * 24 * 60 * 60 * 1000, llmConfig);
    check('未引用的过期复刻壳图被清', removed >= 1 && !existsSync(orphan.absPath));
  }

}
