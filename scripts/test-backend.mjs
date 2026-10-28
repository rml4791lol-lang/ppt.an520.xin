#!/usr/bin/env node
// Backend lib-layer smoke tests. Runs plain node (no Next dev server needed):
//   node scripts/test-backend.mjs
// Uses a throwaway sqlite db; exercises auth/OTP/credits/redemption/recharge flows.
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerTsHooks } from './ts-hooks.mjs';
import { acquireTestLock, releaseTestLock } from './test-lock.mjs';
import { runClientApiTests } from './tests/client-api.test.mjs';
import { runAdminIntentTests } from './tests/surface-intents.test.mjs';
import { runAdminSurfaceIntentParserTests } from './tests/surface-intent-parsers.test.mjs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-test-'));
process.env.ANPPT_V2_DB_PATH = path.join(tmpDir, 'test.db');
process.env.ANPPT_V2_DATA_DIR = path.join(tmpDir, 'data');
process.env.ANPPT_V2_ADMIN_CONFIG_KEY = 'anppt-v2-test-admin-config-master-key-2026';
process.env.ANPPT_V2_LLM_BASE_URL = 'http://127.0.0.1:6800/v1';
process.env.ANPPT_V2_LLM_API_KEY = 'env-llm-secret';
process.env.ANPPT_V2_LLM_MODEL = 'env-main-model';
process.env.OTP_DEV_ECHO = 'true';
process.env.WECHAT_PAY_MOCK = 'true';
process.env.EPAY_MOCK = 'true';
process.env.NODE_ENV = 'test';

acquireTestLock('backend 套件');
registerTsHooks();

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectThrows(name, fn, code) {
  try {
    await fn();
    check(name, false, '未抛出预期错误');
  } catch (error) {
    check(name, error?.code === code, `实际错误 ${error?.code || error?.message}`);
  }
}

const auth = await import('../src/lib/server/auth.ts');
const otp = await import('../src/lib/server/otp.ts');
const credits = await import('../src/lib/server/credits.ts');
const redemption = await import('../src/lib/server/redemption.ts');
const recharge = await import('../src/lib/server/recharge.ts');
const onlyoffice = await import('../src/lib/server/onlyoffice.ts');
const httpLib = await import('../src/lib/server/http.ts');

console.log('\n[1] 注册 + 注册赠送');
const reg = await auth.registerWithPassword(
  { account: 'tester01', password: 'password123', confirmPassword: 'password123', displayName: '测试员' },
  '127.0.0.1',
);
check('注册成功并建 session', Boolean(reg.user?.id && reg.sessionToken));
check('注册后余额 100', credits.getBalance(reg.user.id) === 100, `实际 ${credits.getBalance(reg.user.id)}`);
await expectThrows('重复注册同用户名被拒绝', () =>
  auth.registerWithPassword({ account: 'tester01', password: 'password123', confirmPassword: 'password123' }, '127.0.0.1'),
  'REGISTER_FAILED');
check('重复注册后余额仍 100（未重复赠送）', credits.getBalance(reg.user.id) === 100);

console.log('\n[2] 密码登录 / session / 登出');
await expectThrows('错误密码登录被拒', () =>
  auth.loginWithPassword({ identifier: 'tester01', password: 'wrong-password' }, '127.0.0.1'),
  'AUTH_FAILED');
const login = await auth.loginWithPassword({ identifier: 'tester01', password: 'password123' }, '127.0.0.1');
check('登录成功', login.user.username === 'tester01');
const session = auth.getSessionByToken(login.sessionToken);
check('session 有效且为用户本人', session?.user?.id === login.user.id);
auth.revokeSession(login.sessionToken);
check('登出后 session 失效', auth.getSessionByToken(login.sessionToken) === null);

console.log('\n[3] OTP 流程（dev echo）');
check('SMTP_FROM 支持「显示名 <地址>」并回落 SMTP_USER 语义',
  otp.parseSmtpFrom('AnPPT <otp@qq.com>').address === 'otp@qq.com'
    && otp.parseSmtpFrom('AnPPT <otp@qq.com>').name === 'AnPPT'
    && otp.parseSmtpFrom('客服 <otp@qq.com>').name === '客服'
    && otp.parseSmtpFrom('otp@qq.com').address === 'otp@qq.com'
    && otp.parseSmtpFrom('otp@qq.com').name === 'AnPPT'
    && otp.parseSmtpFrom('').address === '');
const email = 'otp-user@example.com';
const req1 = await otp.requestEmailOtp(email, '127.0.0.1');
check('OTP 请求成功且回显 devCode', /^\d{6}$/.test(req1.devCode || ''));
await expectThrows('60s 冷却内重复请求被拒', () => otp.requestEmailOtp(email, '127.0.0.1'), 'OTP_COOLDOWN');
await expectThrows('错误验证码被拒', () =>
  otp.verifyEmailOtp({ identifier: email, code: req1.devCode === '000000' ? '000001' : '000000' }),
  'OTP_INVALID');
const verified = await otp.verifyEmailOtp({ identifier: email, code: req1.devCode });
check('OTP 首次验证自动建号', verified.isNewUser === true && Boolean(verified.user.email === email));
check('OTP 注册送 100', credits.getBalance(verified.user.id) === 100);
await expectThrows('已消费的验证码不能复用', () =>
  otp.verifyEmailOtp({ identifier: email, code: req1.devCode }),
  'OTP_INVALID');
const req2 = await otp.requestEmailOtp('otp-user@example.com', '127.0.0.2').catch(async (error) => {
  if (error?.code !== 'OTP_COOLDOWN') throw error;
  // 测试不等 60s 冷却：把上一个 challenge 的创建时间回拨后重新请求
  const { getDb } = await import('../src/lib/server/db.ts');
  getDb().prepare('UPDATE auth_otp_challenges SET created_at = created_at - 120000 WHERE 1=1').run();
  return otp.requestEmailOtp('otp-user@example.com', '127.0.0.2');
});
const verified2 = await otp.verifyEmailOtp({ identifier: email, code: req2.devCode });
check('二次 OTP 登录为老用户（不重复赠送）', verified2.isNewUser === false && credits.getBalance(verified2.user.id) === 100);

console.log('\n[3b] 手机号 OTP（dev echo）与标识识别');
const phone = '13800138000';
check('classifyIdentifier 识别手机号', auth.classifyIdentifier('+86 138-0013-8000').value === phone);
check('classifyIdentifier 识别邮箱', auth.classifyIdentifier(' A@B.COM ').value === 'a@b.com');
const preq = await otp.requestEmailOtp(phone, '127.0.0.3');
check('手机号 OTP 请求成功且回显 devCode', /^\d{6}$/.test(preq.devCode || ''));
check('手机号掩码正确', preq.destination === '138****8000');
await expectThrows('无效标识（非邮箱非手机号）被拒', () => otp.requestEmailOtp('not-an-email', '127.0.0.1'), 'VALIDATION_ERROR');
await expectThrows('无效手机号被拒', () => otp.requestEmailOtp('12345', '127.0.0.1'), 'VALIDATION_ERROR');
const pverified = await otp.verifyEmailOtp({ identifier: phone, code: preq.devCode });
check('手机号首验自动建号并送 100', pverified.isNewUser === true && pverified.user.phone === phone && credits.getBalance(pverified.user.id) === 100);
check('findUserByPhone 命中', auth.findUserByPhone(phone)?.id === pverified.user.id);
await expectThrows('手机号密码登录（未设密码）走 AUTH_FAILED', () =>
  auth.loginWithPassword({ identifier: phone, password: 'whatever123' }, '127.0.0.4'),
  'AUTH_FAILED');

console.log('\n[4] 积分幂等');
const uid = reg.user.id;
const before = credits.getBalance(uid);
const g1 = credits.grantCredits(uid, 50, { reason: '测试', idempotencyKey: 'test-grant-1' });
const g2 = credits.grantCredits(uid, 50, { reason: '测试', idempotencyKey: 'test-grant-1' });
check('grant 幂等键重复不重复入账', !g1.duplicate && g2.duplicate && credits.getBalance(uid) === before + 50);
const d1 = credits.debitCredits(uid, 20, { reason: '测试扣减', idempotencyKey: 'test-debit-1' });
const d2 = credits.debitCredits(uid, 20, { reason: '测试扣减', idempotencyKey: 'test-debit-1' });
check('debit 幂等键重复不重复扣减', !d1.duplicate && d2.duplicate && credits.getBalance(uid) === before + 30);
const r1 = credits.refundCredits(uid, 5, { reason: '测试返还', idempotencyKey: 'test-refund-1' });
const r2 = credits.refundCredits(uid, 5, { reason: '测试返还', idempotencyKey: 'test-refund-1' });
check('refund 幂等键重复不重复返还', !r1.duplicate && r2.duplicate && credits.getBalance(uid) === before + 35);
await expectThrows('余额不足抛 INSUFFICIENT_CREDITS', async () => {
  try {
    credits.debitCredits(uid, 999999, { reason: 'x', idempotencyKey: 'test-debit-over' });
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: error.code });
  }
}, 'INSUFFICIENT_CREDITS');
const ledger = credits.listLedger(uid, { page: 1, pageSize: 10 });
check('ledger 有 4 条记录（注册赠送+grant+debit+refund）', ledger.total === 4, `实际 ${ledger.total}`);
check('summary 汇总正确', (() => {
  const s = credits.creditsSummary(uid);
  return s.balance === before + 35 && s.totalGranted === 100 + 50 + 5 && s.totalSpent === 20;
})());

console.log('\n[5] 兑换码');
const [code] = redemption.generateRedemptionCodes({ credits: 50, count: 1, batch: 'test' });
check('生成兑换码', typeof code === 'string' && code.startsWith('ANPPT-'));
const preview = redemption.previewRedemption(code);
check('preview 返回额度', preview.credits === 50 && preview.requiresConfirmation === true);
const balBefore = credits.getBalance(uid);
const redeemed = redemption.redeemCode(uid, code);
check('redeem 入账成功', redeemed.credits === 50 && credits.getBalance(uid) === balBefore + 50);
await expectThrows('同一用户重复 redeem 被拒', () => redemption.redeemCode(uid, code), 'REDEMPTION_ALREADY_USED');
check('重复 redeem 后余额不变', credits.getBalance(uid) === balBefore + 50);
await expectThrows('不存在的码 preview 统一报错', () => redemption.previewRedemption('ANPPT-XXXX-XXXX-XXXX'), 'REDEMPTION_INVALID');
await expectThrows('已用完的码 preview 统一报错（不暴露区别）', () => redemption.previewRedemption(code), 'REDEMPTION_INVALID');

console.log('\n[5b] ONLYOFFICE 下载权限（未充值）');
const makeSessionRequest = (token, arch = 'x64') => new Request(`http://localhost/api/tools/onlyoffice/download/${arch}`, {
  headers: { cookie: `anppt_v2_session=${encodeURIComponent(token)}` },
});
const unauthOnlyOffice = await onlyoffice.getOnlyOfficeDownloadResponse(
  new Request('http://localhost/api/tools/onlyoffice/download/x64'),
  'x64',
  { fetchImpl: async () => { throw new Error('未登录不应访问上游'); }, useCache: false },
);
check('未登录下载返回 401', unauthOnlyOffice.status === 401, `实际 ${unauthOnlyOffice.status}`);
const redemptionOnlyCode = redemption.generateRedemptionCodes({ credits: 20, count: 1, batch: 'onlyoffice-test' })[0];
redemption.redeemCode(verified.user.id, redemptionOnlyCode);
const redemptionOnlySession = auth.createSessionForUser(verified.user.id);
const redemptionOnlyResponse = await onlyoffice.getOnlyOfficeDownloadResponse(
  makeSessionRequest(redemptionOnlySession),
  'x64',
  { fetchImpl: async () => { throw new Error('未充值不应访问上游'); }, useCache: false },
);
check('仅兑换码入账不能解锁安装包', redemptionOnlyResponse.status === 403, `实际 ${redemptionOnlyResponse.status}`);
const unpaidOnlyOffice = await onlyoffice.getOnlyOfficeDownloadResponse(
  makeSessionRequest(reg.sessionToken),
  'x64',
  { fetchImpl: async () => { throw new Error('未充值不应访问上游'); }, useCache: false },
);
check('已登录但未充值下载返回 403', unpaidOnlyOffice.status === 403, `实际 ${unpaidOnlyOffice.status}`);

console.log('\n[6] 充值（mock 微信）');
const { sanitizeWechatDescription } = await import('../src/lib/server/payments/wechat.ts');
check('微信描述剥除非 BMP emoji', sanitizeWechatDescription('AnPPT 100星包 100🌟') === 'AnPPT 100星包 100');
check('微信描述空串回落默认', sanitizeWechatDescription('🌟🌟') === 'AnPPT 星星充值');
const plans = recharge.listRechargePlans();
check('默认 4 个套餐', plans.length === 4 && plans[1].featured === true);
check('未充值前 ONLYOFFICE 附带权益未解锁', recharge.hasEverPaid(uid) === false);
const created = await recharge.createRechargeOrder(uid, { planId: 'pack-100', channel: 'wechat' }, '127.0.0.1');
check('建单 pending + mock code_url', created.order.status === 'pending' && created.order.codeUrl.includes('mock='));
const queried = recharge.getRechargeOrderForUser(uid, created.order.orderNo);
check('查单 pending', queried.status === 'pending');
await expectThrows('他人查单被拒', () => recharge.getRechargeOrderForUser(verified.user.id, created.order.orderNo), 'ORDER_NOT_FOUND');
const notifyBody = JSON.stringify({ mock: 1, out_trade_no: created.order.orderNo, transaction_id: 'mock-tx-001', amount: { total: 990, currency: 'CNY' } });
const notify1 = await recharge.handleWechatNotify(notifyBody, {});
check('模拟回调返回 SUCCESS', notify1.status === 200 && notify1.body.code === 'SUCCESS');
const afterPay = recharge.getRechargeOrderForUser(uid, created.order.orderNo);
check('订单已 paid', afterPay.status === 'paid' && afterPay.paidAt != null);
check('充值入账 +100', credits.getBalance(uid) === balBefore + 50 + 100, `实际 ${credits.getBalance(uid)}`);
check('任意一次充值成功后永久权益解锁', recharge.hasEverPaid(uid) === true);

console.log('\n[6b] ONLYOFFICE 三版本下载与重定向安全');
const releasePayload = {
  tag_name: 'v9.5.1',
  published_at: '2026-08-20T08:00:00Z',
  assets: [
    {
      name: 'DesktopEditors_x64.exe', size: 373575296,
      browser_download_url: 'https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v9.5.1/DesktopEditors_x64.exe',
      digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    {
      name: 'DesktopEditors_x86.exe', size: 351950968,
      browser_download_url: 'https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v9.5.1/DesktopEditors_x86.exe',
      digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    {
      name: 'DesktopEditors_arm64.exe', size: 339981432,
      browser_download_url: 'https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v9.5.1/DesktopEditors_arm64.exe',
      digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    },
  ],
};
const releaseFetch = async () => Response.json(releasePayload);
for (const [arch, filename] of [
  ['x64', 'DesktopEditors_x64.exe'],
  ['x86', 'DesktopEditors_x86.exe'],
  ['arm64', 'DesktopEditors_arm64.exe'],
]) {
  const response = await onlyoffice.getOnlyOfficeDownloadResponse(
    makeSessionRequest(reg.sessionToken, arch),
    arch,
    { fetchImpl: releaseFetch, useCache: false },
  );
  const location = response.headers.get('location') || '';
  check(`已充值 ${arch} 返回官方安装包直链`, response.status === 307 && location.endsWith(`/${filename}`) && location.startsWith('https://github.com/ONLYOFFICE/DesktopEditors/releases/download/'), `status=${response.status}, location=${location}`);
}
const invalidArchResponse = await onlyoffice.getOnlyOfficeDownloadResponse(
  makeSessionRequest(reg.sessionToken, 'evil'),
  'evil',
  { fetchImpl: releaseFetch, useCache: false },
);
check('非法安装包架构被拒绝', invalidArchResponse.status === 400, `实际 ${invalidArchResponse.status}`);
const fallbackRelease = await onlyoffice.resolveOnlyOfficeRelease({
  fetchImpl: async () => new Response('upstream down', { status: 503 }),
  useCache: false,
});
check('GitHub API 异常时回退固定安全版本', fallbackRelease.source === 'fallback' && fallbackRelease.version === '9.4.0' && fallbackRelease.assets.x64.url.includes('/v9.4.0/DesktopEditors_x64.exe'));
const maliciousPayload = structuredClone(releasePayload);
maliciousPayload.assets[0].browser_download_url = 'https://evil.example/ONLYOFFICE/DesktopEditors/releases/download/v9.5.1/DesktopEditors_x64.exe';
const maliciousRelease = await onlyoffice.resolveOnlyOfficeRelease({
  fetchImpl: async () => Response.json(maliciousPayload),
  useCache: false,
});
check('恶意上游 host 不会形成开放重定向', maliciousRelease.source === 'fallback' && maliciousRelease.assets.x64.url.startsWith('https://github.com/ONLYOFFICE/'));
check('伪造路径与查询参数均不能通过白名单',
  !onlyoffice.isAllowedOnlyOfficeAssetUrl('https://github.com/evil/releases/download/v1/DesktopEditors_x64.exe', 'DesktopEditors_x64.exe')
  && !onlyoffice.isAllowedOnlyOfficeAssetUrl('https://github.com/ONLYOFFICE/DesktopEditors/releases/download/v1/DesktopEditors_x64.exe?next=https://evil.example', 'DesktopEditors_x64.exe'));
const publicReleaseResponse = await onlyoffice.getOnlyOfficeReleaseResponse({ fetchImpl: releaseFetch, useCache: false });
const publicReleaseJson = await publicReleaseResponse.json();
check('公开版本信息不泄露可绕过权益的下载 URL', publicReleaseResponse.status === 200 && publicReleaseJson?.data?.version === '9.5.1' && JSON.stringify(publicReleaseJson).includes('browser_download_url') === false && JSON.stringify(publicReleaseJson).includes('github.com') === false);

const notify2 = await recharge.handleWechatNotify(notifyBody, {});
check('重复回调幂等（不重复入账）', notify2.body.code === 'SUCCESS' && credits.getBalance(uid) === balBefore + 50 + 100);
const badBody = JSON.stringify({ mock: 1, out_trade_no: created.order.orderNo, transaction_id: 'mock-tx-evil', amount: { total: 1, currency: 'CNY' } });
const notify3 = await recharge.handleWechatNotify(badBody, {});
check('金额不一致的回调被拒绝', notify3.body.code === 'FAIL');

console.log('\n[7] 充值（mock epay）');
const epayOrder = await recharge.createRechargeOrder(uid, { planId: 'pack-500', channel: 'alipay' }, '127.0.0.1');
check('epay 建单 pending + checkout_url', epayOrder.order.status === 'pending' && epayOrder.order.checkoutUrl.includes('mock_epay=1'));
const epayResult = recharge.handleEpayNotify({ out_trade_no: epayOrder.order.orderNo, trade_status: 'TRADE_SUCCESS', trade_no: 'epay-mock-1', money: '39.90' });
check('epay 回调 success', epayResult === 'success');
check('epay 入账 +500', credits.getBalance(uid) === balBefore + 50 + 100 + 500, `实际 ${credits.getBalance(uid)}`);
const epayBad = recharge.handleEpayNotify({ out_trade_no: epayOrder.order.orderNo, trade_status: 'TRADE_SUCCESS', trade_no: 'epay-mock-2', money: '0.01' });
check('epay 金额不一致返回 fail', epayBad === 'fail');
check('epay 失败回调不影响余额', credits.getBalance(uid) === balBefore + 50 + 100 + 500);

console.log('\n[8] 估价');
check('deck_page_generate 10/页 × 8 页 = 80', credits.estimateCredits({ action: 'deck_page_generate', pages: 8 }).credits === 80);
check('outline 免费', credits.estimateCredits({ action: 'outline' }).credits === 0);
await expectThrows('未知动作被拒', async () => {
  try {
    credits.estimateCredits({ action: 'hack' });
  } catch (error) {
    throw Object.assign(new Error(error.message), { code: error.code });
  }
}, 'VALIDATION_ERROR');

console.log('\n[9] LLM 回退链');
{
  const engine = await import('../src/lib/server/engine.ts');
  const base = {
    engineBaseUrl: 'http://127.0.0.1:3002',
    engineInternalToken: '',
    llmBaseUrl: 'http://llm.test/v1',
    llmApiKey: 'k',
    llmModel: 'm-primary',
    llmFallbackModels: ['m-fb1', 'm-fb2'],
    dataDir: tmpDir, uploadsDir: tmpDir, generatedDir: tmpDir, exportsDir: tmpDir,
    uploadMaxBytes: 1024, sourceTextMaxChars: 1000,
    imageBaseUrl: '', imageApiKey: '', imageModel: 'gpt-image-2', imageSize: '1536x864',
    imageTimeoutMs: 5000, generateConcurrency: 1, jobStaleMs: 600000,
    codiaApiKey: '', codiaBaseUrl: 'http://codia.test', projectRetentionDays: 7,
  };
  const okBody = JSON.stringify({ choices: [{ message: { content: '[{"title":"首页","role":"cover","chapter":"","summary":["要点"],"must_keep":[]}]' } }] });
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push(JSON.parse(init.body).model);
    const model = JSON.parse(init.body).model;
    if (model === 'm-primary') throw new Error('upstream down');
    if (model === 'm-fb1') return new Response(okBody, { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('', { status: 200 });
  };
  const out = await engine.generateOutline({ sourceText: '文档', targetPageCount: 3 }, { config: { ...base, engineBaseUrl: '' }, fetchImpl: fetchMock });
  check('主模型失败自动切兜底并返回', out.provider === 'llm-fallback' && out.slides.length === 1, `calls=${calls.join(',')}`);
  check('回退链只试到成功模型为止', calls.join(',') === 'm-primary,m-fb1', `calls=${calls.join(',')}`);
}

console.log('\n[10] 管理员权限、加密配置、监控与无付费检查');
{
  const { getDb } = await import('../src/lib/server/db.ts');
  const admin = await import('../src/lib/server/admin.ts');
  const adminConfig = await import('../src/lib/server/admin-config.ts');
  const adminIntegrations = await import('../src/lib/server/admin-integrations.ts');
  const generationConfig = await import('../src/lib/server/generation/config.ts');
  const decks = await import('../src/lib/server/generation/decks.ts');

  const adminAccount = await auth.registerWithPassword(
    { account: 'siteowner01', password: 'password123', confirmPassword: 'password123', email: 'owner@example.com' },
    '127.0.1.10',
  );
  getDb().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(adminAccount.user.id);
  const boss = await auth.registerWithPassword(
    { account: 'boss1000', password: 'password123', confirmPassword: 'password123', displayName: '老板测试账号' },
    '127.0.1.11',
  );
  const bossCode = redemption.generateRedemptionCodes({ credits: 1000, count: 1, batch: 'boss-test' })[0];
  redemption.redeemCode(boss.user.id, bossCode);

  const cookie = (token) => `anppt_v2_session=${encodeURIComponent(token)}`;
  const normalRequest = new Request('http://localhost/api/admin/overview', {
    headers: { cookie: cookie(reg.sessionToken) },
  });
  const adminRequest = (url, init = {}) => new Request(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      cookie: cookie(adminAccount.sessionToken),
    },
  });

  await expectThrows('普通用户 requireAdmin → 403', () => admin.requireAdmin(normalRequest), 'ADMIN_FORBIDDEN');
  const adminSession = admin.requireAdmin(adminRequest('http://localhost/api/admin/overview'));
  check('管理员角色从数据库 session 实时生效', adminSession.user.role === 'admin');

  const overviewRoute = await import('../src/app/api/admin/overview/route.ts');
  const noAuthOverview = await overviewRoute.GET(new Request('http://localhost/api/admin/overview'));
  check('管理员 overview 未登录 401', noAuthOverview.status === 401, `实际 ${noAuthOverview.status}`);
  const normalOverview = await overviewRoute.GET(normalRequest);
  check('管理员 overview 普通用户 403', normalOverview.status === 403, `实际 ${normalOverview.status}`);

  const problemsRoute = await import('../src/app/api/admin/problems/route.ts');
  const anonProblems = await problemsRoute.GET(new Request('http://localhost/api/admin/problems'));
  check('管理员 problems 未登录 401', anonProblems.status === 401, `实际 ${anonProblems.status}`);
  const normalProblems = await problemsRoute.GET(new Request('http://localhost/api/admin/problems', {
    headers: { cookie: cookie(reg.sessionToken) },
  }));
  check('管理员 problems 普通用户 403', normalProblems.status === 403, `实际 ${normalProblems.status}`);
  const problemLog = await import('../src/lib/server/problem-log.ts');
  problemLog.logProblem({ category: 'api', level: 'warn', message: '路由回环断言', refType: 'admin', refId: 'problems' });
  const adminProblemsResponse = await problemsRoute.GET(adminRequest('http://localhost/api/admin/problems?days=7&limit=5'));
  const adminProblemsJson = await adminProblemsResponse.json().catch(() => null);
  check('管理员 problems 200 且返回 {items}（含刚写入记录）',
    adminProblemsResponse.status === 200
      && Array.isArray(adminProblemsJson?.data?.items)
      && adminProblemsJson.data.items.some((item) => item.message === '路由回环断言' && item.level === 'warn'),
    `实际 ${adminProblemsResponse.status}`);

  const configRoute = await import('../src/app/api/admin/config/route.ts');
  const secretValue = 'runtime-secret-must-never-be-returned';
  const putConfig = await configRoute.PUT(adminRequest('http://localhost/api/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({
      intent: {
        kind: 'updateRuntimeConfig',
        params: {
          values: {
            ANPPT_V2_LLM_API_KEY: secretValue,
            ANPPT_V2_LLM_MODEL: 'runtime-main-model',
            ANPPT_V2_IMAGE_GLOBAL_CONCURRENCY: '25',
          },
        },
      },
    }),
  }));
  const putConfigJson = await putConfig.json();
  check('管理员可保存运行时配置', putConfig.status === 200 && putConfigJson?.ok === true, `实际 ${putConfig.status}`);
  const storedRows = getDb().prepare('SELECT key, encrypted_value FROM admin_runtime_config').all();
  check('运行时配置数据库不含密钥明文',
    storedRows.length === 3 && !JSON.stringify(storedRows).includes(secretValue));
  check('配置 API 从不回显密钥明文',
    !JSON.stringify(putConfigJson).includes(secretValue)
      && putConfigJson?.data?.config?.fields?.find((field) => field.key === 'ANPPT_V2_LLM_API_KEY')?.value === null);

  const effective = generationConfig.getGenerationConfig();
  check('运行时覆盖立即作用到真实生成配置',
    effective.llmApiKey === secretValue
      && effective.llmModel === 'runtime-main-model'
      && effective.imageGlobalConcurrency === 25);
  const explicit = generationConfig.getGenerationConfig({
    ...process.env,
    ANPPT_V2_LLM_API_KEY: 'explicit-test-key',
    ANPPT_V2_LLM_MODEL: 'explicit-test-model',
  });
  check('显式测试 env 不受数据库运行时覆盖污染',
    explicit.llmApiKey === 'explicit-test-key' && explicit.llmModel === 'explicit-test-model');

  await expectThrows('公网 HTTP API 地址被 SSRF 规则拒绝', () =>
    Promise.resolve(adminConfig.normalizeAdminConfigValue('ANPPT_V2_LLM_BASE_URL', 'http://example.com/v1')), 'VALIDATION_ERROR');
  await expectThrows('API 地址中的凭据与查询参数被拒绝', () =>
    Promise.resolve(adminConfig.normalizeAdminConfigValue('ANPPT_V2_LLM_BASE_URL', 'https://u:p@example.com/v1?q=1')), 'VALIDATION_ERROR');
  check('本机 HTTP API 地址允许',
    adminConfig.normalizeAdminConfigValue('ANPPT_V2_LLM_BASE_URL', 'http://127.0.0.1:6800/v1') === 'http://127.0.0.1:6800/v1');
  check('可编辑 provider 支持 wps 且 WPS Cookie 可保存',
    adminConfig.normalizeAdminConfigValue('ANPPT_V2_EDITABLE_PROVIDER', 'wps') === 'wps'
      && adminConfig.normalizeAdminConfigValue('ANPPT_V2_WPS_AIPPT_COOKIE', 'wps_sid=test; uid=1') === 'wps_sid=test; uid=1');

  await runAdminIntentTests({ check, expectThrows, adminRequest, configRoute });
  await runAdminSurfaceIntentParserTests({ check });

  const integrationCalls = [];
  const integrationFetch = async (url, init) => {
    integrationCalls.push({
      url: String(url), method: init?.method, auth: init?.headers?.Authorization, redirect: init?.redirect,
    });
    if (String(url).endsWith('/v2/open/credits')) {
      return Response.json({ code: 0, data: { credits: 321 } });
    }
    if (String(url).endsWith('/api/v1/account')) {
      return Response.json({ email: 'i2p-test@example.com', credits: 123 });
    }
    if (String(url).endsWith('/api/v3/islogin')) {
      return Response.json({ result: 'ok', userid: 123 });
    }
    return Response.json({ data: [{ id: 'runtime-main-model' }, { id: 'image-test-model' }] });
  };
  const llmCheck = await adminIntegrations.checkAdminIntegration('llm', undefined, integrationFetch);
  const imageCheck = await adminIntegrations.checkAdminIntegration('image', {
    ANPPT_V2_IMAGE_BASE_URL: 'http://127.0.0.1:6801/v1',
    ANPPT_V2_IMAGE_API_KEY: 'image-test-key',
    ANPPT_V2_IMAGE_MODEL: 'image-test-model',
  }, integrationFetch);
  const codiaCheck = await adminIntegrations.checkAdminIntegration('editable', {
    ANPPT_V2_CODIA_BASE_URL: 'https://openapi.codia.ai',
    ANPPT_V2_CODIA_API_KEY: 'codia-test-key',
  }, integrationFetch);
  const image2pptCheck = await adminIntegrations.checkAdminIntegration('editable', {
    ANPPT_V2_EDITABLE_PROVIDER: 'image2ppt',
    ANPPT_V2_IMAGE2PPT_BASE_URL: 'https://image2ppt.com',
    ANPPT_V2_IMAGE2PPT_API_KEY: 'i2p-test-key',
  }, integrationFetch);
  const wpsCheck = await adminIntegrations.checkAdminIntegration('editable', {
    ANPPT_V2_EDITABLE_PROVIDER: 'wps',
    ANPPT_V2_WPS_AIPPT_COOKIE: 'wps_sid=test; uid=1',
  }, integrationFetch);
  check('LLM/Image/Codia/Image2PPT/WPS 检查全部只发 GET 且不创建付费任务',
    integrationCalls.length === 5
      && integrationCalls.every((call) => call.method === 'GET' && call.redirect === 'error')
      && !integrationCalls.some((call) => /\/tasks|\/uploads/.test(call.url)));
  check('无付费连接检查返回模型、Codia/Image2PPT 额度与 WPS 登录态',
    llmCheck.ok && imageCheck.ok && codiaCheck.ok && image2pptCheck.ok && wpsCheck.ok
      && codiaCheck.details.credits === 321
      && image2pptCheck.details.provider === 'image2ppt'
      && image2pptCheck.details.credits === 123
      && wpsCheck.details.provider === 'wps');

  const redemptionRoute = await import('../src/app/api/admin/redemption-codes/route.ts');
  const generatedResponse = await redemptionRoute.POST(adminRequest('http://localhost/api/admin/redemption-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({
      intent: { kind: 'generateRedemptionCodes', params: { credits: 1000, count: 1, batch: 'admin-test' } },
    }),
  }));
  const generatedJson = await generatedResponse.json();
  check('管理员端可生成 1000 星兑换码',
    generatedResponse.status === 200
      && generatedJson?.data?.codes?.length === 1
      && generatedJson?.data?.credits === 1000);

  const fakeDeck = decks.createDeck(boss.user.id, {
    title: '监控测试项目',
    sourceFileName: 'secret.docx',
    sourceText: 'PRIVATE_SOURCE_TEXT_MUST_NOT_LEAK',
    durationMinutes: 5,
    targetPageCount: 1,
    qualityTier: 'standard',
    stylePackId: '',
  });
  decks.replaceSlides(fakeDeck.id, [{
    pageIndex: 0,
    role: 'content',
    chapter: '测试',
    pageType: '内容页',
    title: '测试页',
    goal: '测试',
    rawText: 'PRIVATE_SLIDE_TEXT_MUST_NOT_LEAK',
    summary: ['测试'],
    mustKeep: [],
    visualNote: '',
  }]);
  const fakeSlide = decks.listSlides(fakeDeck.id)[0];
  decks.createSlideVersion(fakeSlide, { kind: 'generate', prompt: 'PRIVATE_PROMPT_MUST_NOT_LEAK', jobId: '' });

  admin.recordAdminAudit({
    adminUserId: adminAccount.user.id,
    action: 'test.secret.redaction',
    detail: { apiKey: secretValue, nested: { authorization: `Bearer ${secretValue}` }, note: `Bearer ${secretValue}` },
  });
  const overviewResponse = await overviewRoute.GET(adminRequest('http://localhost/api/admin/overview'));
  const overviewJson = await overviewResponse.json();
  const overviewText = JSON.stringify(overviewJson);
  const latestBoss = overviewJson?.data?.latestUsers?.find((user) => user.id === boss.user.id);
  check('高余额用户在最新用户列表可见且余额与健康状态正确',
    latestBoss?.balance === 1100 && latestBoss?.accountHealthy === true);
  check('管理员 overview 不返回文档正文、页面原文、prompt 或密钥',
    !overviewText.includes('PRIVATE_SOURCE_TEXT_MUST_NOT_LEAK')
      && !overviewText.includes('PRIVATE_SLIDE_TEXT_MUST_NOT_LEAK')
      && !overviewText.includes('PRIVATE_PROMPT_MUST_NOT_LEAK')
      && !overviewText.includes(secretValue));
  const auditRows = getDb().prepare('SELECT detail_json FROM admin_audit_logs').all();
  check('管理员审计日志递归脱敏密钥与 Bearer',
    !JSON.stringify(auditRows).includes(secretValue) && JSON.stringify(auditRows).includes('[REDACTED]'));

  const compactResponse = await overviewRoute.GET(adminRequest('http://localhost/api/admin/overview?compact=1'));
  const compactJson = await compactResponse.json();
  check('轻量轮询不返回资源/最新用户/审计大对象',
    compactJson?.data?.compact === true
      && compactJson?.data?.resources == null
      && compactJson?.data?.latestUsers == null
      && compactJson?.data?.audits == null);

  const clearResponse = await configRoute.PUT(adminRequest('http://localhost/api/admin/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({
      intent: {
        kind: 'updateRuntimeConfig',
        params: { clearKeys: ['ANPPT_V2_LLM_API_KEY', 'ANPPT_V2_LLM_MODEL', 'ANPPT_V2_IMAGE_GLOBAL_CONCURRENCY'] },
      },
    }),
  }));
  check('清除运行时覆盖成功', clearResponse.status === 200);
  const fallbackConfig = generationConfig.getGenerationConfig();
  check('清除后安全回退环境变量',
    fallbackConfig.llmApiKey === 'env-llm-secret' && fallbackConfig.llmModel === 'env-main-model');
}

console.log('\n[11] 功能开关板 + 测试用户角色');
{
  const { getDb } = await import('../src/lib/server/db.ts');
  const flags = await import('../src/lib/server/feature-flags.ts');
  const flagsRoute = await import('../src/app/api/admin/feature-flags/route.ts');
  const featuresRoute = await import('../src/app/api/features/route.ts');
  const roleRoute = await import('../src/app/api/admin/users/[id]/role/route.ts');

  check('开关默认状态：editable_text_overlay=beta、4 个图片编辑工具=off、gold_layouts_beta=beta、ppt_replicate=beta、ppt_to_base=beta',
    flags.getFeatureFlagState('editable_text_overlay') === 'beta'
      && flags.getFeatureFlagState('magic_erase') === 'off'
      && flags.getFeatureFlagState('image_text_edit') === 'off'
      && flags.getFeatureFlagState('template_fusion') === 'off'
      && flags.getFeatureFlagState('set_as_reference') === 'off'
      && flags.getFeatureFlagState('gold_layouts_beta') === 'beta'
      && flags.getFeatureFlagState('ppt_replicate') === 'beta'
      && flags.getFeatureFlagState('ppt_to_base') === 'beta');
  check('listFeatureFlags 返回 8 个登记项且带默认状态',
    flags.listFeatureFlags().length === 8
      && flags.listFeatureFlags().every((flag) => flag.state === flag.defaultState));

  const betaTester = await auth.registerWithPassword(
    { account: 'betatester01', password: 'password123', confirmPassword: 'password123' },
    '127.0.2.1',
  );
  check('新注册用户默认不是测试用户', flags.isTesterUser(betaTester.user) === false);
  getDb().prepare("UPDATE users SET role = 'tester' WHERE id = ?").run(betaTester.user.id);
  const testerUser = auth.findUserById(betaTester.user.id);
  check('SQL 提升后 isTesterUser 生效', flags.isTesterUser(testerUser) === true);

  const ownerLogin = await auth.loginWithPassword({ identifier: 'siteowner01', password: 'password123' }, '127.0.1.10');
  const flagCookie = (token) => `anppt_v2_session=${encodeURIComponent(token)}`;
  const flagAdminRequest = (url, init = {}) => new Request(url, {
    ...init,
    headers: { ...(init.headers || {}), cookie: flagCookie(ownerLogin.sessionToken) },
  });

  check('beta 功能可见性矩阵：匿名/普通不可见，测试用户/管理员可见',
    flags.isFeatureVisible('editable_text_overlay', null) === false
      && flags.isFeatureVisible('editable_text_overlay', reg.user) === false
      && flags.isFeatureVisible('editable_text_overlay', testerUser) === true
      && flags.isFeatureVisible('editable_text_overlay', { ...reg.user, role: 'admin' }) === true);
  check('off 功能（4 个图片编辑工具）普通/测试用户不可见、仅管理员可见',
    ['magic_erase', 'image_text_edit', 'template_fusion', 'set_as_reference'].every((key) =>
      flags.isFeatureVisible(key, null) === false
        && flags.isFeatureVisible(key, reg.user) === false
        && flags.isFeatureVisible(key, testerUser) === false
        && flags.isFeatureVisible(key, { ...reg.user, role: 'admin' }) === true));
  await expectThrows('普通用户访问 beta 功能按 404 处理（不暴露功能存在）', async () => {
    flags.assertFeatureVisible('editable_text_overlay', reg.user);
  }, 'NOT_FOUND');

  flags.setFeatureFlag('magic_erase', 'public', ownerLogin.user.id);
  check('off→public 后匿名即可见', flags.isFeatureVisible('magic_erase', null) === true);
  flags.setFeatureFlag('magic_erase', 'off', ownerLogin.user.id);
  check('public→off 收回后匿名不可见', flags.isFeatureVisible('magic_erase', null) === false);
  await expectThrows('未知开关 key 被拒', async () => {
    flags.setFeatureFlag('nope_feature', 'beta', ownerLogin.user.id);
  }, 'VALIDATION_ERROR');
  await expectThrows('非法开关状态被拒', async () => {
    flags.setFeatureFlag('magic_erase', 'on', ownerLogin.user.id);
  }, 'VALIDATION_ERROR');

  const normalPut = await flagsRoute.PUT(new Request('http://localhost/api/admin/feature-flags', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1', cookie: flagCookie(reg.sessionToken) },
    body: JSON.stringify({ intent: { kind: 'setFeatureFlag', params: { key: 'magic_erase', state: 'public' } } }),
  }), { params: Promise.resolve({}) });
  check('普通用户 PUT 开关 403', normalPut.status === 403, `实际 ${normalPut.status}`);
  const adminPut = await flagsRoute.PUT(flagAdminRequest('http://localhost/api/admin/feature-flags', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({ intent: { kind: 'setFeatureFlag', params: { key: 'magic_erase', state: 'public' } } }),
  }), { params: Promise.resolve({}) });
  check('管理员 PUT 开关成功并持久化', adminPut.status === 200 && flags.getFeatureFlagState('magic_erase') === 'public');

  const anonFeatures = await (await featuresRoute.GET(new Request('http://localhost/api/features'))).json();
  check('匿名 /api/features：public 可见 beta 不可见',
    anonFeatures?.data?.flags?.magic_erase === true
      && anonFeatures?.data?.flags?.editable_text_overlay === false
      && anonFeatures?.data?.flags?.ppt_replicate === false);
  const testerFeatures = await (await featuresRoute.GET(new Request('http://localhost/api/features', {
    headers: { cookie: flagCookie(betaTester.sessionToken) },
  }))).json();
  check('测试用户 /api/features：beta+public 可见、off 不可见',
    testerFeatures?.data?.flags?.editable_text_overlay === true
      && testerFeatures?.data?.flags?.ppt_replicate === true
      && testerFeatures?.data?.flags?.magic_erase === true
      && testerFeatures?.data?.flags?.image_text_edit === false);

  const genRoute = await import('../src/app/api/single-page/generate/route.ts');
  const replicateBlocked = await genRoute.POST(new Request('http://localhost/api/single-page/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1', cookie: flagCookie(reg.sessionToken) },
    body: JSON.stringify({
      intent: {
        kind: 'generatePage',
        params: { pageId: 'rpblock', content: '新内容', mode: 'replicate', imagePath: 'uploads/x/a.png' },
      },
    }),
  }), { params: Promise.resolve({}) });
  check('普通用户 POST 复刻 mode 返回 404', replicateBlocked.status === 404);

  const planRoute = await import('../src/app/api/tools/replicate/plan/route.ts');
  const planBlocked = await planRoute.POST(new Request('http://localhost/api/tools/replicate/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1', cookie: flagCookie(reg.sessionToken) },
    body: JSON.stringify({ topic: '妇科培训', pageCount: 2 }),
  }), { params: Promise.resolve({}) });
  check('普通用户 POST 复刻拆文案 404', planBlocked.status === 404);

  const roleTarget = await auth.registerWithPassword(
    { account: 'roleuser01', password: 'password123', confirmPassword: 'password123' },
    '127.0.2.2',
  );
  const setRoleResponse = await roleRoute.POST(flagAdminRequest(`http://localhost/api/admin/users/${roleTarget.user.id}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({ intent: { kind: 'setUserRole', params: { userId: roleTarget.user.id, role: 'tester' } } }),
  }), { params: Promise.resolve({ id: roleTarget.user.id }) });
  check('管理员可设测试用户并实时生效',
    setRoleResponse.status === 200 && auth.findUserById(roleTarget.user.id)?.role === 'tester');
  const adminRoleResponse = await roleRoute.POST(flagAdminRequest(`http://localhost/api/admin/users/${ownerLogin.user.id}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({ intent: { kind: 'setUserRole', params: { userId: ownerLogin.user.id, role: 'tester' } } }),
  }), { params: Promise.resolve({ id: ownerLogin.user.id }) });
  check('管理员账号拒绝走测试开关', adminRoleResponse.status === 400, `实际 ${adminRoleResponse.status}`);
  const badRoleResponse = await roleRoute.POST(flagAdminRequest(`http://localhost/api/admin/users/${roleTarget.user.id}/role`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anppt-action': '1' },
    body: JSON.stringify({ intent: { kind: 'setUserRole', params: { userId: roleTarget.user.id, role: 'admin' } } }),
  }), { params: Promise.resolve({ id: roleTarget.user.id }) });
  check('role 只允许 tester/user', badRoleResponse.status === 400, `实际 ${badRoleResponse.status}`);

  const flagAudits = getDb().prepare("SELECT action FROM admin_audit_logs WHERE action IN ('feature-flag:set','user:set-role')").all();
  check('开关变更与角色变更均留审计',
    flagAudits.some((row) => row.action === 'feature-flag:set') && flagAudits.some((row) => row.action === 'user:set-role'));

  flags.setFeatureFlag('magic_erase', 'off', ownerLogin.user.id);

  // --- 金奖版式测试包：门控资产的可见性矩阵 + 列表/详情/硬门 ---
  const templatesMod = await import('../src/lib/server/templates.ts');
  const stylePacksData = await import('../src/data/style-packs.ts');
  const stylePacksRoute = await import('../src/app/api/style-packs/route.ts');
  const templatesRoute = await import('../src/app/api/templates/route.ts');
  const templateDetailRoute = await import('../src/app/api/templates/[id]/route.ts');
  const GOLD_PACK_ID = 'anppt-gold-tianxun-test-20260824';

  check('公开 STYLE_PACKS 不含门控测试包',
    !stylePacksData.STYLE_PACKS.some((p) => p.id === GOLD_PACK_ID)
      && stylePacksData.GATED_STYLE_PACKS.some((p) => p.id === GOLD_PACK_ID));
  check('visibleStylePacks：匿名/普通不见金奖包，测试用户/管理员可见',
    !templatesMod.visibleStylePacks(null).some((p) => p.id === GOLD_PACK_ID)
      && !templatesMod.visibleStylePacks(reg.user).some((p) => p.id === GOLD_PACK_ID)
      && templatesMod.visibleStylePacks(testerUser).some((p) => p.id === GOLD_PACK_ID)
      && templatesMod.visibleStylePacks({ ...reg.user, role: 'admin' }).some((p) => p.id === GOLD_PACK_ID));

  const anonPacks = await (await stylePacksRoute.GET(new Request('http://localhost/api/style-packs'))).json();
  const testerPacks = await (await stylePacksRoute.GET(new Request('http://localhost/api/style-packs', {
    headers: { cookie: flagCookie(betaTester.sessionToken) },
  }))).json();
  check('/api/style-packs 按开关注入：匿名无金奖包、测试用户有',
    !anonPacks?.data?.stylePacks?.some((p) => p.id === GOLD_PACK_ID)
      && testerPacks?.data?.stylePacks?.some((p) => p.id === GOLD_PACK_ID));

  const anonTemplates = await (await templatesRoute.GET(new Request('http://localhost/api/templates?kind=template'))).json();
  const testerTemplates = await (await templatesRoute.GET(new Request('http://localhost/api/templates?kind=template', {
    headers: { cookie: flagCookie(betaTester.sessionToken) },
  }))).json();
  check('/api/templates 按开关注入：匿名无金奖包、测试用户有',
    !anonTemplates?.data?.templates?.some((p) => p.id === GOLD_PACK_ID)
      && testerTemplates?.data?.templates?.some((p) => p.id === GOLD_PACK_ID));

  const anonDetail = await templateDetailRoute.GET(new Request('http://localhost/api/templates/x'), {
    params: Promise.resolve({ id: GOLD_PACK_ID }),
  });
  const testerDetail = await templateDetailRoute.GET(new Request('http://localhost/api/templates/x', {
    headers: { cookie: flagCookie(betaTester.sessionToken) },
  }), { params: Promise.resolve({ id: GOLD_PACK_ID }) });
  const testerDetailJson = await testerDetail.json();
  check('门控包详情：匿名 404、测试用户 200 且带 6 页模板载体',
    anonDetail.status === 404
      && testerDetail.status === 200
      && testerDetailJson?.data?.template?.templatePages?.length === 6);

  await expectThrows('普通用户生成链路使用门控包按 404 拒绝', async () => {
    templatesMod.assertStylePackUsable(GOLD_PACK_ID, reg.user);
  }, 'NOT_FOUND');
  templatesMod.assertStylePackUsable(GOLD_PACK_ID, testerUser);
  check('测试用户通过门控包硬门校验', true);
}

console.log('\n[12] getClientIp：X-Real-IP 优先于 XFF（Caddy 只保证前者，XFF 首值可伪造）');
{
  const spoofed = new Request('http://localhost/api/x', {
    headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'x-real-ip': '6.7.8.9' },
  });
  check('X-Real-IP 优先于 XFF 首值', httpLib.getClientIp(spoofed) === '6.7.8.9');
  const xffOnly = new Request('http://localhost/api/x', { headers: { 'x-forwarded-for': ' 1.2.3.4 , 10.0.0.1' } });
  check('无 X-Real-IP 时回退 XFF 首值', httpLib.getClientIp(xffOnly) === '1.2.3.4');
  check('两头皆无 → unknown', httpLib.getClientIp(new Request('http://localhost/api/x')) === 'unknown');
}

console.log('\n[12b] 支付 mock 生产硬拒（子进程 NODE_ENV=production + MOCK=true）');
{
  const probe = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { registerTsHooks } from './scripts/ts-hooks.mjs';
    registerTsHooks();
    const envMod = await import('./src/lib/server/env.ts');
    const env = envMod.getEnv();
    console.log(JSON.stringify({ epay: env.epay.mock, wechat: env.wechat.mock }));
  `], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NODE_ENV: 'production', EPAY_MOCK: 'true', WECHAT_PAY_MOCK: 'true', ANPPT_V2_DB_PATH: path.join(tmpDir, 'probe.db') },
    encoding: 'utf8',
  });
  const flags = JSON.parse(probe.trim().split('\n').pop());
  check('生产环境 EPAY_MOCK/WECHAT_PAY_MOCK 被强制关闭', flags.epay === false && flags.wechat === false);
}

console.log('\n[12c] 导入文档页数上限 40（自定义页数；超出回退默认 10）');
{
  const parseRoute = await import('../src/app/api/deck/parse/route.ts');
  const parseRequest = (pages) => {
    const form = new FormData();
    form.append('file', new File(['第一章 项目背景\n本项目致力于打造校园赛事服务平台。\n\n第二章 市场分析\n目标用户为高校学生与指导老师。'], 'notes.txt', { type: 'text/plain' }));
    form.append('duration', '15');
    form.append('targetPageCount', String(pages));
    return new Request('http://localhost/api/deck/parse', {
      method: 'POST',
      headers: { cookie: `anppt_v2_session=${encodeURIComponent(reg.sessionToken)}`, 'x-anppt-action': '1' },
      body: form,
    });
  };
  const { getDb } = await import('../src/lib/server/db.ts');
  const pageCountOf = (deckId) => Number(getDb().prepare('SELECT target_page_count FROM decks WHERE id = ?').get(deckId)?.target_page_count);

  const okRes = await parseRoute.POST(parseRequest(40));
  const okJson = await okRes.json();
  check('40 页（上限）正常创建', okRes.status === 201 && pageCountOf(okJson?.data?.deckId) === 40, `实际 ${okRes.status}`);
  const overRes = await parseRoute.POST(parseRequest(99));
  const overJson = await overRes.json();
  check('99 页超出上限回退默认 10 页', overRes.status === 201 && pageCountOf(overJson?.data?.deckId) === 10, `实际 ${overRes.status}`);
}

console.log('\n[12d] 问题日志：追踪 / 脱敏 / 健康 / 滚动 / 过期清理');
{
  const problems = await import('../src/lib/server/problem-log.ts');
  const { withRequestContext } = await import('../src/lib/server/request-context.ts');
  const logDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-problem-log-'));
  const previousDir = process.env.ANPPT_V2_PROBLEM_LOG_DIR;
  process.env.ANPPT_V2_PROBLEM_LOG_DIR = logDir;
  const dayKey = (offsetDays) => {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  try {
    problems.logProblem({
      category: 'api',
      level: 'error',
      message: '回环测试：接口异常',
      detail: 'boom',
      userId: 'user-1234567890',
      refType: 'deck',
      refId: 'deck-1',
    });
    problems.logProblem({ category: 'generation', level: 'warn', message: '回环测试：退款警告' });

    const roundTrip = problems.readProblems({ days: 1 });
    check('logProblem 落盘 + readProblems 回环（新→旧、字段完整）',
      roundTrip.items.length === 2
        && roundTrip.items[0].message === '回环测试：退款警告'
        && roundTrip.items[0].level === 'warn'
        && roundTrip.items[1].level === 'error'
        && roundTrip.items[1].category === 'api'
        && roundTrip.items[1].userId === 'user-1234567890'
        && roundTrip.items[1].refType === 'deck'
        && roundTrip.items[1].refId === 'deck-1'
        && roundTrip.items[1].detail === 'boom'
        && typeof roundTrip.items[1].ts === 'number'
        && Boolean(roundTrip.items[1].eventId)
        && roundTrip.items[1].release === 'dev',
      `items=${roundTrip.items.length}`);

    check('readProblems 返回动态类别、总数与分页游标',
      roundTrip.categories.join(',') === 'api,generation'
        && roundTrip.total === 2
        && roundTrip.hasMore === false
        && roundTrip.nextOffset === 2
        && roundTrip.scanLimited === false,
      JSON.stringify(roundTrip));

    check('category / level / limit 过滤生效',
      problems.readProblems({ days: 1, category: 'api' }).items.length === 1
        && problems.readProblems({ days: 1, level: 'warn' }).items.length === 1
        && problems.readProblems({ days: 1, limit: 1 }).items.length === 1
        && problems.readProblems({ days: 1, limit: 1 }).items[0].message === '回环测试：退款警告');

    withRequestContext({ requestId: 'req_trace_12345678', method: 'POST', route: '/api/trace' }, () => {
      problems.logProblem({ category: 'api', level: 'error', message: '上下文追踪' });
    });
    const traced = problems.readProblems({ days: 1 }).items.find((item) => item.message === '上下文追踪');
    check('请求上下文写入 requestId / method / route / release',
      traced?.requestId === 'req_trace_12345678'
        && traced?.method === 'POST'
        && traced?.route === '/api/trace'
        && traced?.release === 'dev',
      JSON.stringify(traced));

    const secretValues = ['plain-password-987', 'api-key-987', 'bearer-token-987', 'cookie-987'];
    problems.logProblem({
      category: 'api',
      level: 'error',
      message: 'Authorization: Bearer bearer-token-987',
      detail: {
        password: secretValues[0],
        apiKey: secretValues[1],
        authorization: 'Bearer bearer-token-987',
        nested: { cookie: secretValues[3] },
      },
    });
    const redacted = problems.readProblems({ days: 1 }).items.find((item) => item.message.includes('Authorization'));
    const redactedJson = JSON.stringify(redacted);
    check('问题日志对密码、API key、Bearer、Cookie 脱敏',
      Boolean(redacted)
        && secretValues.every((secret) => !redactedJson.includes(secret))
        && redactedJson.includes('[REDACTED]'),
      redactedJson);

    const healthy = problems.getProblemLogHealth({ force: true });
    check('日志落盘健康检查可写并统计文件',
      healthy.ok && healthy.writable && healthy.directoryReady && healthy.fileCount >= 1 && healthy.totalBytes > 0,
      JSON.stringify(healthy));

    appendFileSync(path.join(logDir, `problems-${dayKey(0)}.jsonl`), '{ bad json line\n');
    check('坏行跳过、其余行仍可读', problems.readProblems({ days: 1 }).items.length === 4);

    writeFileSync(
      path.join(logDir, `problems-${dayKey(0)}.1.jsonl`),
      `${JSON.stringify({
        ts: Date.now() + 1000,
        level: 'warn',
        category: 'sms',
        message: '分段记录',
        detail: '',
        userId: '',
        refType: '',
        refId: '',
        eventId: 'evt_segment',
        requestId: 'req_segment',
        method: 'GET',
        route: '/api/segment',
        release: 'dev',
      })}\n`,
    );
    const segmented = problems.readProblems({ days: 1 }).items[0];
    check('滚动分段文件参与读取且保持新→旧', segmented?.message === '分段记录', JSON.stringify(segmented));

    const oldFile = path.join(logDir, `problems-${dayKey(-20)}.jsonl`);
    const keepFile = path.join(logDir, `problems-${dayKey(-5)}.jsonl`);
    writeFileSync(oldFile, '');
    writeFileSync(keepFile, '');
    problems.logProblem({ category: 'api', level: 'error', message: '触发清理' });
    check('写入时清理超 14 天文件、保留 14 天内文件', !existsSync(oldFile) && existsSync(keepFile));

    const blocker = path.join(logDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    process.env.ANPPT_V2_PROBLEM_LOG_DIR = blocker;
    let threw = false;
    try {
      problems.logProblem({ category: 'api', level: 'error', message: '不可写目录' });
    } catch {
      threw = true;
    }
    const broken = problems.getProblemLogHealth({ force: true });
    check('日志目录不可写时不阻断业务且健康检查报错', !threw && broken.ok === false && broken.writable === false, JSON.stringify(broken));
    process.env.ANPPT_V2_PROBLEM_LOG_DIR = logDir;

    const route = httpLib.defineRoute(async () => {
      throw new Error('route boom');
    });
    const response = await route(new Request('http://localhost/api/trace-test', { method: 'GET' }));
    const body = await response.json();
    const requestId = response.headers.get('x-request-id') || '';
    check('defineRoute 返回请求号并回填错误 envelope',
      response.status === 500
        && /^req_[a-f0-9]{24}$/.test(requestId)
        && body?.error?.requestId === requestId,
      JSON.stringify({ status: response.status, requestId, body }));
  } finally {
    if (previousDir === undefined) delete process.env.ANPPT_V2_PROBLEM_LOG_DIR;
    else process.env.ANPPT_V2_PROBLEM_LOG_DIR = previousDir;
    rmSync(logDir, { recursive: true, force: true });
  }
}

console.log('\n[13] 前端统一客户端：能力命名（URL 不出客户端层）');
await runClientApiTests({ check });

console.log(`\n结果: ${passed} 通过, ${failed} 失败${failed ? ` — 失败项: ${failures.join('、')}` : ''}`);
rmSync(tmpDir, { recursive: true, force: true });
releaseTestLock();
process.exit(failed > 0 ? 1 : 0);
