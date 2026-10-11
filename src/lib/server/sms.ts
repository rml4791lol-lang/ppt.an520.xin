// 阿里云短信 SendSms（签名 GET，dysmsapi 2017-05-25）。
// 移植自 slideflow-studio server/otp-delivery.mjs 的线上验证实现。
// 配置：ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET / ALIYUN_SMS_SIGN_NAME / ALIYUN_SMS_TEMPLATE_CODE。
import { createHmac, randomUUID } from 'node:crypto';
import { getEnv } from './env';
import { ApiError } from './http';
import { logProblem } from './problem-log';

const ALIYUN_SMS_ENDPOINT = 'https://dysmsapi.aliyuncs.com';

function percentEncode(value: string): string {
  return encodeURIComponent(String(value))
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
}

function sign(params: Record<string, string>, secret: string): string {
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`;
  return createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64');
}

function aliyunTimestamp(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function sendSmsCode(phone: string, code: string): Promise<void> {
  const env = getEnv();
  if (!env.smsReady) {
    throw new ApiError('OTP_DELIVERY_UNAVAILABLE', '短信验证码暂不可用，请使用邮箱登录', 503, true);
  }
  const params: Record<string, string> = {
    AccessKeyId: env.aliyunSms.accessKeyId,
    Action: 'SendSms',
    Format: 'JSON',
    PhoneNumbers: phone,
    RegionId: 'cn-hangzhou',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    SignName: env.aliyunSms.signName,
    TemplateCode: env.aliyunSms.templateCode,
    TemplateParam: JSON.stringify({ code }),
    Timestamp: aliyunTimestamp(),
    Version: '2017-05-25',
  };
  params.Signature = sign(params, env.aliyunSms.accessKeySecret);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${ALIYUN_SMS_ENDPOINT}/?${canonicalQuery(params)}`, {
      method: 'GET',
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as { Code?: string; Message?: string } | null;
    if (!response.ok || payload?.Code !== 'OK') {
      logProblem({
        category: 'sms',
        level: 'error',
        message: `阿里云短信发送被拒（${payload?.Code || response.status}）`,
        detail: payload?.Message,
      });
      throw new ApiError('OTP_DELIVERY_FAILED', '短信验证码发送失败，请稍后重试', 503, true);
    }
  } finally {
    clearTimeout(timeout);
  }
}
