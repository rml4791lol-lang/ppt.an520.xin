// ppt_replicate 模块测试：复刻 PPT（结构参考 + 真设计）全链路，全 mock。
// 由 scripts/test-generation.mjs 汇总调用；ctx 由套件注入（fixture 与套件同生命周期）。
import { existsSync, readFileSync, utimesSync } from 'node:fs';

export async function runPptReplicateTests(ctx) {
  const {
    check, expectThrows, auth, credits, uid, llmConfig,
    singlePages, projects, makeMockFetcher, editsOkHandler, imageOkHandler, PNG_1X1_B64,
  } = ctx;
  console.log('\n[7c] 复刻 PPT（结构参考 + 真设计）');
  {
    const replicate = await import('../../src/modules/ppt-replicate/server/replicate.ts');
    const replicatePages = await import('../../src/modules/ppt-replicate/server/pages.ts');
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
    const { getDefaultCtx } = await import('../../src/lib/plugin/default.ts');
    const pricingSingleUnit = getDefaultCtx().use('pricing').quote('generate.single-page');
    check('单页单价与 pricing 插件同源（不另设第二条价格链）',
      credits.estimateCredits({ action: 'single_page_generate', pages: 1 }).unitPrice === pricingSingleUnit
        && credits.estimateCredits({ action: 'single_page_generate', pages: 3 }).credits === pricingSingleUnit * 3
        && credits.estimateCredits({ action: 'single_page_refine', pages: 1 }).unitPrice === pricingSingleUnit);
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
      replicatePages.generateReplicatePage(uid, {
        pageId: 'rp-traverse', content: '越权', imagePath: traversalPath,
      }, { fetchImpl: makeMockFetcher([editsOkHandler]), config: llmConfig }), 'FILE_FORBIDDEN');
    await expectThrows('复刻缺壳图校验失败', () =>
      replicatePages.generateReplicatePage(uid, { pageId: 'rpnopath', content: '新标题\n要点一' }, {
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
    const rp1 = await replicatePages.generateReplicatePage(uid, {
      pageId: 'rpok1', title: '新指标', content: '完成率 86%', imagePath: shell.relPath,
      colorMode: 'new-theme',
      requestId: 'rp-paid-run',
      structureProvided: true,
      structure: { family: 'metric', zones: '左侧大数字', slots: '1 个指标', hierarchy: '数字最大', forbidden: ['旧营收数字'] },
    }, { fetchImpl: okFetcher, config: llmConfig });
    const rpLedger = (await import('../../src/lib/server/db.ts')).getDb()
      .prepare('SELECT idempotency_key FROM credit_ledger WHERE user_id = ? AND idempotency_key = ?')
      .all(uid, 'single-page:rpok1:rp-paid-run');
    check('复刻生成接入单页计费运行：扣费键由模块产出（写入即可按同键找账）',
      rpLedger.length === 1, JSON.stringify(rpLedger));
    const editForm = okFetcher.calls.find((c) => c.url.includes('/images/edits'))?.init?.body;
    const rpPrompt = editForm instanceof FormData ? String(editForm.get('prompt') || '') : '';
    check('复刻走 edits 且扣 10🌟', rp1.status === 'succeeded' && beforeRp - rp1.balance === 10);
    check('生图不再抽 VLM，结构卡由计划回传',
      okFetcher.calls.every((c) => !c.url.includes('/chat/completions')));
    check('复刻 prompt 保画面、含结构卡、不走商务演示语境',
      rpPrompt.includes('保画面') && rpPrompt.includes('metric') && rpPrompt.includes('只换色板')
        && !rpPrompt.includes('全面重新设计') && !rpPrompt.includes('专业演示 PPT') && !rpPrompt.includes('结构草图'),
      rpPrompt.slice(0, 180));
    const visualPlanMod = await import('../../src/lib/server/generation/visual-plan.ts');
    const rpPage = singlePages.getOwnedPage(uid, 'rpok1');
    const expectedPlan = visualPlanMod.buildVisualPlan({
      slide: {
        pageIndex: rpPage.pageIndex,
        pageType: '',
        role: 'content',
        title: '新指标',
        goal: '',
        summary: ['完成率 86%'],
        structuredContent: '',
      },
      deckContext: { totalPages: 1, pageIndex: rpPage.pageIndex },
      stylePack: null,
      template: null,
      mode: 'replicate',
      replicate: {
        structure: {
          family: 'metric', zones: '左侧大数字', slots: '1 个指标', hierarchy: '数字最大', forbidden: ['旧营收数字'],
        },
        colorMode: 'new-theme',
      },
    });
    check('复刻逐页路径与视觉计划同源（上游提示词 = 计划产出）',
      rpPrompt === expectedPlan.prompt,
      `计划 ${expectedPlan.prompt.slice(0, 80)} / 上游 ${rpPrompt.slice(0, 80)}`);
    check('复刻计划：页型证据纳入壳页结构卡，且壳图是唯一底图（不取额外参考）',
      expectedPlan.pageTypeKey === 'big-number' && expectedPlan.references.length === 0
        && expectedPlan.primaryReference === null,
      `实际 ${expectedPlan.pageTypeKey} / refs=${expectedPlan.references.length}`);
    const rpListed = projects.listProjects(uid).items.find((item) => item.id === rp1.page.projectId);
    check('复刻项目在列表中标记 source=replicate', rpListed?.source === 'replicate');
    check('详情透出 source 与壳路径',
      singlePages.getSingleProjectDetail(uid, rp1.page.projectId).project.source === 'replicate'
        && singlePages.getOwnedPage(uid, 'rpok1').shellPath === shell.relPath);

    const batch = await import('../../src/modules/ppt-replicate/server/batch.ts');
    const rpBeforeRegenerate = credits.getBalance(uid);
    const oldVersionId = singlePages.getOwnedPage(uid, 'rpok1').activeVersionId;
    replicatePages.saveReplicateDraft(uid, {
      projectId: rp1.page.projectId,
      title: '批量重生成测试',
      pages: [{ pageId: 'rpok1', title: '新指标二版', content: '完成率改成 92%', imagePath: shell.relPath }],
    });
    const pendingRegenerate = singlePages.getOwnedPage(uid, 'rpok1');
    check('文案变更后服务端清空旧 active 版本',
      pendingRegenerate.status === 'idle' && pendingRegenerate.activeVersionId === '');
    await batch.startReplicateBatch(uid, {
      projectId: rp1.page.projectId,
      pageIds: ['rpok1'],
      colorMode: 'follow-shell',
    }, { fetchImpl: makeMockFetcher([editsOkHandler]), config: llmConfig });
    for (let i = 0; i < 100; i += 1) {
      const detail = batch.getSinglePageBatchDetail(uid, rp1.page.projectId);
      if (detail.batch && ['succeeded', 'partial', 'failed'].includes(detail.batch.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const regeneratedPage = singlePages.getOwnedPage(uid, 'rpok1');
    check('文案变更后批量任务不会误跳过旧成品',
      regeneratedPage.status === 'succeeded' && regeneratedPage.activeVersionId !== oldVersionId,
      `status=${regeneratedPage.status} old=${oldVersionId} new=${regeneratedPage.activeVersionId} batch=${JSON.stringify(batch.getSinglePageBatchDetail(uid, rp1.page.projectId).batch)}`);
    check('文案变更后的批量重生成按页扣费', rpBeforeRegenerate - credits.getBalance(uid) === 10,
      `before=${rpBeforeRegenerate} after=${credits.getBalance(uid)}`);

    replicatePages.saveReplicateDraft(uid, {
      projectId: rp1.page.projectId,
      title: '批量测试',
      pages: [
        { pageId: 'rp-batch-1', title: '批量一', content: '第一页文案', imagePath: shell.relPath },
        { pageId: 'rp-batch-2', title: '批量二', content: '第二页文案', imagePath: shell.relPath },
      ],
    });
    const batchBefore = credits.getBalance(uid);
    const started = await batch.startReplicateBatch(uid, {
      projectId: rp1.page.projectId,
      pageIds: ['rp-batch-1', 'rp-batch-2'],
      colorMode: 'follow-shell',
      structures: {
        'rp-batch-1': { family: 'cards', zones: '上方标题', slots: '两张卡', hierarchy: '标题最大', world: '保留底图', forbidden: [] },
      },
    }, { fetchImpl: makeMockFetcher([editsOkHandler]), config: llmConfig });
    let batchDetail = null;
    for (let i = 0; i < 100; i += 1) {
      batchDetail = batch.getSinglePageBatchDetail(uid, rp1.page.projectId);
      if (batchDetail.batch && ['succeeded', 'partial', 'failed'].includes(batchDetail.batch.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const batchPages = batchDetail?.pages.filter((page) => ['rp-batch-1', 'rp-batch-2'].includes(page.pageId)) || [];
    check('批量任务在服务端完成并回填全部图片',
      started.status === 'running'
        && batchDetail?.batch?.status === 'succeeded'
        && batchDetail.batch.succeeded === 2
        && batchPages.length === 2
        && batchPages.every((page) => page.status === 'succeeded' && page.imageUrl));
    check('批量任务按页扣费 10🌟', batchBefore - credits.getBalance(uid) === 20);
    const batchPageUpdatedAt = Math.max(...batchPages.map((page) => page.updatedAt));
    const batchListed = projects.listProjects(uid).items.find((item) => item.id === rp1.page.projectId);
    check('批量完成后项目更新时间跟随页面完成时间', batchListed && batchListed.updatedAt >= batchPageUpdatedAt);

    const staleProject = replicatePages.saveReplicateDraft(uid, {
      title: '批量中断恢复',
      pages: [{ pageId: 'rp-batch-stale', title: '中断页', content: '中断文案', imagePath: shell.relPath }],
    });
    const dbMod = await import('../../src/lib/server/generation/db.ts');
    const staleAt = Date.now() - llmConfig.jobStaleMs - 1000;
    dbMod.getGenDb().prepare(
      `INSERT INTO single_page_batches
        (id, user_id, project_id, status, total, succeeded, failed, error, target_ids, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, 'running', 1, 0, 0, '', ?, ?, ?, ?, 0)`,
    ).run('spb-stale-test', uid, staleProject.projectId, JSON.stringify(['rp-batch-stale']), staleAt, staleAt, staleAt);
    const staleDetail = batch.getSinglePageBatchDetail(uid, staleProject.projectId);
    check('运行中的批量任务超时后可释放并提示重试',
      staleDetail.batch?.status === 'failed'
        && staleDetail.batch.error.includes('中断')
        && staleDetail.batch.failed === 1);

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
    const rp2 = await replicatePages.generateReplicatePage(uid, {
      pageId: 'rpok2', title: '跟随色', content: '完成率 86%', imagePath: shell.relPath,
      colorMode: 'follow-shell',
    }, { fetchImpl: degradeFetcher, config: llmConfig });
    const followForm = degradeFetcher.calls.find((c) => c.url.includes('/images/edits'))?.init?.body;
    const followPrompt = followForm instanceof FormData ? String(followForm.get('prompt') || '') : '';
    check('结构卡失败仍能复刻成功', rp2.status === 'succeeded');
    check('follow-shell 指令跟随底图色板与媒介', followPrompt.includes('跟随底图的主辅色') && followPrompt.includes('保画面'));

    const skipVlm = makeMockFetcher([
      { match: '/chat/completions', payload: vlmPayload },
      editsOkHandler,
    ]);
    const rpHint = await replicatePages.generateReplicatePage(uid, {
      pageId: 'rpok3', title: '复用结构', content: '完成率 86%', imagePath: shell.relPath,
      structureProvided: true,
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
    const rpNull = await replicatePages.generateReplicatePage(uid, {
      pageId: 'rpok4', content: '完成率 86%', imagePath: shell.relPath,
      structureProvided: true, structure: null, colorMode: 'new-theme',
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

    const facade = await import('../../src/modules/ppt-replicate/server/facade.ts');
    const facadeDraft = facade.saveReplicateDraft(uid, {
      title: 'Facade 实体测试',
      pages: [{ pageId: 'rp-facade-1', title: '实体页', content: '实体测试要点', imagePath: shell.relPath }],
    });
    check('模块 facade 创建项目并返回项目/页数',
      Boolean(facadeDraft.projectId) && facadeDraft.pageCount === 1);
    const facadeDetail = facade.getReplicateProject(uid, facadeDraft.projectId);
    check('facade 查询项目详情带 source 与页',
      facadeDetail.project.source === 'replicate'
        && facadeDetail.pages.length === 1
        && facadeDetail.pages[0].pageId === 'rp-facade-1'
        && facadeDetail.pages[0].shellPath === shell.relPath);
    check('facade 读页返回文案与壳路径',
      facade.getReplicatePage(uid, 'rp-facade-1').content === '实体测试要点'
        && facade.listReplicatePages(uid, facadeDraft.projectId).length === 1
        && facade.listReplicatePageStatuses(uid, facadeDraft.projectId)[0].status === 'idle');
    facade.saveReplicateDraft(uid, {
      projectId: facadeDraft.projectId,
      pages: [{ pageId: 'rp-facade-1', title: '实体页', content: '改写后的要点', imagePath: shell.relPath }],
    });
    check('facade 保存草稿可写回页文案',
      facade.getReplicatePage(uid, 'rp-facade-1').content === '改写后的要点');
    const facadeDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
    const facadeTs = Date.now();
    facadeDb.prepare(
      `INSERT INTO single_page_versions
        (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at)
       VALUES (?, ?, 'generate', '', 'succeeded', '', '/api/files/generated/facade.png', '', '', '', ?, ?)`,
    ).run('ver-facade-1', 'rp-facade-1', facadeTs, facadeTs);
    check('facade 读版本列表', facade.listReplicatePageVersions(uid, 'rp-facade-1').length === 1);
    await expectThrows('facade 版本查询拒绝越权 pageId', () =>
      facade.listReplicatePageVersions('victim_user', 'rp-facade-1'), 'PAGE_NOT_FOUND');
    const facadeSelected = facade.selectReplicatePageVersion(uid, 'rp-facade-1', 'ver-facade-1');
    check('facade 写版本：切换 activeVersion 且平台详情可见',
      facadeSelected.activeVersionId === 'ver-facade-1'
        && facadeSelected.status === 'succeeded'
        && singlePages.getSingleProjectDetail(uid, facadeDraft.projectId).pages[0].activeVersionId === 'ver-facade-1');
    check('facade 创建的项目在平台列表标记 source=replicate',
      projects.listProjects(uid).items.find((item) => item.id === facadeDraft.projectId)?.source === 'replicate');
    const facadeQuote = facade.quoteReplicateCredits(facade.REPLICATE_BILLING_ACTIONS.pageGenerate, 3);
    const platformQuote = credits.estimateCredits({ action: 'single_page_generate', pages: 3 });
    check('facade 计费动作声明与平台估价一致',
      facade.REPLICATE_BILLING_ACTIONS.pageGenerate === 'single_page_generate'
        && facade.REPLICATE_BILLING_ACTIONS.pageRefine === 'single_page_refine'
        && facade.REPLICATE_BILLING_ACTIONS.editableExport === 'export_editable'
        && facadeQuote.unitPrice === platformQuote.unitPrice
        && facadeQuote.credits === platformQuote.credits);
    check('facade 懒恢复入口委托平台（无中断时不改状态）',
      facade.reconcileReplicateUser(uid) === false
        && facade.getReplicatePage(uid, 'rp-facade-1').status === 'succeeded');
    check('facade 暴露复刻提示词契约',
      facade.resolveReplicateColorMode('new-theme') === 'new-theme'
        && facade.parseIncomingStructure({ family: 'cards' })?.family === 'cards'
        && typeof facade.buildReplicateCopyPrompt === 'function'
        && typeof facade.buildReplicateInstruction === 'function');
    const singlePagesSrc = readFileSync(
      new URL('../../src/lib/server/generation/single-pages.ts', import.meta.url),
      'utf8',
    );
    const replicatePagesSrc = readFileSync(
      new URL('../../src/modules/ppt-replicate/server/pages.ts', import.meta.url),
      'utf8',
    );
    check('复刻实体已搬回模块：平台单页运行时不再 import 模块',
      !singlePagesSrc.includes('@/modules/')
        && !singlePagesSrc.includes('buildReplicateCopyPrompt')
        && replicatePagesSrc.includes("from '@/lib/server/generation/single-pages'"));

    const rpShell = await storage.saveFile('uploads', uid, Buffer.from(PNG_1X1_B64, 'base64'), { kind: 'replicate', ext: '.png' }, llmConfig);
    const rpPurge = await replicatePages.generateReplicatePage(uid, {
      pageId: 'rp-purge', content: '过期清理', imagePath: rpShell.relPath,
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
