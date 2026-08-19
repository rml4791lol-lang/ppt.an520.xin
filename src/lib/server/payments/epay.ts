import { createHash, timingSafeEqual } from 'node:crypto';
import type { EpayConfig } from '../env';

export function isEpayConfigured(config: EpayConfig): boolean {
  return Boolean((config.enabled || config.mock) && (config.mock || (config.gateway && config.pid && config.key && config.notifyUrl)));
}

type SignParams = Record<string, string | number | undefined>;

export function buildEpaySign(params: SignParams, key: string): string {
  const sorted = Object.keys(params)
    .filter((name) => name !== 'sign' && name !== 'sign_type' && params[name] !== '' && params[name] != null)
    .sort();
  const signStr = sorted.map((name) => `${name}=${params[name]}`).join('&');
  return createHash('md5').update(`${signStr}${key}`, 'utf8').digest('hex');
}

export function verifyEpaySign(params: SignParams, key: string): boolean {
  const provided = String(params?.sign || '').trim();
  if (!provided || !key) return false;
  const expected = buildEpaySign(params, key);
  const providedBuffer = Buffer.from(provided.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expected.toLowerCase(), 'utf8');
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

function normalizeMoney(amount: unknown): string {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0.00';
  return numeric.toFixed(2);
}

function epayTerminalStatus(value: string): string {
  const status = String(value || '').trim().toUpperCase();
  if (['TRADE_CLOSED', 'CLOSED', 'EXPIRED', 'TIMEOUT_CLOSED', 'CANCELLED', 'CANCELED'].includes(status)) return 'expired';
  if (['TRADE_FAILED', 'FAILED', 'FAIL', 'PAYERROR', 'ERROR', 'REVOKED'].includes(status)) return 'failed';
  return '';
}

export interface EpayOrderInput {
  outTradeNo: string;
  amountFen: number;
  name?: string;
  payType?: string;
  clientIp?: string;
}

export interface EpayOrderResult {
  ok: boolean;
  status?: number;
  message?: string;
  mock?: boolean;
  payurl?: string;
  qrcode?: string;
  tradeNo?: string;
}

export function buildEpaySubmitUrl(input: EpayOrderInput, config: EpayConfig): string {
  const params: SignParams = {
    pid: config.pid,
    type: input.payType || config.defaultType,
    out_trade_no: input.outTradeNo,
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    name: String(input.name || 'AnPPT 充值').slice(0, 127),
    money: normalizeMoney(input.amountFen / 100),
  };
  params.sign = buildEpaySign(params, config.key);
  params.sign_type = 'MD5';
  const query = new URLSearchParams(params as Record<string, string>);
  return `${config.gateway}/submit.php?${query.toString()}`;
}

export async function createEpayOrder(input: EpayOrderInput, config: EpayConfig): Promise<EpayOrderResult> {
  if (!config.enabled && !config.mock) return { ok: false, status: 503, message: '支付宝支付暂未开放' };

  if (config.mock) {
    const returnBase = config.returnUrl || 'http://localhost:3000/?billing=success';
    const sep = returnBase.includes('?') ? '&' : '?';
    return {
      ok: true,
      mock: true,
      payurl: `${returnBase}${sep}mock_epay=1&out_trade_no=${encodeURIComponent(input.outTradeNo)}`,
      qrcode: `mock-epay://${input.outTradeNo}`,
      tradeNo: `mock-${input.outTradeNo}`,
    };
  }

  if (!config.gateway || !config.pid || !config.key) {
    return { ok: false, status: 503, message: '易支付网关或商户密钥未配置' };
  }
  if (!config.notifyUrl) {
    return { ok: false, status: 503, message: '易支付回调地址未配置' };
  }

  if (!config.useMapi) {
    return { ok: true, payurl: buildEpaySubmitUrl(input, config), qrcode: '', tradeNo: '' };
  }

  const params: SignParams = {
    pid: config.pid,
    type: input.payType || config.defaultType,
    out_trade_no: input.outTradeNo,
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    name: String(input.name || 'AnPPT 充值').slice(0, 127),
    money: normalizeMoney(input.amountFen / 100),
    clientip: String(input.clientIp || '127.0.0.1').slice(0, 64),
    device: config.device,
  };
  params.sign = buildEpaySign(params, config.key);
  params.sign_type = 'MD5';

  try {
    const response = await fetch(`${config.gateway}/mapi.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params as Record<string, string>).toString(),
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (text.trim().startsWith('<')) return { ok: false, status: 502, message: '支付网关返回异常页面，请稍后重试' };
      return { ok: false, status: 502, message: text.slice(0, 200) || '支付网关返回非 JSON' };
    }
    const code = Number(payload.code);
    if (!(code === 1 || code === 200)) {
      return { ok: false, status: 502, message: String(payload.msg || payload.message || '易支付下单失败') };
    }
    return {
      ok: true,
      payurl: String(payload.payurl || '').trim(),
      qrcode: String(payload.qrcode || payload.qr || '').trim(),
      tradeNo: String(payload.trade_no || '').trim(),
    };
  } catch (error) {
    return { ok: false, status: 502, message: error instanceof Error ? error.message : '易支付请求失败' };
  }
}

export interface EpayNotifyResult {
  ok: boolean;
  message?: string;
  paid?: boolean;
  ignored?: boolean;
  terminalStatus?: string;
  providerStatus?: string;
  outTradeNo?: string;
  tradeNo?: string;
  amount?: string | number;
}

export function parseEpayNotify(params: Record<string, string>, config: EpayConfig): EpayNotifyResult {
  const buildResult = (paid: boolean): EpayNotifyResult => {
    const providerStatus = String(params.trade_status || '').trim().toUpperCase();
    const terminalStatus = paid ? '' : epayTerminalStatus(providerStatus);
    return {
      ok: true,
      paid,
      ignored: !paid && !terminalStatus,
      terminalStatus,
      providerStatus,
      outTradeNo: String(params.out_trade_no || '').trim(),
      tradeNo: String(params.trade_no || '').trim(),
      amount: params.money,
    };
  };

  if (config.mock) {
    if (!String(params.out_trade_no || '').trim()) return { ok: false, message: 'missing out_trade_no' };
    const result = buildResult(String(params.trade_status || '').trim().toUpperCase() === 'TRADE_SUCCESS');
    if (result.paid && !result.tradeNo) result.tradeNo = `mock-${result.outTradeNo}`;
    return result;
  }

  if (!isEpayConfigured(config)) return { ok: false, message: 'epay notify unavailable' };
  if (!verifyEpaySign(params, config.key)) return { ok: false, message: 'sign verify failed' };
  if (!String(params.out_trade_no || '').trim()) return { ok: false, message: 'missing out_trade_no' };
  return buildResult(String(params.trade_status || '').trim().toUpperCase() === 'TRADE_SUCCESS');
}

// "18.00" yuan -> 1800 fen; returns null on anything malformed.
export function majorAmountToMinor(value: unknown): number | null {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const fraction = Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(fraction)) return null;
  const minor = major * 100 + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}
