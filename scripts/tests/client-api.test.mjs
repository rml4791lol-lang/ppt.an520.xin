// [13] 前端统一客户端（src/lib/client/api.ts）：能力命名、URL 只留在客户端层。
// 纯客户端契约测试：mock globalThis.fetch，不连数据库、不打真实接口。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  captureFetch,
  errorResponse,
  jsonResponse,
  repoRoot,
  source,
  walkSourceFiles,
} from './client-test-helpers.mjs';

const MIGRATED_VIEWS = [
  'src/components/projects/projects-client.tsx',
  'src/components/account/credits-client.tsx',
  'src/components/recharge/recharge-client.tsx',
  'src/components/tools/onlyoffice-client.tsx',
  'src/components/auth/login-card.tsx',
  'src/components/layout/user-area.tsx',
];

export async function runClientApiTests({ check }) {
  const { api, ApiClientError, resetSessionCache } = await import('../../src/lib/client/api.ts');

  // 项目列表与删除
  {
    const mock = captureFetch(() =>
      jsonResponse({ items: [{ id: 'p1', title: '项目一' }], total: 1, page: 1, pageSize: 50, retentionDays: 7 }));
    try {
      const list = await api.projects.list({ pageSize: 50 });
      const call = mock.calls[0];
      check('api.projects.list：GET /api/projects?pageSize=50 并解包 items',
        mock.calls.length === 1 && call.url === '/api/projects?pageSize=50'
          && call.method === 'GET' && list.items?.[0]?.id === 'p1',
        JSON.stringify({ url: call?.url, method: call?.method }));
    } finally {
      mock.restore();
    }

    const plain = captureFetch(() => jsonResponse({ items: [] }));
    try {
      await api.projects.list();
      check('api.projects.list：不带查询时不留尾随问号', plain.calls[0].url === '/api/projects', plain.calls[0].url);
    } finally {
      plain.restore();
    }

    const removeMock = captureFetch(() => jsonResponse({ deleted: true }));
    try {
      const value = await api.projects.remove('p 1');
      const call = removeMock.calls[0];
      check('api.projects.remove：DELETE、路径转义、CSRF 头且返回 void',
        call.url === '/api/projects/p%201' && call.method === 'DELETE'
          && call.headers['x-anppt-action'] === '1' && value === undefined,
        JSON.stringify({ url: call.url, method: call.method }));
    } finally {
      removeMock.restore();
    }
  }

  // 积分概览 / 流水 / 余额
  {
    const mock = captureFetch(() =>
      jsonResponse({ balance: 42, totalGranted: 100, totalSpent: 58, granted30d: 0, spent30d: 0 }));
    try {
      const summary = await api.credits.summary();
      check('api.credits.summary：GET /api/credits/summary 并返回概览',
        mock.calls[0].url === '/api/credits/summary' && summary.balance === 42, mock.calls[0].url);
    } finally {
      mock.restore();
    }

    const ledgerMock = captureFetch(() => jsonResponse({ items: [], total: 0, page: 2, pageSize: 10 }));
    try {
      const page = await api.credits.ledger({ page: 2, pageSize: 10 });
      check('api.credits.ledger：分页参数进查询串',
        ledgerMock.calls[0].url === '/api/credits/ledger?page=2&pageSize=10' && Array.isArray(page.items),
        ledgerMock.calls[0].url);
    } finally {
      ledgerMock.restore();
    }

    const balanceMock = captureFetch(() => jsonResponse({ balance: 9 }));
    let balance;
    try {
      balance = await api.credits.balance();
    } finally {
      balanceMock.restore();
    }
    const availableMock = captureFetch(() => jsonResponse({ available: 7 }));
    let available;
    try {
      available = await api.credits.balance();
    } finally {
      availableMock.restore();
    }
    check('api.credits.balance：balance 优先、available 兜底', balance === 9 && available === 7,
      JSON.stringify({ balance, available }));
  }

  // 充值下单 / 轮询 / 兑换
  {
    const mock = captureFetch(() => jsonResponse({ order: { orderNo: 'AN1', status: 'pending' }, mock: true }));
    try {
      const created = await api.recharge.createOrder({ planId: 'p1', channel: 'wechat' });
      const call = mock.calls[0];
      check('api.recharge.createOrder：POST JSON + CSRF 头',
        call.url === '/api/recharge/orders' && call.method === 'POST'
          && call.headers['x-anppt-action'] === '1'
          && JSON.parse(call.body).planId === 'p1'
          && created.order.orderNo === 'AN1' && created.mock === true,
        JSON.stringify({ url: call.url, body: call.body }));
    } finally {
      mock.restore();
    }

    const orderMock = captureFetch(() => jsonResponse({ order: { orderNo: 'AN1', status: 'paid' } }));
    try {
      const order = await api.recharge.getOrder('AN 1');
      check('api.recharge.getOrder：订单号进查询串并返回 order',
        orderMock.calls[0].url === '/api/recharge/orders?orderNo=AN%201' && order.status === 'paid',
        orderMock.calls[0].url);
    } finally {
      orderMock.restore();
    }

    const redeemMock = captureFetch(() => jsonResponse({ credits: 50, balance: 150 }));
    try {
      const redeemed = await api.recharge.redeem('GIFT-1');
      const call = redeemMock.calls[0];
      check('api.recharge.redeem：POST 兑换码并返回到账结果',
        call.url === '/api/points/redemption/redeem' && JSON.parse(call.body).code === 'GIFT-1'
          && redeemed.balance === 150,
        JSON.stringify({ url: call.url, body: call.body }));
    } finally {
      redeemMock.restore();
    }
  }

  // ONLYOFFICE 资源与权益
  {
    const releaseMock = captureFetch(() =>
      jsonResponse({
        version: '9.4.0',
        publishedAt: '2026-05-19T09:55:56Z',
        assets: {
          x64: { filename: 'DesktopEditors_x64.exe', size: 373575296, sha256: 'a3' },
          x86: { filename: 'DesktopEditors_x86.exe', size: 351950968, sha256: '9c' },
          arm64: { filename: 'DesktopEditors_arm64.exe', size: 339981432, sha256: '52' },
        },
      }));
    try {
      const release = await api.onlyoffice.getRelease();
      check('api.onlyoffice.getRelease：GET 发布信息并返回三架构资源',
        releaseMock.calls[0].url === '/api/tools/onlyoffice/release'
          && release.assets.x64.filename === 'DesktopEditors_x64.exe');
    } finally {
      releaseMock.restore();
    }

    check('api.onlyoffice.downloadHref：下载链接由客户端拼',
      api.onlyoffice.downloadHref('arm64') === '/api/tools/onlyoffice/download/arm64',
      api.onlyoffice.downloadHref('arm64'));

    resetSessionCache();
    const benefitMock = captureFetch((call) =>
      call.url === '/api/auth/session'
        ? jsonResponse({ authenticated: true, user: { id: 'u1', username: 'tester' } })
        : jsonResponse({ user: { id: 'u1' }, benefits: { onlyOfficeToolkit: true }, balance: 1 }));
    try {
      const benefit = await api.onlyoffice.benefit();
      check('api.onlyoffice.benefit：会话 + /api/me 权益，已充值返回 unlocked',
        benefitMock.calls.some((call) => call.url === '/api/me')
          && benefit.loggedIn === true && benefit.unlocked === true,
        JSON.stringify(benefitMock.calls.map((call) => call.url)));
    } finally {
      benefitMock.restore();
    }

    resetSessionCache();
    const guestMock = captureFetch(() => jsonResponse({ authenticated: false, user: null }));
    try {
      const guest = await api.onlyoffice.benefit();
      check('api.onlyoffice.benefit：未登录不打 /api/me',
        guestMock.calls.length === 1 && guest.loggedIn === false && guest.unlocked === false,
        JSON.stringify(guestMock.calls.map((call) => call.url)));
    } finally {
      guestMock.restore();
      resetSessionCache();
    }
  }

  // 登录会话（表单把失败当返回值，不抛异常）
  {
    const otpMock = captureFetch(() => jsonResponse({ sent: true }));
    try {
      const sent = await api.auth.requestOtp('a@b.co');
      const call = otpMock.calls[0];
      check('api.auth.requestOtp：POST /api/auth/otp/request + CSRF 头',
        call.url === '/api/auth/otp/request' && call.method === 'POST'
          && call.headers['x-anppt-action'] === '1'
          && JSON.parse(call.body).identifier === 'a@b.co' && sent.ok === true,
        JSON.stringify({ url: call.url, body: call.body }));
    } finally {
      otpMock.restore();
    }

    const authMock = captureFetch(() => jsonResponse({ user: { id: 'u1' } }));
    try {
      const login = await api.auth.loginWithPassword({ account: 'tester01', password: 'password123' });
      await api.auth.loginWithOtp({ identifier: 'tester01', code: '123456' });
      await api.auth.register({
        account: 'tester01', email: 'a@b.co', password: 'password123', confirmPassword: 'password123',
      });
      check('api.auth 登录/注册：路径与请求体对齐既有接口',
        login.ok === true
          && authMock.calls[0].url === '/api/auth/login'
          && JSON.parse(authMock.calls[0].body).account === 'tester01'
          && authMock.calls[1].url === '/api/auth/otp/verify'
          && authMock.calls[2].url === '/api/auth/register'
          && JSON.parse(authMock.calls[2].body).confirmPassword === 'password123',
        JSON.stringify(authMock.calls.map((call) => call.url)));
    } finally {
      authMock.restore();
    }

    const envelopeMock = captureFetch(() => errorResponse(400, { code: 'AUTH_FAILED', message: '账号或密码错误' }));
    try {
      const failed = await api.auth.loginWithPassword({ account: 'x', password: 'y' });
      check('api.auth 失败：透出服务端信封文案',
        failed.ok === false && failed.message === '账号或密码错误', JSON.stringify(failed));
    } finally {
      envelopeMock.restore();
    }

    const missingMock = captureFetch(() => new Response('not found', { status: 404 }));
    try {
      const missing = await api.auth.requestOtp('a@b.co');
      check('api.auth 404（非信封）：保留「登录服务尚未接入」文案',
        missing.ok === false && missing.message === '登录服务尚未接入，敬请期待', JSON.stringify(missing));
    } finally {
      missingMock.restore();
    }

    const offlineMock = captureFetch(() => {
      throw new TypeError('fetch failed');
    });
    try {
      const offline = await api.auth.requestOtp('a@b.co');
      check('api.auth 网络失败：回退页面文案而不抛异常',
        offline.ok === false && offline.message === '请求失败，请稍后再试', JSON.stringify(offline));
    } finally {
      offlineMock.restore();
    }
  }

  // 401 语义（页面据此跳登录）
  {
    const mock = captureFetch(() => errorResponse(401, { code: 'UNAUTHORIZED', message: '请先登录' }));
    try {
      let caught = null;
      try {
        await api.credits.summary();
      } catch (error) {
        caught = error;
      }
      check('apiFetch 401：抛 ApiClientError 且 isUnauthorized 为真',
        caught instanceof ApiClientError && caught.isUnauthorized === true && caught.message === '请先登录',
        String(caught));
    } finally {
      mock.restore();
    }
  }

  // 静态约束：URL 不再出现在页面组件
  {
    const componentsDir = path.join(repoRoot, 'src/components');
    const bareFetchFiles = walkSourceFiles(componentsDir)
      .filter((file) => /(?<![\w.$])fetch\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(repoRoot, file));
    check('组件目录无裸 fetch（无豁免）',
      bareFetchFiles.length === 0, bareFetchFiles.join(', '));

    const urlLiterals = MIGRATED_VIEWS.filter((rel) => /\/api\//.test(source(rel)));
    check('迁移后的页面不再出现 /api/ 字面量', urlLiterals.length === 0, urlLiterals.join(', '));
  }
}
