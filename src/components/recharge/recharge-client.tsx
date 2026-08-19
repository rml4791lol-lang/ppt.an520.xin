"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon } from "@/components/icons";
import type { RechargePlan } from "@/data/recharge";

/** 后端统一错误包裹 {ok:false,error:{code,message}}；兼容旧的字符串形态。 */
function apiErrorMessage(
  json: { error?: { message?: string } | string; message?: string } | null,
  fallback: string,
): string {
  if (json && typeof json.error === "object" && json.error !== null)
    return json.error.message ?? fallback;
  if (typeof json?.error === "string") return json.error;
  return json?.message ?? fallback;
}

function PlanCard({
  plan,
  onOrder,
}: {
  plan: RechargePlan;
  onOrder: (plan: RechargePlan) => void;
}) {
  return (
    <div
      className={`flex flex-col rounded-2xl bg-card p-6 shadow-card transition ${
        plan.recommended
          ? "border-2 border-brand"
          : "border border-line hover:shadow-pop"
      }`}
    >
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold text-ink">{plan.name}</h3>
        {plan.recommended && (
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
            首发推荐
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-3">{plan.subtitle}</p>

      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-4xl font-bold tracking-tight text-ink">
          {plan.points.toLocaleString("zh-CN")}
        </span>
        <span className="text-sm text-ink-3">🌟 星星</span>
      </div>
      {plan.bonusText && (
        <span className="mt-2 inline-block w-fit rounded-md bg-brand-soft px-2 py-0.5 text-xs text-brand">
          {plan.bonusText}
        </span>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-line pt-4 text-sm">
        <span className="text-ink-3">页面预估</span>
        <span className="font-medium text-ink">约 {plan.estimatedPages} 页 PPT 配图</span>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-ink">
          ¥{plan.price.toFixed(2).replace(/\.00$/, "")}
        </span>
        <span className="text-sm text-ink-4 line-through">
          ¥{plan.originalPrice.toFixed(2).replace(/\.00$/, "")}
        </span>
      </div>

      <button
        type="button"
        onClick={() => onOrder(plan)}
        className={`mt-4 w-full rounded-xl py-2.5 text-sm font-medium transition ${
          plan.recommended
            ? "bg-brand text-white hover:bg-brand-strong"
            : "bg-brand-soft text-brand hover:bg-brand-line"
        }`}
      >
        立即订阅
      </button>

      <div className="mt-4 rounded-xl bg-page p-3">
        <p className="text-xs text-ink-4">适用场景</p>
        <p className="mt-1 text-xs leading-5 text-ink-2">{plan.suitableFor}</p>
      </div>
    </div>
  );
}

export function RechargeClient({ plans }: { plans: RechargePlan[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<"buy" | "redeem">("buy");
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 契约：POST /api/recharge/orders {planId, channel}（后端代理实现）
  const order = async (plan: RechargePlan) => {
    setError(null);
    setNotice(null);
    console.log("[AnPPT] 下单占位：", { planId: plan.id, channel: "wechat" });
    try {
      const res = await fetch("/api/recharge/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-anppt-action": "1" },
        body: JSON.stringify({ planId: plan.id, channel: "wechat" }),
      });
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent("/recharge")}`);
        return;
      }
      if (res.status === 404) {
        setNotice("支付通道接入中，敬请期待");
        return;
      }
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        setNotice("订单已创建，请按提示完成支付");
      } else {
        setError(apiErrorMessage(json, "下单失败，请稍后再试"));
      }
    } catch {
      setNotice("支付通道接入中，敬请期待");
    }
  };

  // 契约：POST /api/points/redemption/preview {code} → redeem（后端代理实现）
  const redeem = async () => {
    const value = code.trim();
    if (!value) {
      setError("请输入兑换码");
      return;
    }
    setError(null);
    setNotice(null);
    setRedeeming(true);
    try {
      const res = await fetch("/api/points/redemption/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-anppt-action": "1" },
        body: JSON.stringify({ code: value }),
      });
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent("/recharge")}`);
        return;
      }
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        setNotice("兑换成功，星星已到账");
        setCode("");
      } else {
        setError(apiErrorMessage(json, "兑换失败，请检查兑换码是否正确"));
      }
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div>
      <div className="flex justify-end">
        <div className="flex rounded-full bg-page p-1">
          {(
            [
              { key: "buy", label: "购买积分" },
              { key: "redeem", label: "兑换积分" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-full px-6 py-2 text-sm transition ${
                tab === t.key
                  ? "bg-card font-medium text-ink shadow-card"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "buy" ? (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} onOrder={order} />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-line bg-card p-8 shadow-card">
          <h3 className="text-base font-semibold text-ink">兑换码兑换</h3>
          <p className="mt-2 text-sm leading-6 text-ink-3">
            输入你获得的兑换码，兑换成功后星星将直接进入余额，可用于生成页面。
          </p>
          <div className="mt-5 flex max-w-md gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="请输入兑换码"
              className="min-w-0 flex-1 rounded-xl border border-line px-4 py-2.5 text-sm uppercase outline-none transition placeholder:normal-case placeholder:text-ink-4 focus:border-brand"
            />
            <button
              type="button"
              disabled={redeeming}
              onClick={() => void redeem()}
              className="shrink-0 rounded-xl bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-60"
            >
              {redeeming ? "兑换中…" : "兑换"}
            </button>
          </div>
          <ul className="mt-5 space-y-1.5 text-xs leading-5 text-ink-4">
            <li>· 兑换码区分大小写，请注意不要输入多余空格</li>
            <li>· 每个兑换码仅可使用一次，兑换后立即生效</li>
            <li>· 星星有效期与购买星星一致，生成失败自动退回</li>
          </ul>
        </div>
      )}

      {(notice || error) && (
        <p
          className={`mt-4 rounded-xl px-4 py-2.5 text-sm ${
            error ? "bg-danger-soft text-danger" : "bg-brand-softer text-brand"
          }`}
        >
          {error ?? notice}
        </p>
      )}
    </div>
  );
}

export function BenefitsCheck({ text, badge }: { text: string; badge: string | null }) {
  return (
    <li className="flex items-start gap-2 text-sm leading-6 text-ink-2">
      <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
        <CheckIcon width={10} height={10} />
      </span>
      <span>
        {text}
        {badge && (
          <span className="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">
            {badge}
          </span>
        )}
      </span>
    </li>
  );
}
