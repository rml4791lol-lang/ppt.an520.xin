// WPS AIPPT 可编辑转换通道：内部上传 + SSE 转换 + provider 优先级/回退，全 mock。
import { startEditableWithDone } from './editable-start-helpers.mjs';

export async function runWpsAipptTests(ctx) {
  const { check, baseConfig, credits, uid, deck, jsonResponse } = ctx;
  const exportsLib = await import('../../src/modules/editable-export/server/editable.ts');
  // 单入口测试垫片：生产句柄不再带 done，靠注入 deps.onPipelineDone 等管线结束。
  const startDeckEditableFor = (userId, deckId, deps = {}, options = {}) =>
    startEditableWithDone(exportsLib, exportsLib.deckEditableSource(userId, deckId), 'editable', deps, options);
  const wps = await import('../../src/modules/editable-export/server/wps-aippt.ts');
  const { getGenDb } = await import('../../src/lib/server/generation/db.ts');

  console.log('\n[6g] WPS AIPPT 可编辑转换通道（全 mock）');
  const wpsConfig = {
    ...baseConfig,
    editableProvider: 'wps',
    codiaApiKey: '',
    image2pptApiKey: '',
    wpsAipptCookie: 'wps_sid=wps-test; kso_sid=kso-test; uid=1',
    wpsAipptBaseUrl: 'https://wps-aippt.test',
    wpsAipptTimeoutMs: 30_000,
  };
  const sse = [
    'data:{"type":"convert2pptx_start","code":0,"data":null}',
    '',
    'data:{"type":"convert2pptx_created","code":0,"data":{"doc_id":"doc_wps_1"}}',
    '',
    'data:{"type":"convert2pptx_progress","code":0,"data":{"doc_id":"doc_wps_1","progress":40,"status":2}}',
    '',
    'data:{"type":"convert2pptx_finish","code":0,"data":{"doc_id":"doc_wps_1","status":1,"progress":100,"page_count":2,"file_url":"https://wps-aippt.test/result.pptx"}}',
    '',
    '',
  ].join('\n');

  const makeWpsFetcher = (calls = []) => async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.endsWith('/api/ks3/api/ksyun/ks3/token_by_kso')) {
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          is_file_exist: false,
          request: {
            method: 'PUT',
            headers: { authorization: 'KSS test', host: 'mock-ks3.test' },
            object_key: 'temp/20261020/pdf/deck.pdf',
            object_url: 'https://mock-ks3.test/upload',
          },
        },
      });
    }
    if (href === 'https://mock-ks3.test/upload') return new Response('', { status: 200 });
    if (href.endsWith('/api/structppt/convert_pptx')) {
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (href === 'https://wps-aippt.test/result.pptx') return new Response(Buffer.from('PK-wps-pptx'));
    throw new Error(`WPS mock 未命中: ${href}`);
  };

  {
    const calls = [];
    const progress = [];
    const result = await wps.convertPdfWithWpsAippt(Buffer.from('%PDF-1.4 wps test'), 'deck.pdf', {
      fetchImpl: makeWpsFetcher(calls),
      config: wpsConfig,
      onProgress: (value) => progress.push(value),
    });
    const tokenCall = calls[0];
    const convertCall = calls.find((call) => call.href.endsWith('/api/structppt/convert_pptx'));
    const tokenBody = JSON.parse(tokenCall.init.body);
    const convertBody = JSON.parse(convertCall.init.body);
    check('WPS 内部链路：换取上传凭证 → PUT → SSE → 下载 PPTX',
      result.bytes.toString() === 'PK-wps-pptx'
        && result.pageCount === 2
        && result.docId === 'doc_wps_1'
        && calls.length === 4);
    check('WPS token 请求带 Cookie 且按 PDF 元数据取上传地址',
      String(tokenCall.init.headers.cookie).includes('wps_sid=wps-test')
        && tokenBody.filename === 'deck.pdf'
        && tokenBody.content_type === 'text/plain');
    check('WPS 转换请求使用 pdf_object_key + 文件名/大小，并带进度',
      convertBody.pdf_object_key === 'temp/20261020/pdf/deck.pdf'
        && convertBody.file_name === 'deck.pdf'
        && convertBody.file_size === Buffer.byteLength('%PDF-1.4 wps test')
        && progress.includes(40));
  }

  {
    getGenDb().prepare("DELETE FROM export_jobs WHERE user_id = ? AND ref_type = 'deck' AND ref_id = ? AND kind = 'editable'").run(uid, deck.id);
    credits.refundCredits(uid, 200, { reason: 'WPS 测试补贴', idempotencyKey: 'test-topup-wps' });
    const before = credits.getBalance(uid);
    const calls = [];
    const started = await startDeckEditableFor(uid, deck.id, { fetchImpl: makeWpsFetcher(calls), config: wpsConfig, pollIntervalMs: 1 },
      { force: true },
    );
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId);
    const row = getGenDb().prepare('SELECT upstream_provider, upstream_task_id, file_url FROM export_jobs WHERE id = ?').get(started.exportId);
    check('WPS 作为主通道成功落盘并记录 provider 与 doc_id',
      exp.status === 'succeeded'
        && exp.url.startsWith('/api/files/exports/')
        && row?.upstream_provider === 'wps'
        && row?.upstream_task_id === 'wps:doc_wps_1'
        && row?.file_url === exp.url);
    check('WPS 成功仍按站内规则净扣 40🌟', before - credits.getBalance(uid) === 40);
    check('WPS 成功后不再调用 Image2PPT/Codia',
      calls.every((call) => !call.href.includes('/api/v1/jobs') && !call.href.includes('/v2/open/')));
  }

  {
    getGenDb().prepare("DELETE FROM export_jobs WHERE user_id = ? AND ref_type = 'deck' AND ref_id = ? AND kind = 'editable'").run(uid, deck.id);
    credits.refundCredits(uid, 200, { reason: 'WPS 回退测试补贴', idempotencyKey: 'test-topup-wps-fallback' });
    let codiaPoll = 0;
    const calls = [];
    const fetcher = async (url, init = {}) => {
      const href = String(url);
      calls.push({ href, init });
      if (href.endsWith('/api/ks3/api/ksyun/ks3/token_by_kso')) {
        return jsonResponse({ code: 1011, msg: 'invalid wps sid' });
      }
      if (href.includes('/v2/open/uploads')) return jsonResponse({ code: 0, data: { upload_id: 'upl_wps_fallback' } });
      if (href.endsWith('/v2/open/tasks')) return jsonResponse({ code: 0, data: { task_id: 'task_wps_fallback' } });
      if (href.includes('/v2/open/tasks/task_wps_fallback')) {
        codiaPoll += 1;
        return jsonResponse({ code: 0, data: codiaPoll === 1
          ? { status: 'pending' }
          : { status: 'succeeded', result: { ppt_url: 'https://mock-codia.test/fallback.pptx', page_count: 2 } } });
      }
      if (href === 'https://mock-codia.test/fallback.pptx') return new Response(Buffer.from('PK-codia-pptx'));
      throw new Error(`fallback mock 未命中: ${href}`);
    };
    const started = await startDeckEditableFor(uid, deck.id, {
      fetchImpl: fetcher,
      config: { ...wpsConfig, codiaApiKey: 'sk-codia-test', codiaBaseUrl: 'https://mock-codia.test' },
      pollIntervalMs: 1,
      retryDelayMs: 0,
    }, { force: true });
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId);
    const row = getGenDb().prepare('SELECT upstream_provider FROM export_jobs WHERE id = ?').get(started.exportId);
    check('WPS 登录态失效 → 自动回退 Codia 并成功', exp.status === 'succeeded' && row?.upstream_provider === 'codia');
    check('WPS 失败后确实改走 Codia 上传', calls.some((call) => call.href.includes('/v2/open/uploads')));
  }

  check('provider 顺序：wps 模式 = wps/image2ppt/codia',
    exportsLib.configuredEditableProviders({ ...wpsConfig, image2pptApiKey: 'i2p', codiaApiKey: 'codia' }).join('/') === 'wps/image2ppt/codia');
  check('provider 顺序：image2ppt 模式保留主通道并追加 WPS 回退',
    exportsLib.configuredEditableProviders({ ...wpsConfig, editableProvider: 'image2ppt', image2pptApiKey: 'i2p', codiaApiKey: 'codia' }).join('/') === 'image2ppt/wps/codia');

  {
    let calls = 0;
    const rateLimited = async () => {
      calls += 1;
      return jsonResponse({ code: 10712, msg: 'convert2pptxRateLimited' });
    };
    let firstCode = '';
    try {
      await wps.convertPdfWithWpsAippt(Buffer.from('%PDF rate limit'), 'rate-limit.pdf', {
        fetchImpl: rateLimited,
        config: wpsConfig,
      });
    } catch (error) {
      firstCode = String(error?.code || '');
    }
    let secondCode = '';
    try {
      await wps.convertPdfWithWpsAippt(Buffer.from('%PDF rate limit 2'), 'rate-limit-2.pdf', {
        fetchImpl: rateLimited,
        config: wpsConfig,
      });
    } catch (error) {
      secondCode = String(error?.code || '');
    }
    check('WPS 10712 映射为 429 并进入 10 分钟冷却，冷却期内不再打上游',
      firstCode === 'WPS_AIPPT_RATE_LIMITED'
        && secondCode === 'WPS_AIPPT_RATE_LIMITED'
        && calls === 1);
  }
}
