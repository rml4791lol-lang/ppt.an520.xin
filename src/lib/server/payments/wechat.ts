import {
  createSign,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { WechatPayConfig } from '../env';

export interface WechatNativeOrderInput {
  outTradeNo: string;
  amountFen: number;
  description?: string;
}

export interface WechatNativeOrderResult {
  ok: boolean;
  status?: number;
  message?: string;
  mock?: boolean;
  outTradeNo?: string;
  codeUrl?: string;
  prepayId?: string;
  raw?: unknown;
}

function normalizePem(value: string): string {
  let trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^[0-9a-fA-F]+$/.test(trimmed.replace(/\s+/g, '')) && trimmed.length > 200) {
    try {
      trimmed = Buffer.from(trimmed.replace(/\s+/g, ''), 'hex').toString('utf8').trim();
    } catch {
      // keep original
    }
  }
  if (trimmed.includes('BEGIN')) return trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
}

async function resolvePrivateKey(config: WechatPayConfig): Promise<string> {
  if (config.privateKeyPem) return normalizePem(config.privateKeyPem);
  if (config.privateKeyPath) return normalizePem(await readFile(config.privateKeyPath, 'utf8'));
  return '';
}

async function resolvePlatformPublicKey(config: WechatPayConfig): Promise<string> {
  if (config.platformPublicKeyPem) return config.platformPublicKeyPem;
  if (config.platformPublicKeyPath) return String(await readFile(config.platformPublicKeyPath, 'utf8')).trim();
  return '';
}

export async function verifyWechatPaySetup(config: WechatPayConfig): Promise<{ ok: boolean; mock?: boolean; message?: string }> {
  if (!config.enabled) return { ok: false, message: '微信支付未开启' };
  if (config.mock) return { ok: true, mock: true };
  if (!config.mchId || !config.appId || !config.serialNo || !config.apiV3Key) {
    return { ok: false, message: '商户号、AppID、证书序列号或 APIv3 密钥未配置' };
  }
  if (!config.notifyUrl) return { ok: false, message: '微信支付回调地址未配置' };
  try {
    const publicKey = await resolvePlatformPublicKey(config);
    if (!publicKey) throw new Error('missing platform public key');
    createPublicKey(publicKey);
  } catch {
    return { ok: false, message: '微信支付平台公钥未配置或格式无效' };
  }
  try {
    const privateKeyPem = await resolvePrivateKey(config);
    if (!privateKeyPem) throw new Error('missing merchant private key');
    createPrivateKey(privateKeyPem);
  } catch {
    return { ok: false, message: '商户 API 私钥未配置或格式无效' };
  }
  return { ok: true };
}

function nonceStr(): string {
  return randomBytes(16).toString('hex');
}

function sha256RsaSign(message: string, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

async function buildAuthorization(input: { method: string; urlPath: string; body: string; config: WechatPayConfig }): Promise<string> {
  const privateKeyPem = await resolvePrivateKey(input.config);
  if (!privateKeyPem || !input.config.mchId || !input.config.serialNo) {
    throw new Error('WeChat Pay merchant credentials are incomplete');
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = nonceStr();
  const payload = `${input.method}\n${input.urlPath}\n${timestamp}\n${nonce}\n${input.body}\n`;
  const signature = sha256RsaSign(payload, privateKeyPem);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${input.config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${input.config.serialNo}"`;
}

export async function createWechatNativeOrder(
  input: WechatNativeOrderInput,
  config: WechatPayConfig,
): Promise<WechatNativeOrderResult> {
  if (!config.enabled && !config.mock) {
    return { ok: false, status: 503, message: '微信支付暂未开放' };
  }
  if (!config.notifyUrl && !config.mock) {
    return { ok: false, status: 503, message: '微信支付回调地址未配置' };
  }

  const outTradeNo = String(input.outTradeNo || '').trim();
  const amountFen = Math.max(1, Math.floor(Number(input.amountFen || 0)));
  const description = String(input.description || 'AnPPT 🌟 星星').slice(0, 127);

  if (config.mock) {
    return {
      ok: true,
      mock: true,
      outTradeNo,
      codeUrl: `weixin://wxpay/bizpayurl?mock=${encodeURIComponent(outTradeNo)}`,
      prepayId: `mock-prepay-${outTradeNo}`,
      raw: { mock: true },
    };
  }

  const setup = await verifyWechatPaySetup(config);
  if (!setup.ok) {
    return { ok: false, status: 503, message: setup.message || '微信支付配置无效' };
  }

  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description,
    out_trade_no: outTradeNo,
    notify_url: config.notifyUrl,
    amount: { total: amountFen, currency: 'CNY' },
  });
  const urlPath = '/v3/pay/transactions/native';
  const authorization = await buildAuthorization({ method: 'POST', urlPath, body, config });

  const response = await fetch(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'AnPPT/2.0',
    },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: String(payload?.message || payload?.code || '微信支付下单失败'),
      raw: payload,
    };
  }
  return {
    ok: true,
    outTradeNo,
    codeUrl: String(payload.code_url || ''),
    prepayId: String(payload.prepay_id || ''),
    raw: payload,
  };
}

function decryptResource(resource: Record<string, unknown>, apiV3Key: string): Record<string, unknown> {
  const key = Buffer.from(String(apiV3Key || ''), 'utf8');
  const nonce = Buffer.from(String(resource?.nonce || ''), 'utf8');
  const associatedData = Buffer.from(String(resource?.associated_data || ''), 'utf8');
  const ciphertext = Buffer.from(String(resource?.ciphertext || ''), 'base64');
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  if (associatedData.length) decipher.setAAD(associatedData);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
}

export interface WechatNotifyResult {
  ok: boolean;
  status?: number;
  message?: string;
  mock?: boolean;
  outTradeNo?: string;
  transactionId?: string;
  tradeState?: string;
  amountFen?: number;
  currency?: string;
  raw?: unknown;
}

type HeaderLike = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderLike, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[`Wechatpay-${name.slice(10)}`];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

export async function parseWechatPayNotify(
  rawBody: string,
  headers: HeaderLike,
  config: WechatPayConfig,
): Promise<WechatNotifyResult> {
  const body = String(rawBody || '');

  if (config.mock && body.includes('"mock"')) {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const amount = (parsed.amount || {}) as Record<string, unknown>;
    const outTradeNo = String(parsed.out_trade_no || parsed.outTradeNo || '');
    return {
      ok: true,
      mock: true,
      outTradeNo,
      transactionId: String(parsed.transaction_id || `mock-tx-${outTradeNo}`),
      tradeState: 'SUCCESS',
      amountFen: Number(amount.total || parsed.amountFen || 0),
      currency: String(amount.currency || parsed.currency || 'CNY').toUpperCase(),
    };
  }

  if (!config.apiV3Key) {
    return { ok: false, status: 503, message: 'WECHAT_PAY_API_V3_KEY 未配置' };
  }

  const timestamp = headerValue(headers, 'wechatpay-timestamp');
  const nonce = headerValue(headers, 'wechatpay-nonce');
  const signature = headerValue(headers, 'wechatpay-signature');

  let publicKey;
  try {
    const publicKeyPem = await resolvePlatformPublicKey(config);
    if (!publicKeyPem) throw new Error('missing platform public key');
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, status: 503, message: '微信支付平台公钥未配置' };
  }

  const message = `${timestamp}\n${nonce}\n${body}\n`;
  const valid = signature
    ? verify('RSA-SHA256', Buffer.from(message), publicKey, Buffer.from(signature, 'base64'))
    : false;
  if (!valid) {
    return { ok: false, status: 401, message: '微信支付回调验签失败' };
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: '回调报文不是有效 JSON' };
  }

  let resource: Record<string, unknown>;
  try {
    resource = decryptResource((envelope.resource || {}) as Record<string, unknown>, config.apiV3Key);
  } catch (error) {
    return { ok: false, status: 400, message: error instanceof Error ? error.message : '回调解密失败' };
  }

  const amount = (resource.amount || {}) as Record<string, unknown>;
  return {
    ok: true,
    outTradeNo: String(resource.out_trade_no || ''),
    transactionId: String(resource.transaction_id || ''),
    tradeState: String(resource.trade_state || ''),
    amountFen: Number(amount.total || 0),
    currency: String(amount.currency || 'CNY').toUpperCase(),
    raw: resource,
  };
}
