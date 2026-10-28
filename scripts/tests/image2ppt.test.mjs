// Image2PPT 可编辑转换通道测试：提交/轮询/下载/回调验签/主备切换，全 mock。
import { createHmac } from 'node:crypto';

export async function runImage2PptTests(ctx) {
  const {
    check, baseConfig, credits, uid, deck, makeMockFetcher,
  } = ctx;
  const exportsLib = await import('../../src/modules/editable-export/server/editable.ts');
  const i2p = await import('../../src/modules/editable-export/server/image2ppt.ts');
  const { getGenDb } = await import('../../src/lib/server/generation/db.ts');

  console.log('\n[6f] Image2PPT 可编辑转换通道（全 mock）');
  const i2pConfig = {
    ...baseConfig,
    codiaApiKey: '',
    editableProvider: 'image2ppt',
    image2pptApiKey: 'i2p-test-key',
    image2pptBaseUrl: 'https://image2ppt.test',
    image2pptWebhookSecret: 'whsec_dGVzdC13ZWJob29rLXNlY3JldC0zMi1ieXRlcy0hIQ==',
  };

  {
    const calls = [];
    const fetcher = makeMockFetcher([
      { match: '/api/v1/jobs/job_i2p_1', payload: {
        jobId: 'job_i2p_1', status: 'completed', progress: 100, slideCount: 2,
        creditsUsed: 2, creditsRefunded: 0,
        downloadUrl: '/api/v1/jobs/job_i2p_1/download',
        pageResults: [{ pageNumber: 1, status: 'converted' }, { pageNumber: 2, status: 'converted' }],
      } },
      { match: '/api/v1/jobs', payload: (init) => {
        calls.push(init);
        return { jobId: 'job_i2p_1', status: 'pending', slideCount: 2, creditsReserved: 2 };
      } },
    ]);
    const submitted = await i2p.submitJob({
      pdf: Buffer.from('mock-pdf'),
      filename: 'deck.pdf',
      pageCount: 2,
      idempotencyKey: 'anppt-editable-test',
      callbackUrl: 'https://ppt.example.com/api/webhooks/image2ppt',
    }, { fetchImpl: fetcher, config: i2pConfig, retryDelayMs: 0 });
    check('Image2PPT 提交带 Bearer + Idempotency-Key + multipart',
      submitted.jobId === 'job_i2p_1'
        && submitted.slideCount === 2
        && calls[0].headers.Authorization === 'Bearer i2p-test-key'
        && calls[0].headers['Idempotency-Key'] === 'anppt-editable-test'
        && calls[0].body instanceof FormData
        && String(calls[0].body.get('locale')) === 'zh-CN'
        && String(calls[0].body.get('callbackUrl')).includes('/api/webhooks/image2ppt'));
    const view = await i2p.getJob('job_i2p_1', { fetchImpl: fetcher, config: i2pConfig });
    check('Image2PPT 状态解析：completed + 绝对下载地址 + 页结果',
      view.status === 'completed'
        && view.progress === 100
        && view.downloadUrl === 'https://image2ppt.test/api/v1/jobs/job_i2p_1/download'
        && view.pageResults.length === 2);
  }

  {
    const secret = i2pConfig.image2pptWebhookSecret;
    const body = JSON.stringify({ type: 'job.completed', data: { jobId: 'job_sig', status: 'completed', progress: 100 } });
    const id = 'msg_test_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    const headers = new Headers({
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    });
    check('Image2PPT webhook 签名校验通过', i2p.verifyImage2PptWebhook(body, headers, secret));
    check('Image2PPT webhook 篡改正文被拒绝',
      !i2p.verifyImage2PptWebhook(body.replace('completed', 'failed'), headers, secret));
    const bad = await exportsLib.handleImage2PptWebhook(body, headers, { config: i2pConfig });
    check('Image2PPT webhook 无匹配任务仍返回 2xx（防重试风暴）', bad.status === 200);
    const invalid = await exportsLib.handleImage2PptWebhook(body, new Headers({ 'webhook-id': id }), { config: i2pConfig });
    check('Image2PPT webhook 缺签名返回 401', invalid.status === 401);
  }

  {
    const now = Date.now();
    const exportId = 'exp_i2p_webhook';
    getGenDb().prepare(
      `INSERT INTO export_jobs
        (id, user_id, ref_type, ref_id, kind, status, page_count, upstream_provider, upstream_task_id, charged_credits, created_at, updated_at)
       VALUES (?, ?, 'deck', ?, 'editable', 'processing', 2, 'image2ppt', 'job_webhook', 40, ?, ?)`,
    ).run(exportId, uid, deck.id, now, now);
    const fetcher = makeMockFetcher([
      { match: '/api/v1/jobs/job_webhook/download', payload: new Response(Buffer.from('webhook-pptx'), {
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      }) },
      { match: '/api/v1/jobs/job_webhook', payload: {
        jobId: 'job_webhook', status: 'completed', progress: 100, slideCount: 2,
        downloadUrl: '/api/v1/jobs/job_webhook/download',
      } },
    ]);
    const body = JSON.stringify({
      type: 'job.completed',
      data: { jobId: 'job_webhook', status: 'completed', progress: 100, slideCount: 2,
        downloadUrl: '/api/v1/jobs/job_webhook/download' },
    });
    const id = 'msg_webhook_1';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(i2pConfig.image2pptWebhookSecret.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
    const result = await exportsLib.handleImage2PptWebhook(body, new Headers({
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    }), { fetchImpl: fetcher, config: i2pConfig, retryDelayMs: 0 });
    const row = getGenDb().prepare('SELECT status, file_url FROM export_jobs WHERE id = ?').get(exportId);
    check('Image2PPT webhook 完成回调推进落盘',
      result.status === 200 && row?.status === 'succeeded' && String(row?.file_url).startsWith('/api/files/exports/'));
    const again = await exportsLib.handleImage2PptWebhook(body, new Headers({
      'webhook-id': 'msg_webhook_2',
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${createHmac('sha256', key).update(`msg_webhook_2.${timestamp}.${body}`).digest('base64')}`,
    }), { fetchImpl: fetcher, config: i2pConfig, retryDelayMs: 0 });
    const after = getGenDb().prepare('SELECT status, file_url FROM export_jobs WHERE id = ?').get(exportId);
    check('Image2PPT webhook 不把已成功任务降级',
      again.status === 200 && after?.status === 'succeeded' && after?.file_url === row?.file_url);
  }

  {
    credits.refundCredits(uid, 200, { reason: 'Image2PPT 测试补贴', idempotencyKey: 'test-topup-i2p' });
    getGenDb().prepare("DELETE FROM export_jobs WHERE user_id = ? AND ref_type = 'deck' AND ref_id = ? AND kind = 'editable'").run(uid, deck.id);
    let poll = 0;
    const downloadCalls = [];
    const fetcher = makeMockFetcher([
      { match: '/api/v1/jobs/job_pipeline/download', payload: (init) => {
        downloadCalls.push(init);
        return new Response(Buffer.from('mock-i2p-pptx'), {
          headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
        });
      } },
      { match: '/api/v1/jobs/job_pipeline', payload: () => {
        poll += 1;
        return poll === 1
          ? { jobId: 'job_pipeline', status: 'processing', progress: 40, slideCount: 2, creditsUsed: 0, creditsRefunded: 0 }
          : { jobId: 'job_pipeline', status: 'completed', progress: 100, slideCount: 2, creditsUsed: 2, creditsRefunded: 0, downloadUrl: '/api/v1/jobs/job_pipeline/download' };
      } },
      { match: '/api/v1/jobs', payload: { jobId: 'job_pipeline', status: 'pending', slideCount: 2, creditsReserved: 2 } },
    ]);
    const before = credits.getBalance(uid);
    const started = await exportsLib.startDeckEditableExport(
      uid,
      deck.id,
      { fetchImpl: fetcher, config: i2pConfig, pollIntervalMs: 1, retryDelayMs: 0 },
      { force: true },
    );
    check('Image2PPT 管线发起：processing + 40🌟', started.status === 'processing' && started.credits === 40);
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId);
    const row = getGenDb().prepare('SELECT upstream_provider, upstream_task_id FROM export_jobs WHERE id = ?').get(started.exportId);
    check('Image2PPT 管线成功落盘 + provider 记录',
      exp.status === 'succeeded'
        && exp.url.startsWith('/api/files/exports/')
        && row?.upstream_provider === 'image2ppt'
        && row?.upstream_task_id === 'job_pipeline');
    check('Image2PPT 下载带 Bearer 鉴权', downloadCalls.length === 1 && downloadCalls[0].headers.Authorization === 'Bearer i2p-test-key');
    check('Image2PPT 成功净扣 40🌟', before - credits.getBalance(uid) === 40);
  }

  {
    const bothConfig = { ...i2pConfig, codiaApiKey: 'sk-codia-test', codiaBaseUrl: 'http://mock-codia' };
    let i2pSubmit = 0;
    let codiaPoll = 0;
    const fetcher = makeMockFetcher([
      { match: 'http://mock-codia/v2/open/tasks/', payload: () => ((codiaPoll += 1) === 1
        ? { code: 0, data: { status: 'pending' } }
        : { code: 0, data: { status: 'succeeded', result: { ppt_url: 'http://mock-codia/files/fallback.pptx', page_count: 2 } } }) },
      { match: 'http://mock-codia/v2/open/tasks', payload: { code: 0, data: { task_id: 'task_fallback', status: 'pending' } } },
      { match: 'http://mock-codia/v2/open/uploads', payload: { code: 0, data: { upload_id: 'upl_fallback' } } },
      { match: 'fallback.pptx', payload: new Response(Buffer.from('mock-codia-pptx')) },
      { match: 'https://image2ppt.test/api/v1/jobs', status: 502, payload: () => {
        i2pSubmit += 1;
        return { error: { message: 'temporary' } };
      } },
    ]);
    const started = await exportsLib.startDeckEditableExport(
      uid,
      deck.id,
      { fetchImpl: fetcher, config: bothConfig, pollIntervalMs: 1, retryDelayMs: 0 },
      { force: true },
    );
    await started.done;
    const exp = await exportsLib.getExport(uid, started.exportId);
    const row = getGenDb().prepare('SELECT upstream_provider FROM export_jobs WHERE id = ?').get(started.exportId);
    check('Image2PPT 失败自动切换 Codia 并成功',
      exp.status === 'succeeded' && row?.upstream_provider === 'codia');
    check('Image2PPT 提交在 502 后按幂等键重试一次', i2pSubmit === 2, `实际 ${i2pSubmit}`);
  }

  {
    const previousCodia = process.env.ANPPT_V2_CODIA_API_KEY;
    const previousI2p = process.env.ANPPT_V2_IMAGE2PPT_API_KEY;
    process.env.ANPPT_V2_CODIA_API_KEY = '';
    process.env.ANPPT_V2_IMAGE2PPT_API_KEY = 'i2p-test-key';
    try {
      const quote = exportsLib.quoteExport(uid, { deckId: deck.id });
      check('仅配置 Image2PPT 时 editable 报价可用', quote.quotes.find((item) => item.kind === 'editable')?.available === true);
    } finally {
      if (previousCodia === undefined) delete process.env.ANPPT_V2_CODIA_API_KEY;
      else process.env.ANPPT_V2_CODIA_API_KEY = previousCodia;
      if (previousI2p === undefined) delete process.env.ANPPT_V2_IMAGE2PPT_API_KEY;
      else process.env.ANPPT_V2_IMAGE2PPT_API_KEY = previousI2p;
    }
  }
}
