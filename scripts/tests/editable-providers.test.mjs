// 上游通道接口（Provider）测试：能力声明 / registry 回退顺序与页数过滤 / 假通道驱动管线与恢复。
// 全部 mock，禁止真实调用 WPS / Image2PPT / Codia。
export async function runEditableProviderTests(ctx) {
  const {
    check, baseConfig, credits, uid, deck,
  } = ctx;
  const providersLib = await import('../../src/modules/editable-export/server/providers/index.ts');
  const exportsLib = await import('../../src/modules/editable-export/server/editable.ts');
  const { getGenDb } = await import('../../src/lib/server/generation/db.ts');
  const { ApiError } = await import('../../src/lib/server/http.ts');

  console.log('\n[6h] 上游通道接口（provider 能力 / registry / 假通道）');

  // ---- 能力声明：maxPages 与可恢复旗 ----
  {
    const caps = providersLib.EDITABLE_PROVIDERS
      .map((provider) => `${provider.id}:${provider.capabilities.maxPages}:${provider.capabilities.resumable ? 'resumable' : 'one-shot'}`);
    check('能力声明：WPS/Image2PPT 50 页、Codia 20 页，只有 WPS 不可恢复',
      caps.join(' | ') === 'wps:50:one-shot | image2ppt:50:resumable | codia:20:resumable', caps.join(' | '));
  }

  // ---- registry：回退顺序、配置过滤、页数过滤 ----
  {
    const allConfig = {
      ...baseConfig,
      codiaApiKey: 'sk-codia-test',
      image2pptApiKey: 'i2p-key',
      wpsAipptCookie: 'wps_sid=test',
      editableProvider: 'auto',
    };
    const ids = (config, pages) => providersLib.resolveEditableProviders(config, pages).map((provider) => provider.id).join('/');
    check('回退顺序：auto 模式 = WPS → Image2PPT → Codia',
      ids({ ...allConfig, editableProvider: 'auto' }, 2) === 'wps/image2ppt/codia');
    check('回退顺序：codia 主通道排最前', ids({ ...allConfig, editableProvider: 'codia' }, 2) === 'codia/image2ppt/wps');
    check('回退顺序：image2ppt 主通道排最前', ids({ ...allConfig, editableProvider: 'image2ppt' }, 2) === 'image2ppt/wps/codia');
    check('配置过滤：未配置的通道不进入回退顺序',
      ids({ ...baseConfig, codiaApiKey: 'sk-codia-test', image2pptApiKey: '', wpsAipptCookie: '' }, 2) === 'codia');
    check('页数过滤：20 页边界仍保留 Codia', ids(allConfig, 20) === 'wps/image2ppt/codia');
    check('页数过滤：21 页剔除 Codia（上限 20）', ids(allConfig, 21) === 'wps/image2ppt');
    check('页数过滤：51 页两个 50 页通道也被剔除', ids(allConfig, 51) === '');
    check('registry 与旧配置口径一致：configuredEditableProviders 仍是 id 顺序',
      exportsLib.configuredEditableProviders({ ...allConfig, editableProvider: 'image2ppt' }).join('/') === 'image2ppt/wps/codia');
  }

  // ---- 可编辑上限 = 已配置通道链的能力上限（Codia 的 20 不再是全局常量）----
  {
    const capacity = (config) => providersLib.editablePageCapacity(config);
    const unconfigured = { ...baseConfig, codiaApiKey: '', image2pptApiKey: '', wpsAipptCookie: '' };
    check('能力上限：没有已配置通道 = 0',
      capacity(unconfigured) === 0, String(capacity(unconfigured)));
    check('能力上限：只配置 Codia = 20',
      capacity({ ...unconfigured, codiaApiKey: 'sk-codia-test' }) === 20);
    check('能力上限：配置 Image2PPT 时 = 50（不被 Codia 的 20 拉低）',
      capacity({ ...unconfigured, codiaApiKey: 'sk-codia-test', image2pptApiKey: 'i2p-key' }) === 50);
    check('能力上限：配置 WPS 时 = 50',
      capacity({ ...unconfigured, wpsAipptCookie: 'wps_sid=test' }) === 50);
  }

  // ---- 夹具：N 页 deck（页图可取指定文件）+ 不触网的同步假通道 ----
  const decksLib = await import('../../src/lib/server/generation/decks.ts');
  const db = getGenDb();
  const sourceImagePath = (deckId) => {
    const row = db
      .prepare(
        `SELECT sv.image_path AS imagePath
         FROM deck_slides ds
         JOIN slide_versions sv ON sv.id = ds.active_version_id
         WHERE ds.deck_id = ? AND sv.image_path <> ''
         ORDER BY ds.page_index LIMIT 1`,
      )
      .get(deckId);
    if (!row?.imagePath) throw new Error('页数上限夹具缺少源页图');
    return row.imagePath;
  };
  const makePagedDeck = (pageCount, imagePath) => {
    const created = decksLib.createDeck(uid, {
      title: `${pageCount}页上限夹具`,
      sourceFileName: '',
      sourceText: 'x',
      durationMinutes: 30,
      targetPageCount: pageCount,
      qualityTier: 'standard',
      stylePackId: '',
    });
    db.prepare("UPDATE decks SET status = 'generated' WHERE id = ?").run(created.id);
    const now = Date.now();
    const insSlide = db.prepare(
      `INSERT INTO deck_slides (id, deck_id, page_index, gen_status, active_version_id, created_at, updated_at)
       VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`,
    );
    const insVersion = db.prepare(
      `INSERT INTO slide_versions
        (id, slide_id, deck_id, version_no, kind, status, image_path, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'generate', 'succeeded', ?, ?, ?)`,
    );
    for (let index = 0; index < pageCount; index += 1) {
      const slideId = `${created.id}_s${index}`;
      const versionId = `${created.id}_v${index}`;
      insSlide.run(slideId, created.id, index, versionId, now + index, now + index);
      insVersion.run(versionId, slideId, created.id, imagePath, now + index, now + index);
    }
    return created;
  };
  const startError = async (fn) => {
    try {
      await fn();
      return null;
    } catch (error) {
      return error;
    }
  };
  /** 同步假通道：不触网，捕获管线提交给上游的 PDF 后回一段 PPTX 字节。 */
  const capturingProvider = () => {
    const captured = [];
    const provider = {
      id: 'fake-capture',
      capabilities: { maxPages: 50, resumable: true, attempts: 1, configured: () => true },
      async start(context, input) {
        captured.push(input.pdf);
        return {
          view: { status: 'succeeded', progress: 100, completedPages: context.pageCount, totalPages: context.pageCount, stage: 'downloading', error: '' },
          taskId: `${context.exportId}-task`,
          product: { kind: 'bytes', bytes: Buffer.from('fake-capture-pptx') },
        };
      },
      async advance() {
        throw new Error('fake-capture 同步通道没有推进端点');
      },
      async save(context, product) {
        await context.saveBytes(product.bytes);
      },
      async cleanup() {},
    };
    return { provider, captured };
  };

  // ---- 发起入口的页数门：只按能力拒绝，文案不暴露通道名 ----
  {
    const sharedImage = sourceImagePath(deck.id);
    const codiaOnly = { ...baseConfig, codiaApiKey: 'sk-codia-capacity', image2pptApiKey: '', wpsAipptCookie: '' };
    const i2pConfigured = {
      ...baseConfig,
      codiaApiKey: 'sk-codia-capacity',
      image2pptApiKey: 'i2p-capacity-key',
      wpsAipptCookie: '',
      editableProvider: 'image2ppt',
    };
    credits.refundCredits(uid, 3000, { reason: '页数上限测试补贴', idempotencyKey: 'test-topup-page-capacity' });

    const d20 = makePagedDeck(20, sharedImage);
    const accepted20 = await exportsLib.startDeckEditableExport(
      uid,
      d20.id,
      { config: codiaOnly, providers: [capturingProvider().provider], pollIntervalMs: 1 },
      { force: true },
    );
    check('只配置 Codia：20 页整套可发起',
      accepted20.pageCount === 20 && accepted20.status === 'processing' && accepted20.credits === 400,
      `${accepted20.pageCount} ${accepted20.status} ${accepted20.credits}`);
    await accepted20.done;

    const d21 = makePagedDeck(21, sharedImage);
    const rejected21 = await startError(() => exportsLib.startDeckEditableExport(
      uid,
      d21.id,
      { config: codiaOnly, providers: [capturingProvider().provider] },
      { force: true },
    ));
    check('只配置 Codia：21 页被拒（能力 20）',
      rejected21?.code === 'EXPORT_TOO_MANY_PAGES', `${rejected21?.code} ${rejected21?.message}`);
    check('拒绝文案按可用能力给出且不暴露通道名',
      rejected21?.message === '单套最多 20 页可转可编辑，当前共 21 页'
        && !/codia|image2ppt|wps/i.test(String(rejected21?.message)),
      String(rejected21?.message));

    const d50 = makePagedDeck(50, sharedImage);
    const accepted50 = await exportsLib.startDeckEditableExport(
      uid,
      d50.id,
      { config: i2pConfigured, providers: [capturingProvider().provider], pollIntervalMs: 1 },
      { force: true },
    );
    check('配置 Image2PPT：50 页整套可发起（不被 Codia 的 20 拒绝）',
      accepted50.pageCount === 50 && accepted50.status === 'processing' && accepted50.credits === 1000,
      `${accepted50.pageCount} ${accepted50.status} ${accepted50.credits}`);
    await accepted50.done;

    const wpsConfigured = {
      ...baseConfig,
      codiaApiKey: '',
      image2pptApiKey: '',
      wpsAipptCookie: 'wps_sid=capacity',
      editableProvider: 'wps',
    };
    const accepted50Wps = await exportsLib.startDeckEditableExport(
      uid,
      d50.id,
      { config: wpsConfigured, providers: [capturingProvider().provider], pollIntervalMs: 1 },
      { force: true },
    );
    check('配置 WPS：50 页整套也可发起（能力同样 50）',
      accepted50Wps.pageCount === 50 && accepted50Wps.status === 'processing' && accepted50Wps.credits === 1000,
      `${accepted50Wps.pageCount} ${accepted50Wps.status} ${accepted50Wps.credits}`);
    await accepted50Wps.done;

    const d51 = makePagedDeck(51, sharedImage);
    const rejected51 = await startError(() => exportsLib.startDeckEditableExport(
      uid,
      d51.id,
      { config: i2pConfigured, providers: [capturingProvider().provider] },
      { force: true },
    ));
    check('配置 Image2PPT：51 页被拒（能力 50）',
      rejected51?.code === 'EXPORT_TOO_MANY_PAGES'
        && rejected51?.message === '单套最多 50 页可转可编辑，当前共 51 页',
      `${rejected51?.code} ${rejected51?.message}`);
  }

  // ---- 大套压缩：21–50 页来源合成 PDF 前统一转 JPEG（1920×1080、q88、白底）----
  {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    const { PDFDocument } = require('pdf-lib');
    const { saveFile } = await import('../../src/lib/server/generation/storage.ts');
    const i2pConfigured = {
      ...baseConfig,
      codiaApiKey: 'sk-codia-capacity',
      image2pptApiKey: 'i2p-capacity-key',
      wpsAipptCookie: '',
      editableProvider: 'image2ppt',
    };
    // 2560×1440 透明 PNG + 中心红块：压缩后应缩到 1920×1080、透明处烘成白底、红块保留
    const largePng = await sharp({
      create: { width: 2560, height: 1440, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{
        input: { create: { width: 320, height: 320, channels: 4, background: { r: 226, g: 32, b: 32, alpha: 1 } } },
        left: 1120,
        top: 560,
      }])
      .png()
      .toBuffer();
    const fixture = await saveFile('generated', uid, largePng, { kind: 'jpeg-compress-fixture', ext: '.png' }, baseConfig);
    const countMarker = (buffer, marker) => {
      let count = 0;
      for (let index = buffer.indexOf(marker); index !== -1; index = buffer.indexOf(marker, index + 1)) count += 1;
      return count;
    };
    const pageSizes = (document) => Array.from({ length: document.getPageCount() }, (_, index) =>
      `${document.getPage(index).getWidth()}x${document.getPage(index).getHeight()}`);

    {
      const { provider, captured } = capturingProvider();
      const control = makePagedDeck(2, fixture.relPath);
      const started = await exportsLib.startDeckEditableExport(
        uid,
        control.id,
        { config: i2pConfigured, providers: [provider], pollIntervalMs: 1 },
        { force: true },
      );
      await started.done;
      const document = await PDFDocument.load(captured[0]);
      check('2 页来源不压缩：页尺寸保持原图像素',
        pageSizes(document).join(',') === '2560x1440,2560x1440', pageSizes(document).join(','));
    }

    {
      const { provider, captured } = capturingProvider();
      const boundary = makePagedDeck(20, fixture.relPath);
      const started = await exportsLib.startDeckEditableExport(
        uid,
        boundary.id,
        { config: i2pConfigured, providers: [provider], pollIntervalMs: 1 },
        { force: true },
      );
      await started.done;
      const document = await PDFDocument.load(captured[0]);
      check('20 页边界不压缩：仍按原图尺寸嵌入（阈值是 >20）',
        pageSizes(document).length === 20 && pageSizes(document).every((size) => size === '2560x1440'),
        pageSizes(document).slice(0, 3).join(','));
    }

    {
      const { provider, captured } = capturingProvider();
      const many = makePagedDeck(21, fixture.relPath);
      const started = await exportsLib.startDeckEditableExport(
        uid,
        many.id,
        { config: i2pConfigured, providers: [provider], pollIntervalMs: 1 },
        { force: true },
      );
      await started.done;
      const pdf = captured[0];
      const document = await PDFDocument.load(pdf);
      const sizes = pageSizes(document);
      check('21 页来源：上游收到 21 页 PDF', document.getPageCount() === 21, String(document.getPageCount()));
      check('21 页来源合成 PDF 前转 JPEG：每页 1920×1080',
        sizes.length === 21 && sizes.every((size) => size === '1920x1080'), sizes.join(','));
      check('21 页来源：PDF 内嵌 21 段 JPEG 流（不再直嵌 PNG）',
        countMarker(pdf, Buffer.from([0xff, 0xd8, 0xff])) === 21,
        String(countMarker(pdf, Buffer.from([0xff, 0xd8, 0xff]))));
      const start = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
      const end = pdf.indexOf(Buffer.from([0xff, 0xd9]), start);
      let channels = 0;
      let corner = null;
      let center = null;
      if (start >= 0 && end > start) {
        const { data, info } = await sharp(pdf.subarray(start, end + 2)).raw().toBuffer({ resolveWithObject: true });
        channels = info.channels;
        const pixel = (x, y) => [
          data[(y * info.width + x) * info.channels],
          data[(y * info.width + x) * info.channels + 1],
          data[(y * info.width + x) * info.channels + 2],
        ];
        corner = pixel(5, 5);
        center = pixel(Math.floor(info.width / 2), Math.floor(info.height / 2));
      }
      check('JPEG 压缩把透明区域烘成白底',
        channels === 3 && corner !== null && corner.every((value) => value >= 245), `${channels} ${corner?.join(',')}`);
      check('JPEG 压缩保留画面内容（中心红块仍在）',
        center !== null && center[0] > 180 && center[1] < 80 && center[2] < 80, center?.join(','));
    }

    {
      const { provider, captured } = capturingProvider();
      credits.refundCredits(uid, 400, { reason: '上传压缩测试补贴', idempotencyKey: 'test-topup-upload-compress' });
      const files = Array.from({ length: 21 }, (_, index) => ({ name: `p${index}.png`, mime: 'image/png', data: largePng }));
      const started = await exportsLib.startUploadedEditableExport(
        uid,
        files,
        { config: i2pConfigured, providers: [provider], pollIntervalMs: 1 },
        { force: true },
      );
      await started.done;
      const document = await PDFDocument.load(captured[0]);
      const sizes = pageSizes(document);
      check('上传 21 张图片同样先转 JPEG：每页 1920×1080',
        sizes.length === 21 && sizes.every((size) => size === '1920x1080'), sizes.join(','));
    }
  }

  // ---- 假通道驱动管线：start / advance / save / cleanup 与统一进度落库 ----
  const fakeProvider = (input) => {
    const calls = [];
    const provider = {
      id: input.id,
      capabilities: {
        maxPages: 50,
        resumable: true,
        attempts: 1,
        configured: () => true,
        ...(input.capabilities || {}),
      },
      async start(context, startInput) {
        calls.push(`start:${startInput.attempt}`);
        if (input.start) return input.start(context, startInput, calls);
        return {
          view: { status: 'pending', progress: 0, completedPages: 0, totalPages: startInput.pageCount, stage: 'waiting', error: '' },
          taskId: `${input.id}-task`,
          product: null,
        };
      },
      async advance(context, taskId) {
        calls.push(`advance:${taskId}`);
        if (input.advance) return input.advance(context, taskId, calls);
        return {
          view: { status: 'succeeded', progress: 100, completedPages: context.pageCount, totalPages: context.pageCount, stage: 'downloading', error: '' },
          taskId,
          product: { kind: 'bytes', bytes: Buffer.from(`${input.id}-pptx`) },
        };
      },
      async save(context, product) {
        calls.push(`save:${product.kind}`);
        if (product.kind === 'bytes') await context.saveBytes(product.bytes);
        else await context.saveUrl(product.url, product.headers);
      },
      async cleanup() {
        calls.push('cleanup');
      },
    };
    return { provider, calls };
  };

  {
    credits.refundCredits(uid, 200, { reason: 'provider 测试补贴', idempotencyKey: 'test-topup-providers' });
    const observed = [];
    const { provider, calls } = fakeProvider({
      id: 'fake-resumable',
      advance: async (context, taskId) => {
        const taskRow = getGenDb()
          .prepare('SELECT stage, upstream_provider, upstream_task_id FROM export_jobs WHERE id = ?')
          .get(context.exportId);
        observed.push({ phase: 'task-recorded', ...taskRow });
        context.report({ progress: 40, completedPages: 1 });
        const reported = getGenDb()
          .prepare('SELECT progress, completed_pages, stage FROM export_jobs WHERE id = ?')
          .get(context.exportId);
        observed.push({ phase: 'reported', ...reported });
        return {
          view: { status: 'succeeded', progress: 100, completedPages: 2, totalPages: 2, stage: 'downloading', error: '' },
          taskId,
          product: { kind: 'bytes', bytes: Buffer.from('fake-pptx') },
        };
      },
    });
    const deps = { config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' }, providers: [provider], pollIntervalMs: 1 };
    const started = await exportsLib.startDeckEditableExport(uid, deck.id, deps, { force: true });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId, deps);
    const row = getGenDb()
      .prepare('SELECT upstream_provider, upstream_task_id FROM export_jobs WHERE id = ?')
      .get(started.exportId);
    const recorded = observed.find((item) => item.phase === 'task-recorded') || {};
    const reported = observed.find((item) => item.phase === 'reported') || {};
    check('假通道驱动管线：没有通道名分支也能 start → advance → save 落盘',
      exp.status === 'succeeded' && exp.url.startsWith('/api/files/exports/'), `${exp.status} ${exp.error}`);
    check('假通道驱动管线：通道 id 与上游任务 id 落库',
      row?.upstream_provider === 'fake-resumable' && row?.upstream_task_id === 'fake-resumable-task');
    check('统一进度落库：start 视图先写 waiting，advance 中途 report 的 40%/1 页覆盖为 converting',
      recorded.stage === 'waiting' && recorded.upstream_task_id === 'fake-resumable-task'
        && reported.progress === 40 && reported.completed_pages === 1 && reported.stage === 'converting',
      `${JSON.stringify(recorded)} ${JSON.stringify(reported)}`);
    check('假通道驱动管线：cleanup 每次运行恰一次', calls.filter((item) => item === 'cleanup').length === 1);
  }

  // ---- 能力声明的提交次数：第一次失败后同一通道重建一次，键带 attempt ----
  {
    const { provider, calls } = fakeProvider({
      id: 'fake-attempts',
      capabilities: { attempts: 2 },
      start: async (context, startInput) => {
        if (startInput.attempt === 0) {
          throw new ApiError('FAKE_BUSY', 'mock busy', 502, true);
        }
        return {
          view: { status: 'succeeded', progress: 100, completedPages: context.pageCount, totalPages: context.pageCount, stage: 'downloading', error: '' },
          taskId: 'fake-attempts-task',
          product: { kind: 'bytes', bytes: Buffer.from('fake-attempts-pptx') },
        };
      },
    });
    const deps = { config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' }, providers: [provider], pollIntervalMs: 1 };
    const started = await exportsLib.startDeckEditableExport(uid, deck.id, deps, { force: true });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId, deps);
    check('能力声明的 attempts=2：首次提交失败后用第 2 次提交成功',
      exp.status === 'succeeded' && calls.includes('start:0') && calls.includes('start:1'), calls.join(','));
  }

  // ---- 回退顺序来自注入的 registry：前一个失败后自动切下一个 ----
  {
    const busy = fakeProvider({
      id: 'fake-busy',
      start: async () => {
        throw new ApiError('FAKE_BUSY', 'mock busy', 502, true);
      },
    });
    const ok = fakeProvider({ id: 'fake-ok' });
    const deps = {
      config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' },
      providers: [busy.provider, ok.provider],
      pollIntervalMs: 1,
    };
    const started = await exportsLib.startDeckEditableExport(uid, deck.id, deps, { force: true });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId, deps);
    const row = getGenDb().prepare('SELECT upstream_provider FROM export_jobs WHERE id = ?').get(started.exportId);
    check('回退：前一个通道失败后按序切下一个并成功',
      exp.status === 'succeeded' && row?.upstream_provider === 'fake-ok');
    check('回退：两个通道都各清理一次',
      busy.calls.includes('cleanup') && ok.calls.includes('cleanup'));
  }

  // ---- 同步通道（resumable=false）：start 直接带回产物，不进入轮询 ----
  {
    const { provider, calls } = fakeProvider({
      id: 'fake-sync',
      capabilities: { resumable: false },
      start: async (context) => ({
        view: { status: 'succeeded', progress: 100, completedPages: context.pageCount, totalPages: context.pageCount, stage: 'downloading', error: '' },
        taskId: 'fake-sync-doc',
        product: { kind: 'bytes', bytes: Buffer.from('fake-sync-pptx') },
      }),
    });
    const deps = { config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' }, providers: [provider], pollIntervalMs: 1 };
    const started = await exportsLib.startDeckEditableExport(uid, deck.id, deps, { force: true });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId, deps);
    check('同步通道：start 带回产物即落盘，advance 一次都不调用',
      exp.status === 'succeeded' && !calls.some((item) => item.startsWith('advance')), calls.join(','));
  }

  // ---- 恢复只依赖接口：未知通道 id 也按 advance + save 推进 ----
  {
    const { provider, calls } = fakeProvider({ id: 'fake-resume' });
    const now = Date.now();
    getGenDb().prepare(`INSERT INTO export_jobs
        (id, user_id, ref_type, ref_id, kind, status, page_count, upstream_provider, upstream_task_id, charged_credits, created_at, updated_at)
       VALUES ('exp_fake_resume', ?, 'deck', ?, 'editable', 'processing', 2, 'fake-resume', 'fake-resume-task', 0, ?, ?)`)
      .run(uid, deck.id, now, now);
    const rec = await exportsLib.getExport(uid, 'exp_fake_resume', {
      config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' },
      providers: [provider],
      pollIntervalMs: 1,
    });
    check('恢复：可恢复通道按任务 id 现场推进并保存',
      rec.status === 'succeeded' && calls.includes('advance:fake-resume-task') && calls.includes('save:bytes'),
      `${rec.status} ${calls.join(',')}`);
  }

  // ---- 恢复：不可恢复通道（无任务查询端点）中断后重跑整条管线 ----
  {
    const calls = [];
    const rerun = {
      id: 'fake-oneshot',
      capabilities: { maxPages: 50, resumable: false, attempts: 1, configured: () => true },
      async start(context) {
        calls.push('rerun');
        return {
          view: { status: 'succeeded', progress: 100, completedPages: context.pageCount, totalPages: context.pageCount, stage: 'downloading', error: '' },
          taskId: '',
          product: { kind: 'bytes', bytes: Buffer.from('fake-oneshot-pptx') },
        };
      },
      async advance() {
        throw new Error('one-shot 通道没有任务查询端点');
      },
      async save(context, product) {
        await context.saveBytes(product.bytes);
      },
      async cleanup() {},
    };
    const now = Date.now();
    getGenDb().prepare(`INSERT INTO export_jobs
        (id, user_id, ref_type, ref_id, kind, status, page_count, upstream_provider, upstream_task_id, charged_credits, created_at, updated_at)
       VALUES ('exp_fake_rerun', ?, 'deck', ?, 'editable', 'processing', 2, 'fake-oneshot', 'fake-oneshot-doc', 0, ?, ?)`)
      .run(uid, deck.id, now, now);
    const deps = { config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' }, providers: [rerun], pollIntervalMs: 1 };
    await exportsLib.getExport(uid, 'exp_fake_rerun', deps);
    let status = 'processing';
    for (let index = 0; index < 150 && status !== 'succeeded'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = String(getGenDb().prepare('SELECT status FROM export_jobs WHERE id = ?').get('exp_fake_rerun')?.status || '');
    }
    check('恢复：不可恢复通道的中断重跑整条管线（不调用 advance）',
      status === 'succeeded' && calls.includes('rerun'), `${status} ${calls.join(',')}`);
  }

  // ---- 共享文案与有限数解析：接口层唯一一份 ----
  {
    const codia = await import('../../src/modules/editable-export/server/codia.ts');
    const i2p = await import('../../src/modules/editable-export/server/image2ppt.ts');
    const wps = await import('../../src/modules/editable-export/server/wps-aippt.ts');

    const unconfigured = { ...baseConfig, codiaApiKey: '', image2pptApiKey: '', wpsAipptCookie: '' };
    const notConfigured = {};
    for (const [name, run] of Object.entries({
      codia: () => codia.getTask('task-x', { config: unconfigured }),
      image2ppt: () => i2p.getJob('job-x', { config: unconfigured }),
      wps: () => wps.convertPdfWithWpsAippt(Buffer.from('%PDF-1.4 x'), 'x.pdf', { config: unconfigured }),
    })) {
      try {
        await run();
      } catch (error) {
        notConfigured[name] = error;
      }
    }
    check('未配置提示：三个通道同一句文案与同一个错误码',
      ['codia', 'image2ppt', 'wps'].every((name) => notConfigured[name]?.code === 'EDITABLE_EXPORT_UNAVAILABLE'
        && notConfigured[name]?.message === providersLib.UNCONFIGURED_MESSAGE),
      JSON.stringify(Object.fromEntries(Object.entries(notConfigured).map(([key, error]) => [key, error?.message]))));

    const busyConfig = {
      ...baseConfig,
      codiaApiKey: 'sk-codia-test',
      image2pptApiKey: 'i2p-key',
      wpsAipptCookie: 'wps_sid=test',
    };
    const networkDown = async () => {
      throw new TypeError('fetch failed');
    };
    const busy = {};
    for (const [name, run] of Object.entries({
      codia: () => codia.getTask('task-y', { config: busyConfig, fetchImpl: networkDown, retryDelayMs: 0 }),
      image2ppt: () => i2p.getJob('job-y', { config: busyConfig, fetchImpl: networkDown, retryDelayMs: 0 }),
      wps: () => wps.convertPdfWithWpsAippt(Buffer.from('%PDF-1.4 y'), 'y.pdf', { config: busyConfig, fetchImpl: networkDown }),
    })) {
      try {
        await run();
      } catch (error) {
        busy[name] = error;
      }
    }
    check('上游繁忙提示：三个通道同一句文案',
      ['codia', 'image2ppt', 'wps'].every((name) => busy[name]?.message === providersLib.UPSTREAM_BUSY_MESSAGE),
      JSON.stringify(Object.fromEntries(Object.entries(busy).map(([key, error]) => [key, error?.message]))));

    const upstreamDown = async () => new Response('', { status: 502 });
    const unavailable = {};
    for (const [name, run] of Object.entries({
      codia: () => codia.getTask('task-z', { config: busyConfig, fetchImpl: upstreamDown, retryDelayMs: 0 }),
      image2ppt: () => i2p.getJob('job-z', { config: busyConfig, fetchImpl: upstreamDown, retryDelayMs: 0 }),
      wps: () => wps.convertPdfWithWpsAippt(Buffer.from('%PDF-1.4 z'), 'z.pdf', { config: busyConfig, fetchImpl: upstreamDown }),
    })) {
      try {
        await run();
      } catch (error) {
        unavailable[name] = error;
      }
    }
    check('上游 5xx 提示：三个通道同一句文案',
      ['codia', 'image2ppt', 'wps'].every((name) => unavailable[name]?.message === providersLib.UPSTREAM_BUSY_MESSAGE),
      JSON.stringify(Object.fromEntries(Object.entries(unavailable).map(([key, error]) => [key, error?.message]))));

    const gateErrors = {};
    for (const [name, run] of Object.entries({
      deck: () => exportsLib.startDeckEditableExport(uid, deck.id, { config: unconfigured }),
      singlePage: () => exportsLib.startSinglePageEditableExport(uid, 'proj_any', { config: unconfigured }),
      upload: () => exportsLib.startUploadedEditableExport(uid, [], { config: unconfigured }),
    })) {
      try {
        await run();
      } catch (error) {
        gateErrors[name] = error;
      }
    }
    check('未配置提示：三个发起入口同一句文案与同一个码',
      ['deck', 'singlePage', 'upload'].every((name) => gateErrors[name]?.code === 'EDITABLE_EXPORT_UNAVAILABLE'
        && gateErrors[name]?.message === providersLib.UNCONFIGURED_MESSAGE),
      JSON.stringify(Object.fromEntries(Object.entries(gateErrors).map(([key, error]) => [key, error?.message]))));

    check('有限数解析唯一实现：负数/非数字归零、有限值原样',
      providersLib.finiteNumber(-3) === 0 && providersLib.finiteNumber('abc') === 0
        && providersLib.finiteNumber(undefined) === 0 && providersLib.finiteNumber('12.5') === 12.5);
  }

  // ---- 报价同样按请求页数过滤通道（>20 页剔除 Codia）----
  {
    const previous = {
      codia: process.env.ANPPT_V2_CODIA_API_KEY,
      image2ppt: process.env.ANPPT_V2_IMAGE2PPT_API_KEY,
      wps: process.env.ANPPT_V2_WPS_AIPPT_COOKIE,
      provider: process.env.ANPPT_V2_EDITABLE_PROVIDER,
    };
    process.env.ANPPT_V2_CODIA_API_KEY = 'sk-quote-codia';
    process.env.ANPPT_V2_IMAGE2PPT_API_KEY = 'i2p-quote-key';
    process.env.ANPPT_V2_WPS_AIPPT_COOKIE = 'wps_sid=quote';
    delete process.env.ANPPT_V2_EDITABLE_PROVIDER;
    try {
      const pageIds = Array.from({ length: 21 }, (_, index) => `pg_${index}`);
      const many = exportsLib.quoteExport(uid, { pageIds });
      check('报价：21 页按 registry 剔除 Codia，只留 50 页通道',
        many.pageCount === 21 && many.providers.join('/') === 'image2ppt/wps' && many.provider === 'image2ppt',
        `${many.pageCount} ${many.providers.join('/')}`);
      const few = exportsLib.quoteExport(uid, { pageIds: pageIds.slice(0, 20) });
      check('报价：20 页边界仍可选 Codia',
        few.providers.join('/') === 'codia/image2ppt/wps', few.providers.join('/'));
    } finally {
      for (const [key, envKey] of [
        ['codia', 'ANPPT_V2_CODIA_API_KEY'],
        ['image2ppt', 'ANPPT_V2_IMAGE2PPT_API_KEY'],
        ['wps', 'ANPPT_V2_WPS_AIPPT_COOKIE'],
        ['provider', 'ANPPT_V2_EDITABLE_PROVIDER'],
      ]) {
        if (previous[key] === undefined) delete process.env[envKey];
        else process.env[envKey] = previous[key];
      }
    }
  }

  // ---- 上游轮询抖动：可重试错误继续等同一任务，不重建任务（不重复打上游付费接口）----
  {
    let advances = 0;
    const { provider, calls } = fakeProvider({
      id: 'fake-flaky-poll',
      advance: async (context, taskId) => {
        advances += 1;
        if (advances === 1) {
          throw new ApiError('FAKE_BUSY', 'mock poll jitter', 502, true);
        }
        return {
          view: { status: 'succeeded', progress: 100, completedPages: context.pageCount, totalPages: context.pageCount, stage: 'downloading', error: '' },
          taskId,
          product: { kind: 'bytes', bytes: Buffer.from('fake-flaky-pptx') },
        };
      },
    });
    const deps = { config: { ...baseConfig, codiaApiKey: 'sk-fake-pipeline' }, providers: [provider], pollIntervalMs: 1 };
    const started = await exportsLib.startDeckEditableExport(uid, deck.id, deps, { force: true });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId, deps);
    check('上游轮询抖动：继续等同一任务而不重建（start 只提交 1 次）',
      exp.status === 'succeeded' && calls.filter((item) => item.startsWith('start')).length === 1 && advances === 2,
      `${calls.join(',')} advances=${advances}`);
  }
}
