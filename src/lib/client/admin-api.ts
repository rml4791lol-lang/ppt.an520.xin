// 后台管理写动作（typed intent）：组件只表达动作与参数，路径与信封由 src/lib/admin-intents.ts 决定。
// 后台读接口仍走 apiFetch 的能力命名；写动作全部经意图分发。
import { dispatchIntent } from "./api";
import { toAdminActionCall, type AdminIntent, type AdminIntentParams } from "../admin-intents";

function sendIntent<T>(intent: AdminIntent): Promise<T> {
  return dispatchIntent<T>(toAdminActionCall(intent), intent);
}

/** 响应形状由调用处按既有类型收窄（各管理路由的 payload 不同） */
export function updateAdminConfig<T>(params: AdminIntentParams["updateRuntimeConfig"]): Promise<T> {
  return sendIntent({ kind: "updateRuntimeConfig", params });
}

export function setAdminFeatureFlag<T>(params: AdminIntentParams["setFeatureFlag"]): Promise<T> {
  return sendIntent({ kind: "setFeatureFlag", params });
}

export function generateRedemptionCodes<T>(params: AdminIntentParams["generateRedemptionCodes"]): Promise<T> {
  return sendIntent({ kind: "generateRedemptionCodes", params });
}

export function checkAdminIntegration<T>(params: AdminIntentParams["checkIntegration"]): Promise<T> {
  return sendIntent({ kind: "checkIntegration", params });
}

export function setAdminUserRole<T>(params: AdminIntentParams["setUserRole"]): Promise<T> {
  return sendIntent({ kind: "setUserRole", params });
}
