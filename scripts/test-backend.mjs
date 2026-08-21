#!/usr/bin/env node
// Backend lib-layer smoke tests. Runs plain node (no Next dev server needed):
//   node scripts/test-backend.mjs
// Uses a throwaway sqlite db; exercises auth/OTP/credits/redemption/recharge flows.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTsHooks } from './ts-hooks.mjs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'anppt-v2-test-'));
process.env.ANPPT_V2_DB_PATH = path.join(tmpDir, 'test.db');
process.env.OTP_DEV_ECHO = 'true';
process.env.WECHAT_PAY_MOCK = 'true';
process.env.EPAY_MOCK = 'true';
process.env.NODE_ENV = 'test';

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

console.log('\n[6] 充值（mock 微信）');
const { sanitizeWechatDescription } = await import('../src/lib/server/payments/wechat.ts');
check('微信描述剥除非 BMP emoji', sanitizeWechatDescription('AnPPT 100星包 100🌟') === 'AnPPT 100星包 100');
check('微信描述空串回落默认', sanitizeWechatDescription('🌟🌟') === 'AnPPT 星星充值');
const plans = recharge.listRechargePlans();
check('默认 4 个套餐', plans.length === 4 && plans[1].featured === true);
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
  const config = await import('../src/lib/server/generation/config.ts');
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
    codiaApiKey: '', codiaBaseUrl: 'http://codia.test', singlePageCredits: 10, projectRetentionDays: 7,
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

console.log(`\n结果: ${passed} 通过, ${failed} 失败${failed ? ` — 失败项: ${failures.join('、')}` : ''}`);
rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
