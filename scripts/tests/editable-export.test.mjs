// editable-export 模块测试：Codia 重转换链 / 单页可编辑 / 外部文件转换 / 轻量文字档，全 mock。
// 由 scripts/test-generation.mjs 注入 ctx 调用；exportsLib 指向模块服务端出口。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export async function runEditableExportTests(ctx) {
  const {
    check, expectThrows, auth, credits, uid, llmConfig, baseConfig,
    decks, singlePages, makeMockFetcher, editsOkHandler, PNG_1X1_B64, deck, actions, STYLE_PACKS, engineConfig, engineHandlers, imageConfig, jsonResponse,
  } = ctx;
  const exportsLib = await import('../../src/modules/editable-export/server/editable.ts');
  console.log('\n[6b] 可编辑导出（Codia 链全 mock，零真实调用）');
  {
    const codiaDeps = (fetchImpl) => ({ fetchImpl, config: baseConfig, pollIntervalMs: 1 });
    const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
    const ledgerKeys = () =>
      genDb.prepare('SELECT idempotency_key FROM credit_ledger WHERE user_id = ?').all(uid).map((r) => String(r.idempotency_key));

    check('estimateCredits：export_editable 按页计价（3 页 = 60）',
      credits.estimateCredits({ action: 'export_editable', pages: 3 }).credits === 60);
    credits.refundCredits(uid, 500, { reason: '测试补贴', idempotencyKey: 'test-topup-6b' });

    // ---- 扣费键唯一来源（架构评审 C2）：扣费与退款必须拼出同一个键 ----
    {
      const keyLib = await import('../../src/modules/editable-export/server/charge-keys.ts');
      const { chargeRefundKeys } = await import('../../src/lib/server/credits.ts');
      const deckKey = keyLib.editableChargeKey({ kind: 'editable', refId: 'deck-1', exportId: 'exp-1' });
      const textKey = keyLib.editableChargeKey({ kind: 'editable_text', refId: 'deck-1', exportId: 'exp-1' });
      check('扣费键：editable 档前缀与历史账本一致', deckKey === 'export-editable:deck-1:exp-1', deckKey);
      check('扣费键：editable_text 档前缀独立', textKey === 'export-editable-text:deck-1:exp-1', textKey);
      check('扣费键：未知 kind 回落 editable 档，不凭空造前缀',
        keyLib.editableChargeKey({ kind: 'mystery', refId: 'd', exportId: 'e' }) === 'export-editable:d:e');
      check('扣费键：同输入同输出（幂等前提）',
        keyLib.editableChargeKey({ kind: 'editable', refId: 'd', exportId: 'e' })
          === keyLib.editableChargeKey({ kind: 'editable', refId: 'd', exportId: 'e' }));
      check('退款键：由扣费键定长派生且不等于扣费键',
        chargeRefundKeys(deckKey).refundKey !== deckKey && chargeRefundKeys(deckKey).chargeKey === deckKey);
    }

    // ---- 已启动任务固定 Codia 配置快照：管理员中途切换只影响后续新任务 ----
    {
      const envKeys = ['ANPPT_V2_CODIA_BASE_URL', 'ANPPT_V2_CODIA_API_KEY'];
      const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
      process.env.ANPPT_V2_CODIA_BASE_URL = 'http://snapshot-codia-a.test';
      process.env.ANPPT_V2_CODIA_API_KEY = 'snapshot-codia-key-a';
      let pollN = 0;
      const upstreamCalls = [];
      const fetcher = async (url, init = {}) => {
        const href = String(url);
        upstreamCalls.push({ href, auth: init.headers?.Authorization || '' });
        if (href.includes('/v2/open/uploads')) {
          process.env.ANPPT_V2_CODIA_BASE_URL = 'http://snapshot-codia-b.test';
          process.env.ANPPT_V2_CODIA_API_KEY = 'snapshot-codia-key-b';
          return jsonResponse({ code: 0, data: { upload_id: 'snapshot-upload' } });
        }
        if (href.endsWith('/v2/open/tasks')) {
          return jsonResponse({ code: 0, data: { task_id: 'snapshot-task', status: 'pending' } });
        }
        if (href.includes('/v2/open/tasks/snapshot-task')) {
          pollN += 1;
          return jsonResponse({ code: 0, data: pollN === 1
            ? { status: 'pending' }
            : { status: 'succeeded', result: { ppt_url: 'http://snapshot-files/result.pptx', page_count: 2 } } });
        }
        if (href === 'http://snapshot-files/result.pptx') return new Response(Buffer.from('snapshot-pptx'));
        throw new Error(`snapshot fetch 未命中: ${href}`);
      };
      try {
        const started = await exportsLib.startDeckEditableExport(
          uid, deck.id, { fetchImpl: fetcher, pollIntervalMs: 1, retryDelayMs: 0 }, { force: true },
        );
        await started.done;
        const codiaCalls = upstreamCalls.filter((call) => call.href.includes('/v2/open/'));
        check('管理员中途改配置不影响已启动可编辑管线',
          codiaCalls.length >= 4
            && codiaCalls.every((call) => call.href.startsWith('http://snapshot-codia-a.test/'))
            && codiaCalls.every((call) => call.auth === 'Bearer snapshot-codia-key-a'));
      } finally {
        for (const key of envKeys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
      }
    }

    // ---- 成功链：uploads → tasks → poll(pending→succeeded) → 下载落盘 ----
    {
      let pollN = 0;
      let uploadInit = null;
      const createInits = [];
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/', payload: () => ((pollN += 1) === 1
            ? { code: 0, message: 'ok', data: { status: 'pending' } }
            : { code: 0, message: 'ok', data: { status: 'succeeded', result: { ppt_url: 'http://mock-codia/files/r1.pptx', page_count: 2 } } }) },
        { match: '/v2/open/tasks', payload: (init) => {
            createInits.push(init);
            return { code: 0, message: 'ok', data: { task_id: 'task_ok1', status: 'pending' } };
          } },
        { match: '/v2/open/uploads', payload: (init) => {
            uploadInit = init;
            return { code: 0, message: 'ok', data: { upload_id: 'upl_1' } };
          } },
        { match: 'r1.pptx', payload: new Response(Buffer.from('mock-pptx-binary')) },
      ]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher), { force: true });
      check('可编辑导出发起：processing + 40🌟（20×2页）',
        started.status === 'processing' && started.credits === 40 && started.pageCount === 2);
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('转换成功落盘，url 以 /api/files/exports/ 开头',
        exp.status === 'succeeded' && exp.url.startsWith('/api/files/exports/'), `实际 ${exp.status} ${exp.url}`);
      check('净扣 40🌟', before - credits.getBalance(uid) === 40, `before=${before} after=${credits.getBalance(uid)}`);
      check('ledger debit 键 export-editable:{deckId}:{exportId} 唯一',
        ledgerKeys().filter((k) => k === `export-editable:${deck.id}:${started.exportId}`).length === 1);
      check('上传走 multipart file 字段 + Bearer 鉴权',
        uploadInit?.body instanceof FormData && Boolean(uploadInit.body.get('file'))
          && uploadInit.headers.Authorization === 'Bearer sk-test');
      const createBody = JSON.parse(createInits[0].body);
      check('建任务：pdf_to_ppt + upload_id + page_no [0,1] + 幂等键',
        createBody.operation === 'pdf_to_ppt'
          && createBody.input.upload_id === 'upl_1'
          && JSON.stringify(createBody.input.page_no) === '[0,1]'
          && createInits[0].headers['Idempotency-Key'] === `anppt-editable-${started.exportId}`);
      const reused = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher));
      check('同源成功结果默认复用：同 exportId、0 扣星、无新上游请求',
        reused.exportId === started.exportId && reused.reused && reused.credits === 0 && createInits.length === 1);
    }

    // ---- 首次 failed → 自动 retry（-retry1 幂等键）成功 ----
    {
      let createN = 0;
      const idemKeys = [];
      let poll2 = 0;
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/task_r1', payload: { code: 0, message: 'ok', data: { status: 'failed', error: 'mock 转换爆炸' } } },
        { match: '/v2/open/tasks/task_r2', payload: () => ((poll2 += 1) === 1
            ? { code: 0, message: 'ok', data: { status: 'pending' } }
            : { code: 0, message: 'ok', data: { status: 'succeeded', result: { ppt_url: 'http://mock-codia/files/r2.pptx', page_count: 2 } } }) },
        { match: '/v2/open/tasks', payload: (init) => {
            createN += 1;
            idemKeys.push(init.headers['Idempotency-Key']);
            return { code: 0, message: 'ok', data: { task_id: `task_r${createN}`, status: 'pending' } };
          } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_r' } } },
        { match: 'r2.pptx', payload: new Response(Buffer.from('mock-pptx-binary-2')) },
      ]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher), { force: true });
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('首次失败自动重试后成功', exp.status === 'succeeded', `实际 ${exp.status} ${exp.error}`);
      check('两次建任务，幂等键 base → -retry1', createN === 2
        && idemKeys[0] === `anppt-editable-${started.exportId}`
        && idemKeys[1] === `anppt-editable-${started.exportId}-retry1`);
      check('重试只扣一次星（净扣 40）', before - credits.getBalance(uid) === 40);
    }

    // ---- 两次 failed → 退星 + failed ----
    {
      let createN = 0;
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/', payload: { code: 0, message: 'ok', data: { status: 'failed', error: 'mock 持续失败' } } },
        { match: '/v2/open/tasks', payload: () => {
            createN += 1;
            return { code: 0, message: 'ok', data: { task_id: `task_f${createN}`, status: 'pending' } };
          } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_f' } } },
      ]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher), { force: true });
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('两次失败 → status=failed 且 error 非空', exp.status === 'failed' && exp.error.length > 0, `实际 ${exp.status}`);
      check('失败全额退星（余额不变）', credits.getBalance(uid) === before);
      const refundKey = credits.deriveRefundKey(`export-editable:${deck.id}:${started.exportId}`);
      check('refund 键唯一', ledgerKeys().filter((k) => k === refundKey).length === 1);
      check('确已自动重试过一次（建任务 2 次）', createN === 2);
    }

    // ---- Codia 402（上游余额不足）：立即终态退星，不重试 ----
    {
      let createN = 0;
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks', payload: () => {
            createN += 1;
            return jsonResponse({ code: 4002, message: 'upstream credit exhausted' }, 402);
          } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_402' } } },
      ]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher), { force: true });
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('上游 402 → failed + error 含「暂时不可用」', exp.status === 'failed' && exp.error.includes('暂时不可用'), `实际 ${exp.error}`);
      check('上游 402 退星', credits.getBalance(uid) === before);
      check('上游 402 不重试（建任务仅 1 次）', createN === 1);
    }

    // ---- 余额不足 402：先校验再建行，不产生 export 行 ----
    {
      const poorE = await auth.registerWithPassword(
        { account: 'exportpoor', password: 'password123', confirmPassword: 'password123' },
        '127.0.0.1',
      );
      const okFetcher6b = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
      const okDeps6b = { fetchImpl: okFetcher6b, config: engineConfig };
      const pd = decks.createDeck(poorE.user.id, {
        title: '穷人可编辑', sourceFileName: '', sourceText: '内容',
        durationMinutes: 15, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
      });
      await actions.dispatchDeckIntent(poorE.user.id, pd.id, { kind: 'generateOutline', params: {} }, okDeps6b);
      await actions.dispatchDeckIntent(poorE.user.id, pd.id, { kind: 'structureSlides', params: {} }, okDeps6b);
      await actions.dispatchDeckIntent(poorE.user.id, pd.id, { kind: 'confirmStructure', params: {} }, okDeps6b);
      await actions.dispatchDeckIntent(poorE.user.id, pd.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, okDeps6b);
      const g = await actions.dispatchDeckIntent(poorE.user.id, pd.id, { kind: 'generateSlides', params: {} }, okDeps6b);
      await g.job.done;
      check('穷人 deck 生成全绿', decks.getDeckState(poorE.user.id, pd.id).deck.status === 'generated');
      credits.debitCredits(poorE.user.id, 50, { reason: '测试花掉', idempotencyKey: 'test-drain-6b' });
      // 100（注册） - 20（生成 2 页） - 50 = 30 < 40（可编辑需 20×2）
      await expectThrows('余额 30 < 40 → 402 INSUFFICIENT_CREDITS', () =>
        exportsLib.startDeckEditableExport(poorE.user.id, pd.id, codiaDeps(makeMockFetcher([]))), 'INSUFFICIENT_CREDITS');
      const editableRows = Number(
        genDb.prepare("SELECT COUNT(*) AS c FROM export_jobs WHERE ref_id = ? AND kind = 'editable'").get(pd.id)?.c || 0,
      );
      check('402 后不产生 export 行', editableRows === 0, `实际 ${editableRows}`);
    }

    // ---- 21 页 deck → 400 单套最多 20 页 ----
    {
      const d21 = decks.createDeck(uid, {
        title: '21页套', sourceFileName: '', sourceText: 'x',
        durationMinutes: 30, targetPageCount: 21, qualityTier: 'standard', stylePackId: '',
      });
      genDb.prepare("UPDATE decks SET status = 'generated' WHERE id = ?").run(d21.id);
      const ins = genDb.prepare('INSERT INTO deck_slides (id, deck_id, page_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < 21; i += 1) ins.run(`s21_${i}`, d21.id, i, Date.now(), Date.now());
      await expectThrows('21 页 → 400 EXPORT_TOO_MANY_PAGES', () =>
        exportsLib.startDeckEditableExport(uid, d21.id, codiaDeps(makeMockFetcher([]))), 'EXPORT_TOO_MANY_PAGES');
    }

    // ---- 并发：processing 中再次 start → 409 EXPORT_RUNNING ----
    {
      let release = false;
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/', payload: () => (release
            ? { code: 0, message: 'ok', data: { status: 'failed', error: 'mock 收尾失败' } }
            : { code: 0, message: 'ok', data: { status: 'pending' } }) },
        { match: '/v2/open/tasks', payload: { code: 0, message: 'ok', data: { task_id: 'task_c', status: 'pending' } } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_c' } } },
      ]);
      const started = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher), { force: true });
      const reused = await exportsLib.startDeckEditableExport(uid, deck.id, codiaDeps(fetcher));
      check('processing 中再次 start → 复用同一任务且不扣星', reused.exportId === started.exportId && reused.reused && reused.credits === 0);
      release = true;
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('收尾：并发用例任务终态 failed + 已退星', exp.status === 'failed' && exp.error.length > 0);
    }

    // ---- 懒恢复：processing + upstream_task_id 的行，getExport 现场 poll 推进 ----
    {
      const now = Date.now();
      genDb.prepare(`INSERT INTO export_jobs
          (id, user_id, ref_type, ref_id, kind, status, page_count, file_path, file_url, error, upstream_task_id, charged_credits, created_at, updated_at)
         VALUES ('exp_lazy_test', ?, 'deck', ?, 'editable', 'processing', 2, '', '', '', 'task_lazy', 40, ?, ?)`)
        .run(uid, deck.id, now, now);
      const lazyFetcher = makeMockFetcher([
        { match: '/v2/open/tasks/task_lazy', payload: { code: 0, message: 'ok', data: { status: 'succeeded', result: { ppt_url: 'http://mock-codia/files/lazy.pptx', page_count: 2 } } } },
        { match: 'lazy.pptx', payload: new Response(Buffer.from('lazy-pptx-binary')) },
      ]);
      const before = credits.getBalance(uid);
      const rec = await exportsLib.getExport(uid, 'exp_lazy_test', codiaDeps(lazyFetcher));
      check('懒恢复：getExport poll 推进到 succeeded + 落盘',
        rec.status === 'succeeded' && rec.url.startsWith('/api/files/exports/'), `实际 ${rec.status} ${rec.url}`);
      check('懒恢复成功不触碰余额', credits.getBalance(uid) === before);
    }

    // ---- 懒恢复读点：导出列表读一眼就重跑中断的导出（调用方不显式调用恢复）----
    {
      const now = Date.now();
      genDb.prepare(`INSERT INTO export_jobs
          (id, user_id, ref_type, ref_id, kind, status, page_count, file_path, file_url, error, upstream_task_id, charged_credits, created_at, updated_at)
         VALUES ('exp_lazy_read', ?, 'deck', ?, 'editable', 'processing', 2, '', '', '', '', 40, ?, ?)`)
        .run(uid, deck.id, now - 60_000, now - 60_000);
      let pollN = 0;
      const readFetcher = makeMockFetcher([
        { match: '/v2/open/tasks/task_read', payload: () => (pollN++ > 0
          ? { code: 0, message: 'ok', data: { status: 'succeeded', result: { ppt_url: 'http://mock-codia/files/read.pptx', page_count: 2 } } }
          : { code: 0, message: 'ok', data: { status: 'pending' } }) },
        { match: '/v2/open/tasks', payload: { code: 0, message: 'ok', data: { task_id: 'task_read', status: 'pending' } } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_read' } } },
        { match: 'read.pptx', payload: new Response(Buffer.from('read-pptx-binary')) },
      ]);
      const beforeRead = credits.getBalance(uid);
      exportsLib.listExports(uid, {}, codiaDeps(readFetcher));
      let readStatus = 'processing';
      for (let i = 0; i < 150 && readStatus !== 'succeeded'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        readStatus = String(genDb.prepare('SELECT status FROM export_jobs WHERE id = ?').get('exp_lazy_read')?.status || '');
      }
      check('懒恢复读点：listExports 读一眼即重跑中断的导出', readStatus === 'succeeded', `实际 ${readStatus}`);
      check('懒恢复读点：重跑不重复扣星', credits.getBalance(uid) === beforeRead);
    }

    // ---- 未 generated deck → 409 ----
    {
      const dNg = decks.createDeck(uid, {
        title: '未生成', sourceFileName: '', sourceText: 'x',
        durationMinutes: 5, targetPageCount: 1, qualityTier: 'standard', stylePackId: '',
      });
      await expectThrows('未 generated deck → 409 EXPORT_NOT_READY', () =>
        exportsLib.startDeckEditableExport(uid, dNg.id, codiaDeps(makeMockFetcher([]))), 'EXPORT_NOT_READY');
    }

    // ---- 路由层：缺 CSRF 403 / 未登录 401（均不触达上游）----
    {
      const editableRoute = await import('../../src/app/api/deck/[id]/export-editable/route.ts');
      const noCsrf = await editableRoute.POST(
        new Request(`http://localhost/api/deck/${deck.id}/export-editable`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        { params: Promise.resolve({ id: deck.id }) },
      );
      check('export-editable 缺 CSRF 头 403', noCsrf.status === 403, `实际 ${noCsrf.status}`);
      const noAuth = await editableRoute.POST(
        new Request(`http://localhost/api/deck/${deck.id}/export-editable`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
          body: '{}',
        }),
        { params: Promise.resolve({ id: deck.id }) },
      );
      check('export-editable 未登录 401', noAuth.status === 401, `实际 ${noAuth.status}`);
      const routeToken = auth.createSessionForUser(uid);
      const noBody = await editableRoute.POST(
        new Request(`http://localhost/api/deck/${deck.id}/export-editable`, {
          method: 'POST',
          headers: { cookie: `anppt_v2_session=${routeToken}`, 'x-anppt-action': '1' },
        }),
        { params: Promise.resolve({ id: deck.id }) },
      );
      check('export-editable 无请求体不再兼容（缺意图 400）', noBody.status === 400, `实际 ${noBody.status}`);
    }
  }

  console.log('\n[6c] 单页可编辑导出（Codia 链全 mock，零真实调用）');
  {
    const codiaDeps = (fetchImpl) => ({ fetchImpl, config: baseConfig, pollIntervalMs: 1 });
    const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
    const imgFetcher6c = makeMockFetcher([{ match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
    const imgDeps6c = { fetchImpl: imgFetcher6c, config: imageConfig };

    // 造一个 2 页全成功的单页项目
    const sp1 = await singlePages.generateSinglePage(uid, { pageId: 'sp-ed-1', title: 'S1', content: '单页可编辑第一页' }, imgDeps6c);
    const sp2 = await singlePages.generateSinglePage(uid, { pageId: 'sp-ed-2', title: 'S2', content: '单页可编辑第二页', projectId: sp1.page.projectId }, imgDeps6c);
    const spProject = sp1.page.projectId;
    check('单页项目 2 页均成功且同项目', sp1.status === 'succeeded' && sp2.status === 'succeeded' && sp2.page.projectId === spProject);
    credits.refundCredits(uid, 100, { reason: '测试补贴', idempotencyKey: 'test-topup-6c' });

    // ---- 成功链：读单页图 → PDF → 上传 → 建任务 → poll → 落盘 ----
    {
      let pollN = 0;
      const createInits = [];
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/', payload: () => ((pollN += 1) === 1
            ? { code: 0, message: 'ok', data: { status: 'pending' } }
            : { code: 0, message: 'ok', data: { status: 'succeeded', result: { ppt_url: 'http://mock-codia/files/sp1.pptx', page_count: 2 } } }) },
        { match: '/v2/open/tasks', payload: (init) => {
            createInits.push(init);
            return { code: 0, message: 'ok', data: { task_id: 'task_sp1', status: 'pending' } };
          } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_sp' } } },
        { match: 'sp1.pptx', payload: new Response(Buffer.from('mock-sp-pptx-binary')) },
      ]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startSinglePageEditableExport(uid, spProject, codiaDeps(fetcher));
      check('单页可编辑发起：processing + 40🌟（20×2页）',
        started.status === 'processing' && started.credits === 40 && started.pageCount === 2);
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('单页转换成功落盘', exp.status === 'succeeded' && exp.url.startsWith('/api/files/exports/'), `实际 ${exp.status} ${exp.error || ''}`);
      check('净扣 40🌟', before - credits.getBalance(uid) === 40, `before=${before} after=${credits.getBalance(uid)}`);
      const row = genDb.prepare('SELECT ref_type, ref_id FROM export_jobs WHERE id = ?').get(started.exportId);
      check('export_jobs 行 ref_type=single-page', row?.ref_type === 'single-page' && row?.ref_id === spProject);
      const createBody = JSON.parse(createInits[0].body);
      check('建任务 page_no [0,1] + 幂等键', JSON.stringify(createBody.input.page_no) === '[0,1]'
        && createInits[0].headers['Idempotency-Key'] === `anppt-editable-${started.exportId}`);
    }

    // ---- 两次 failed → 退星 + failed ----
    {
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/', payload: { code: 0, message: 'ok', data: { status: 'failed', error: 'mock 持续失败' } } },
        { match: '/v2/open/tasks', payload: { code: 0, message: 'ok', data: { task_id: 'task_spf', status: 'pending' } } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_spf' } } },
      ]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startSinglePageEditableExport(uid, spProject, codiaDeps(fetcher), { force: true });
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('单页两次失败 → failed + 全额退星', exp.status === 'failed' && credits.getBalance(uid) === before, `实际 ${exp.status} ${exp.error || ''}`);
      check('refund 键唯一', Number(genDb.prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE idempotency_key = ?')
        .get(credits.deriveRefundKey(`export-editable:${spProject}:${started.exportId}`))?.c || 0) === 1);
    }

    // ---- 余额不足 402：先校验再建行，不产生 export 行 ----
    {
      const poorE = await auth.registerWithPassword(
        { account: 'sppoor', password: 'password123', confirmPassword: 'password123' },
        '127.0.0.1',
      );
      const g = await singlePages.generateSinglePage(poorE.user.id, { pageId: 'sp-poor-1', content: '穷人单页' }, imgDeps6c);
      check('穷人单页生成成功', g.status === 'succeeded');
      credits.debitCredits(poorE.user.id, 75, { reason: '测试花掉', idempotencyKey: 'test-drain-6c' });
      // 100（注册） - 10（生成 1 页） - 75 = 15 < 20（可编辑需 20×1）
      await expectThrows('余额 15 < 20 → 402 INSUFFICIENT_CREDITS', () =>
        exportsLib.startSinglePageEditableExport(poorE.user.id, g.page.projectId, codiaDeps(makeMockFetcher([]))), 'INSUFFICIENT_CREDITS');
      const rows = Number(genDb.prepare("SELECT COUNT(*) AS c FROM export_jobs WHERE ref_id = ? AND kind = 'editable'").get(g.page.projectId)?.c || 0);
      check('402 后不产生 export 行', rows === 0, `实际 ${rows}`);
    }

    // ---- 页数门：单页项目与整套同一口径（按已配置通道能力）----
    {
      credits.refundCredits(uid, 300, { reason: '单页页数门测试补贴', idempotencyKey: 'test-topup-sp-page-cap' });
      let projectId = '';
      for (let index = 0; index < 21; index += 1) {
        const g = await singlePages.generateSinglePage(uid, {
          pageId: `sp-cap-${index}`, title: `上限${index}`, content: `单页页数门夹具第 ${index} 页`, projectId,
        }, imgDeps6c);
        projectId = g.page.projectId;
      }
      let rejected = null;
      try {
        await exportsLib.startSinglePageEditableExport(uid, projectId, codiaDeps(makeMockFetcher([])));
      } catch (error) {
        rejected = error;
      }
      check('单页项目 21 页同样按通道能力拒绝（只配置 Codia → 20）',
        rejected?.code === 'EXPORT_TOO_MANY_PAGES'
          && rejected?.message === '单套最多 20 页可转可编辑，当前共 21 页',
        `${rejected?.code} ${rejected?.message}`);
    }

    // ---- 并发：processing 中再次 start → 409 EXPORT_RUNNING ----
    {
      let release = false;
      const fetcher = makeMockFetcher([
        { match: '/v2/open/tasks/', payload: () => (release
            ? { code: 0, message: 'ok', data: { status: 'failed', error: 'mock 收尾失败' } }
            : { code: 0, message: 'ok', data: { status: 'pending' } }) },
        { match: '/v2/open/tasks', payload: { code: 0, message: 'ok', data: { task_id: 'task_spc', status: 'pending' } } },
        { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_spc' } } },
      ]);
      const started = await exportsLib.startSinglePageEditableExport(uid, spProject, codiaDeps(fetcher), { force: true });
      const reused = await exportsLib.startSinglePageEditableExport(uid, spProject, codiaDeps(fetcher));
      check('processing 中再次 start → 复用同一任务且不扣星', reused.exportId === started.exportId && reused.reused && reused.credits === 0);
      release = true;
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('收尾：并发用例终态 failed + 已退星', exp.status === 'failed');
    }

    // ---- 越权/不存在 ----
    {
      await expectThrows('他人单页项目 404', () =>
        exportsLib.startSinglePageEditableExport('other-user', spProject, codiaDeps(makeMockFetcher([]))), 'PROJECT_NOT_FOUND');
      await expectThrows('不存在项目 404', () =>
        exportsLib.startSinglePageEditableExport(uid, 'proj_nope', codiaDeps(makeMockFetcher([]))), 'PROJECT_NOT_FOUND');
    }
  }


  console.log('\n[6d] 外部 PDF/图片转可编辑 + 文件 Range 流式下载');
  {
    credits.refundCredits(uid, 100, { reason: '测试补贴', idempotencyKey: 'test-topup-6d' });
    const token = auth.createSessionForUser(uid);
    const uploadDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
    let taskBody = null;
    const binary = Buffer.from('0123456789-upload-editable-pptx');
    const fetcher = makeMockFetcher([
      { match: '/v2/open/tasks/task_upload', payload: { code: 0, message: 'ok', data: {
        status: 'succeeded', progress: 1, completed_pages: 2, total_pages: 2,
        result: { ppt_url: 'http://mock-codia/files/upload.pptx', page_count: 2 },
      } } },
      { match: '/v2/open/tasks', payload: (init) => {
        taskBody = JSON.parse(init.body);
        return { code: 0, message: 'ok', data: { task_id: 'task_upload', status: 'pending' } };
      } },
      { match: '/v2/open/uploads', payload: { code: 0, message: 'ok', data: { upload_id: 'upl_external' } } },
      { match: 'upload.pptx', payload: new Response(binary) },
    ]);
    const before = credits.getBalance(uid);
    const started = await exportsLib.startUploadedEditableExport(uid, [
      { name: '01.png', mime: 'image/png', data: Buffer.from(PNG_1X1_B64, 'base64') },
      { name: '02.png', mime: 'image/png', data: Buffer.from(PNG_1X1_B64, 'base64') },
    ], { fetchImpl: fetcher, config: baseConfig, pollIntervalMs: 1 });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId);
    const uploadSourceRow = uploadDb.prepare('SELECT source_path FROM export_jobs WHERE id = ?').get(started.exportId);
    const uploadSourceAbs = path.join(baseConfig.uploadsDir, String(uploadSourceRow?.source_path || '').split('/').slice(1).join('/'));
    check('两张图片成功转为 2 页可编辑 PPTX', exp.status === 'succeeded' && exp.pageCount === 2 && exp.refType === 'upload');
    check('外部转换按 20🌟/页扣 40', before - credits.getBalance(uid) === 40);
    check('图片顺序映射为 page_no [0,1]', JSON.stringify(taskBody?.input?.page_no) === '[0,1]');
    check('下载中心保留外部来源名', exp.sourceName === '2 张图片');
    check('外部转换终态后清理临时 PDF 源文件', !existsSync(uploadSourceAbs));
    const reused = await exportsLib.startUploadedEditableExport(uid, [
      { name: '01.png', mime: 'image/png', data: Buffer.from(PNG_1X1_B64, 'base64') },
      { name: '02.png', mime: 'image/png', data: Buffer.from(PNG_1X1_B64, 'base64') },
    ], { fetchImpl: fetcher, config: baseConfig, pollIntervalMs: 1 });
    check('重复上传相同内容复用成功结果且不扣星', reused.reused && reused.exportId === started.exportId && reused.credits === 0);
    check('复用成功结果不会遗留重复源文件', !existsSync(uploadSourceAbs));

    // ---- 上传 PDF 页数门：同样按已配置通道能力拒绝 ----
    {
      const { createRequire } = await import('node:module');
      const { PDFDocument } = createRequire(import.meta.url)('pdf-lib');
      const makePdf = async (pageCount) => {
        const document = await PDFDocument.create();
        for (let index = 0; index < pageCount; index += 1) document.addPage([640, 360]);
        return Buffer.from(await document.save());
      };
      const rejectedCodia = await (async () => {
        try {
          await exportsLib.startUploadedEditableExport(uid, [
            { name: 'many.pdf', mime: 'application/pdf', data: await makePdf(21) },
          ], { fetchImpl: makeMockFetcher([]), config: baseConfig, pollIntervalMs: 1 });
          return null;
        } catch (error) {
          return error;
        }
      })();
      check('上传 21 页 PDF：只配置 Codia 时按能力 20 拒绝',
        rejectedCodia?.code === 'EXPORT_TOO_MANY_PAGES'
          && rejectedCodia?.message === '单次最多 20 页可转可编辑，当前共 21 页',
        `${rejectedCodia?.code} ${rejectedCodia?.message}`);
      const i2pConfig = { ...baseConfig, image2pptApiKey: 'i2p-page-cap-key', editableProvider: 'image2ppt' };
      const rejectedI2p = await (async () => {
        try {
          await exportsLib.startUploadedEditableExport(uid, [
            { name: 'many.pdf', mime: 'application/pdf', data: await makePdf(51) },
          ], { fetchImpl: makeMockFetcher([]), config: i2pConfig, pollIntervalMs: 1 });
          return null;
        } catch (error) {
          return error;
        }
      })();
      check('上传 51 页 PDF：配置 Image2PPT 时按能力 50 拒绝',
        rejectedI2p?.code === 'EXPORT_TOO_MANY_PAGES'
          && rejectedI2p?.message === '单次最多 50 页可转可编辑，当前共 51 页',
        `${rejectedI2p?.code} ${rejectedI2p?.message}`);
    }

    const poorUpload = await auth.registerWithPassword(
      { account: 'uploadpoor', password: 'password123', confirmPassword: 'password123' },
      '127.0.0.1',
    );
    await expectThrows('外部转换余额不足时不建任务', () =>
      exportsLib.startUploadedEditableExport(
        poorUpload.user.id,
        Array.from({ length: 6 }, (_, index) => ({
          name: `${index + 1}.png`, mime: 'image/png', data: Buffer.from(PNG_1X1_B64, 'base64'),
        })),
        { fetchImpl: makeMockFetcher([]), config: baseConfig, pollIntervalMs: 1 },
      ), 'INSUFFICIENT_CREDITS');
    const poorSourceDir = path.join(baseConfig.uploadsDir, poorUpload.user.id, 'editable-sources');
    check('外部转换启动失败时清理临时 PDF', !existsSync(poorSourceDir) || readdirSync(poorSourceDir).length === 0);

    const editableRoute = await import('../../src/app/api/editable-conversions/route.ts');
    const oldUploadLimit = process.env.ANPPT_V2_UPLOAD_MAX_BYTES;
    process.env.ANPPT_V2_UPLOAD_MAX_BYTES = '16';
    try {
      const oversizedForm = new FormData();
      oversizedForm.append('files', new File([Buffer.alloc(32)], 'oversized.png', { type: 'image/png' }));
      const oversizedResponse = await editableRoute.POST(new Request('http://localhost/api/editable-conversions', {
        method: 'POST',
        headers: { cookie: `anppt_v2_session=${token}`, 'x-anppt-action': '1' },
        body: oversizedForm,
      }));
      check('外部上传在读取 Buffer 前按 File.size 返回 413', oversizedResponse.status === 413);
    } finally {
      if (oldUploadLimit === undefined) delete process.env.ANPPT_V2_UPLOAD_MAX_BYTES;
      else process.env.ANPPT_V2_UPLOAD_MAX_BYTES = oldUploadLimit;
    }

    // 路由层文件数上限跟随通道能力（Codia-only → 20），不再有写死的 20 常量
    {
      const manyForm = new FormData();
      for (let index = 0; index < 21; index += 1) {
        manyForm.append('files', new File([Buffer.from(PNG_1X1_B64, 'base64')], `${index + 1}.png`, { type: 'image/png' }));
      }
      const manyResponse = await editableRoute.POST(new Request('http://localhost/api/editable-conversions', {
        method: 'POST',
        headers: { cookie: `anppt_v2_session=${token}`, 'x-anppt-action': '1' },
        body: manyForm,
      }));
      const manyJson = await manyResponse.json();
      check('外部上传文件数按当前通道能力拒绝（只配置 Codia → 20 张）',
        manyResponse.status === 400
          && manyJson?.error?.code === 'EXPORT_TOO_MANY_PAGES'
          && manyJson?.error?.message === '单次最多 20 个图片文件'
          && !/codia|image2ppt|wps/i.test(String(manyJson?.error?.message)),
        `${manyResponse.status} ${manyJson?.error?.message}`);
      const routeSource = readFileSync(new URL('../../src/app/api/editable-conversions/route.ts', import.meta.url), 'utf8');
      check('上传路由不再自带页数常量：文件数上限读通道能力',
        routeSource.includes('editablePageCapacity')
          && !/MAX_UPLOAD_FILES\s*=/.test(routeSource));
    }

    // 对外文案：可编辑上限 50 + 通道能力口径（help / FAQ / about / legal / 上传页）
    {
      const copyOf = (relPath) => readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf8');
      const help = copyOf('src/app/(main)/help/page.tsx');
      const about = copyOf('src/app/(main)/about/page.tsx');
      const marketing = copyOf('src/components/home/marketing-sections.tsx');
      const converter = copyOf('src/modules/editable-export/client/editable-converter-client.tsx');
      const legalTerms = copyOf('src/app/(main)/legal/terms/page.tsx');
      const uploadCard = copyOf('src/components/home/upload-card.tsx');
      check('help 文案：可编辑单次上限 50 页且不再写 20',
        help.includes('单次最多 50 页') && !help.includes('单次最多 20 页') && !help.includes('超过 20 页'));
      check('about 文案：可编辑单次上限 50 页',
        about.includes('单次最多 50 页') && !about.includes('单次最多 20 页'));
      check('首页 FAQ 文案：可编辑单次上限 50 页',
        marketing.includes('单次最多 50 页') && !marketing.includes('单次最多 20 页'));
      check('上传页文案与客户端上限：50 张图片',
        converter.includes('最多 50 张') && converter.includes('const MAX_FILES = 50;') && !converter.includes('最多 20 张'));
      check('服务条款带通道能力口径',
        legalTerms.includes('页数上限') && legalTerms.includes('转换通道'));
      check('上传卡片不再提示「超过 20 页暂不支持转可编辑」（整套上限 40 页在可编辑能力内）',
        !uploadCard.includes('超过 20 页暂不支持转可编辑'));
    }

    const fileRoute = await import('../../src/app/api/files/[...path]/route.ts');
    const segments = exp.url.replace('/api/files/', '').split('/');
    const rangeResponse = await fileRoute.GET(new Request(`http://localhost${exp.url}`, {
      headers: { cookie: `anppt_v2_session=${token}`, range: 'bytes=2-7' },
    }), { params: Promise.resolve({ path: segments }) });
    check('Range 下载返回 206 + 正确 Content-Range', rangeResponse.status === 206
      && rangeResponse.headers.get('content-range') === `bytes 2-7/${binary.length}`);
    check('Range 下载只返回指定字节', Buffer.from(await rangeResponse.arrayBuffer()).equals(binary.subarray(2, 8)));
    const headResponse = await fileRoute.HEAD(new Request(`http://localhost${exp.url}`, {
      method: 'HEAD', headers: { cookie: `anppt_v2_session=${token}` },
    }), { params: Promise.resolve({ path: segments }) });
    check('HEAD 返回文件长度且无正文', headResponse.status === 200
      && Number(headResponse.headers.get('content-length')) === binary.length
      && (await headResponse.arrayBuffer()).byteLength === 0);
    const invalidRange = await fileRoute.GET(new Request(`http://localhost${exp.url}`, {
      headers: { cookie: `anppt_v2_session=${token}`, range: `bytes=${binary.length + 1}-` },
    }), { params: Promise.resolve({ path: segments }) });
    check('越界 Range 返回 416', invalidRange.status === 416
      && invalidRange.headers.get('content-range') === `bytes */${binary.length}`);
  }

  console.log('\n[6e] 轻量文字可编辑导出（VLM 覆盖层，mock 零真实调用）');
  {
    const genDb = (await import('../../src/lib/server/generation/db.ts')).getGenDb();
    const textDeps = (fetchImpl) => ({
      fetchImpl,
      config: {
        ...llmConfig,
        llmModel: 'vlm-primary',
        llmFallbackModels: ['vlm-fb1', 'vlm-fb2'],
      },
    });
    const textLedgerKeys = () =>
      genDb.prepare('SELECT idempotency_key FROM credit_ledger WHERE user_id = ?').all(uid).map((r) => String(r.idempotency_key));

    check('estimateCredits：export_editable_text 按页计价（3 页 = 15）',
      credits.estimateCredits({ action: 'export_editable_text', pages: 3 }).credits === 15);

    const VLM_BLOCKS = [
      { text: '年度销售汇报', box: [0.1, 0.08, 0.6, 0.14], fontSize: 0.07, color: '1a2b3c', bold: true, align: 'center' },
      { text: '销售额 1200 万元\n同比增长 20%', box: [0.08, 0.35, 0.4, 0.3], fontSize: 0.04, color: '#334455', bold: false, align: 'left' },
    ];
    const vlmOkPayload = {
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(VLM_BLOCKS)}\n\`\`\`` } }],
      usage: { prompt_tokens: 1200, completion_tokens: 200 },
    };

    // ---- 成功链：VLM 提取 → 底色采样 → 合成落盘 ----
    {
      const fetcher = makeMockFetcher([{ match: '/chat/completions', payload: vlmOkPayload }]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startDeckTextEditableExport(uid, deck.id, textDeps(fetcher), { force: true });
      check('文字可编辑发起：processing + 10🌟（5×2页）',
        started.status === 'processing' && started.credits === 10 && started.pageCount === 2);
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('文字可编辑转换成功落盘', exp.status === 'succeeded' && exp.url.startsWith('/api/files/exports/'), `实际 ${exp.status} ${exp.error || ''}`);
      check('净扣 10🌟', before - credits.getBalance(uid) === 10, `before=${before} after=${credits.getBalance(uid)}`);
      check('ledger 键 export-editable-text 前缀唯一',
        textLedgerKeys().filter((k) => k === `export-editable-text:${deck.id}:${started.exportId}`).length === 1);
      check('导出记录 kind=editable_text', exp.kind === 'editable_text');

      const rel = exp.url.replace('/api/files/', '');
      const pptxBuf = readFileSync(path.join(baseConfig.exportsDir, rel.split('/').slice(1).join('/')));
      const { createRequire: createReq } = await import('node:module');
      const reqJszip = createReq(path.join(process.cwd(), 'package.json'));
      const JSZip = reqJszip('jszip');
      const zip = await JSZip.loadAsync(pptxBuf);
      const slide1 = await zip.file('ppt/slides/slide1.xml').async('string');
      check('slide1 XML 含 VLM 提取的文字（可编辑文本框）', slide1.includes('年度销售汇报') && slide1.includes('销售额 1200 万元'));
      check('slide1 XML 含覆盖底色块与提取色值', slide1.includes('solidFill') && slide1.includes('1A2B3C'));

      const reused = await exportsLib.startDeckTextEditableExport(uid, deck.id, textDeps(fetcher));
      check('同源成功结果默认复用：同 exportId、0 扣星',
        reused.exportId === started.exportId && reused.reused && reused.credits === 0);
      const listText = exportsLib.listExports(uid, { refType: 'deck', refId: deck.id, kind: 'editable_text' });
      const listHeavy = exportsLib.listExports(uid, { refType: 'deck', refId: deck.id, kind: 'editable' });
      check('导出中心按 kind 分流：文字档与 Codia 档互不串扰',
        listText.items.length >= 1 && listText.items.every((i) => i.kind === 'editable_text')
          && listHeavy.items.length >= 1 && listHeavy.items.every((i) => i.kind === 'editable'));
    }

    // ---- 部分页 VLM 失败（首页 3 候选全挂）：该页降级纯图片，整体仍成功 ----
    {
      let n = 0;
      const fetcher = makeMockFetcher([{ match: '/chat/completions', payload: () => {
        n += 1;
        if (n <= 3) throw new Error('mock VLM 抖动');
        return vlmOkPayload;
      } }]);
      const started = await exportsLib.startDeckTextEditableExport(uid, deck.id, textDeps(fetcher), { force: true });
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('单页 VLM 失败降级为纯图片页，整体仍成功', exp.status === 'succeeded', `实际 ${exp.status} ${exp.error || ''}`);
    }

    // ---- 全部页 VLM 失败：failed + 全额退星 ----
    {
      const fetcher = makeMockFetcher([]);
      const before = credits.getBalance(uid);
      const started = await exportsLib.startDeckTextEditableExport(uid, deck.id, textDeps(fetcher), { force: true });
      await started.done;
      const exp = await exportsLib.getExport(uid, started.exportId);
      check('全部页 VLM 失败 → failed + 全额退星',
        exp.status === 'failed' && exp.error.includes('已退回') && credits.getBalance(uid) === before, `实际 ${exp.status} ${exp.error || ''}`);
      check('refund 键唯一（export-editable-text）',
        textLedgerKeys().filter((k) => k === credits.deriveRefundKey(`export-editable-text:${deck.id}:${started.exportId}`)).length === 1);
    }

    // ---- 文字档页数上限取产品口径 50：不继承 Codia 的 20，也不看通道配置 ----
    {
      const textSourceImage = genDb
        .prepare(
          `SELECT sv.image_path AS imagePath
           FROM deck_slides ds
           JOIN slide_versions sv ON sv.id = ds.active_version_id
           WHERE ds.deck_id = ? AND sv.image_path <> ''
           ORDER BY ds.page_index LIMIT 1`,
        )
        .get(deck.id)?.imagePath;
      if (!textSourceImage) throw new Error('文字档上限夹具缺少源页图');
      const makeTextDeck = (pageCount) => {
        const created = decks.createDeck(uid, {
          title: `${pageCount}页文字档上限`,
          sourceFileName: '',
          sourceText: 'x',
          durationMinutes: 30,
          targetPageCount: pageCount,
          qualityTier: 'standard',
          stylePackId: '',
        });
        genDb.prepare("UPDATE decks SET status = 'generated' WHERE id = ?").run(created.id);
        const now = Date.now();
        const insSlide = genDb.prepare(
          `INSERT INTO deck_slides (id, deck_id, page_index, gen_status, active_version_id, created_at, updated_at)
           VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`,
        );
        const insVersion = genDb.prepare(
          `INSERT INTO slide_versions
            (id, slide_id, deck_id, version_no, kind, status, image_path, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'generate', 'succeeded', ?, ?, ?)`,
        );
        for (let index = 0; index < pageCount; index += 1) {
          const slideId = `${created.id}_s${index}`;
          const versionId = `${created.id}_v${index}`;
          insSlide.run(slideId, created.id, index, versionId, now + index, now + index);
          insVersion.run(versionId, slideId, created.id, textSourceImage, now + index, now + index);
        }
        return created;
      };

      credits.refundCredits(uid, 400, { reason: '文字档上限测试补贴', idempotencyKey: 'test-topup-text-page-cap' });
      const d50 = makeTextDeck(50);
      const started50 = await exportsLib.startDeckTextEditableExport(uid, d50.id, textDeps(makeMockFetcher([])), { force: true });
      check('文字可编辑档 50 页可发起（Codia-only 配置也不因 20 被拒）',
        started50.pageCount === 50 && started50.credits === 250 && started50.status === 'processing',
        `${started50.pageCount} ${started50.status} ${started50.credits}`);
      await started50.done;

      const d51 = makeTextDeck(51);
      let rejected = null;
      try {
        await exportsLib.startDeckTextEditableExport(uid, d51.id, textDeps(makeMockFetcher([])), { force: true });
      } catch (error) {
        rejected = error;
      }
      check('文字可编辑档 51 页按产品上限 50 被拒',
        rejected?.code === 'EXPORT_TOO_MANY_PAGES'
          && rejected?.message === '单套最多 50 页可转可编辑，当前共 51 页',
        `${rejected?.code} ${rejected?.message}`);
    }

    // ---- 余额不足 402：先校验再建行，不产生 export 行 ----
    {
      const poorT = await auth.registerWithPassword(
        { account: 'textpoor', password: 'password123', confirmPassword: 'password123' },
        '127.0.0.1',
      );
      const okFetcher6e = makeMockFetcher([...engineHandlers, { match: '/images/generations', payload: { data: [{ b64_json: PNG_1X1_B64 }] } }, editsOkHandler]);
      const okDeps6e = { fetchImpl: okFetcher6e, config: engineConfig };
      const pd = decks.createDeck(poorT.user.id, {
        title: '穷人文字档', sourceFileName: '', sourceText: '内容',
        durationMinutes: 15, targetPageCount: 2, qualityTier: 'standard', stylePackId: '',
      });
      await actions.dispatchDeckIntent(poorT.user.id, pd.id, { kind: 'generateOutline', params: {} }, okDeps6e);
      await actions.dispatchDeckIntent(poorT.user.id, pd.id, { kind: 'structureSlides', params: {} }, okDeps6e);
      await actions.dispatchDeckIntent(poorT.user.id, pd.id, { kind: 'confirmStructure', params: {} }, okDeps6e);
      await actions.dispatchDeckIntent(poorT.user.id, pd.id, { kind: 'setStyle', params: { stylePackId: STYLE_PACKS[0].id } }, okDeps6e);
      const g = await actions.dispatchDeckIntent(poorT.user.id, pd.id, { kind: 'generateSlides', params: {} }, okDeps6e);
      await g.job.done;
      check('穷人文字档 deck 生成全绿', decks.getDeckState(poorT.user.id, pd.id).deck.status === 'generated');
      credits.debitCredits(poorT.user.id, 75, { reason: '测试花掉', idempotencyKey: 'test-drain-6e' });
      // 100（注册） - 20（生成 2 页） - 75 = 5 < 10（文字可编辑需 5×2）
      await expectThrows('余额 5 < 10 → 402 INSUFFICIENT_CREDITS', () =>
        exportsLib.startDeckTextEditableExport(poorT.user.id, pd.id, textDeps(makeMockFetcher([]))), 'INSUFFICIENT_CREDITS');
      const textRows = Number(
        genDb.prepare("SELECT COUNT(*) AS c FROM export_jobs WHERE ref_id = ? AND kind = 'editable_text'").get(pd.id)?.c || 0,
      );
      check('402 后不产生 editable_text 行', textRows === 0, `实际 ${textRows}`);
    }

    // ---- 路由层开关门：普通用户 404（不暴露功能存在），测试用户过门后才走到 deck 校验 ----
    {
      const flagsLib = await import('../../src/lib/server/feature-flags.ts');
      check('editable_text_overlay 默认 beta 态', flagsLib.getFeatureFlagState('editable_text_overlay') === 'beta');
      const textRoute = await import('../../src/app/api/deck/[id]/export-editable-text/route.ts');
      const gateUser = await auth.registerWithPassword(
        { account: 'flaggate01', password: 'password123', confirmPassword: 'password123' },
        '127.0.0.1',
      );
      const gateRequest = () => new Request('http://localhost/api/deck/deck_nope/export-editable-text', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-anppt-action': '1',
          cookie: `anppt_v2_session=${auth.createSessionForUser(gateUser.user.id)}`,
        },
        body: JSON.stringify({
          intent: { kind: 'exportDeckTextEditable', params: { deckId: 'deck_nope' } },
        }),
      });
      const denied = await textRoute.POST(gateRequest(), { params: Promise.resolve({ id: 'deck_nope' }) });
      const deniedJson = await denied.json();
      check('普通用户访问文字可编辑路由 → 404 NOT_FOUND（功能不可见）',
        denied.status === 404 && deniedJson?.error?.code === 'NOT_FOUND', `实际 ${denied.status} ${deniedJson?.error?.code}`);
      genDb.prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(gateUser.user.id);
      const passedGate = await textRoute.POST(gateRequest(), { params: Promise.resolve({ id: 'deck_nope' }) });
      const passedJson = await passedGate.json();
      check('测试用户过开关门 → 落到 DECK_NOT_FOUND（证明门已过）',
        passedGate.status === 404 && passedJson?.error?.code === 'DECK_NOT_FOUND', `实际 ${passedGate.status} ${passedJson?.error?.code}`);
    }
  }


}
