"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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

type PayChannel = "wechat" | "alipay";

/** 对齐 src/lib/server/recharge.ts 的 PublicOrder。 */
interface OrderView {
  orderNo: string;
  planId: string;
  amountFen: number;
  credits: number;
  status: "pending" | "paid" | "expired" | "cancelled";
  provider: "wechat" | "epay" | "mock";
  codeUrl: string;
  checkoutUrl: string;
}

function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(2).replace(/\.00$/, "");
}

function PlanCard({
  plan,
  ordering,
  onOrder,
}: {
  plan: RechargePlan;
  ordering: boolean;
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
        disabled={ordering}
        onClick={() => onOrder(plan)}
        className={`mt-4 w-full rounded-xl py-2.5 text-sm font-medium transition disabled:opacity-60 ${
          plan.recommended
            ? "bg-brand text-white hover:bg-brand-strong"
            : "bg-brand-soft text-brand hover:bg-brand-line"
        }`}
      >
        {ordering ? "创建订单…" : "立即购买"}
      </button>

      <div className="mt-4 rounded-xl bg-page p-3">
        <p className="text-xs text-ink-4">适用场景</p>
        <p className="mt-1 text-xs leading-5 text-ink-2">{plan.suitableFor}</p>
      </div>
    </div>
  );
}

/** 支付面板：扫码 / 跳转收银台 + 2.5s 轮询订单状态直到支付成功或过期。 */
function PaymentPanel({
  order,
  mock,
  plan,
  onClose,
}: {
  order: OrderView;
  mock: boolean;
  plan: RechargePlan;
  onClose: (paid: boolean) => void;
}) {
  const router = useRouter();
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<OrderView["status"]>(order.status);
  const [pollError, setPollError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isWechat = order.provider === "wechat" || order.provider === "mock";
  const paid = status === "paid";
  const dead = status === "expired" || status === "cancelled";

  // codeUrl → 二维码图片（qrcode 按需动态加载，不进首屏包）
  useEffect(() => {
    let alive = true;
    setQr(null);
    if (order.codeUrl) {
      import("qrcode")
        .then((mod) =>
          mod.toDataURL(order.codeUrl, { width: 480, margin: 1 }),
        )
        .then((url) => {
          if (alive) setQr(url);
        })
        .catch(() => {
          if (alive) setQr(null);
        });
    }
    return () => {
      alive = false;
    };
  }, [order.codeUrl]);

  // 轮询订单状态
  useEffect(() => {
    if (status !== "pending") return;
    timerRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/recharge/orders?orderNo=${encodeURIComponent(order.orderNo)}`,
        );
        const json = await res.json().catch(() => null);
        if (res.ok && json?.ok && json.data?.order) {
          const next = String(json.data.order.status) as OrderView["status"];
          if (next !== "pending") {
            setStatus(next);
            if (next === "paid") router.refresh();
          }
        }
      } catch {
        setPollError(true);
      }
    }, 2500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [order.orderNo, status, router]);

  return (
    <div className="mx-auto mt-6 max-w-md rounded-2xl border border-line bg-card p-8 text-center shadow-card">
      {paid ? (
        <>
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand">
            <CheckIcon width={22} height={22} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-ink">支付成功</h3>
          <p className="mt-2 text-sm leading-6 text-ink-3">
            {plan.name} · {order.credits.toLocaleString("zh-CN")}🌟 已到账
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => router.push("/account/credits")}
              className="rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              查看积分明细
            </button>
            <button
              type="button"
              onClick={() => onClose(true)}
              className="rounded-xl bg-brand-soft px-5 py-2.5 text-sm font-medium text-brand transition hover:bg-brand-line"
            >
              继续购买
            </button>
          </div>
        </>
      ) : dead ? (
        <>
          <h3 className="text-lg font-semibold text-ink">订单已失效</h3>
          <p className="mt-2 text-sm leading-6 text-ink-3">
            订单超时未支付已关闭，请重新下单。
          </p>
          <button
            type="button"
            onClick={() => onClose(false)}
            className="mt-6 rounded-xl bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            重新下单
          </button>
        </>
      ) : (
        <>
          <div className="flex items-start justify-between text-left">
            <div>
              <h3 className="text-lg font-semibold text-ink">
                {isWechat ? "微信扫码支付" : "支付宝支付"}
              </h3>
              <p className="mt-1 text-sm text-ink-3">
                {plan.name} ·{" "}
                <span className="font-semibold text-ink">¥{fenToYuan(order.amountFen)}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => onClose(false)}
              aria-label="返回套餐"
              className="rounded-lg px-2 py-1 text-lg leading-none text-ink-4 transition hover:bg-page hover:text-ink"
            >
              ×
            </button>
          </div>

          {order.codeUrl ? (
            <div className="mx-auto mt-5 flex h-52 w-52 items-center justify-center overflow-hidden rounded-xl border border-line bg-white">
              {qr ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qr} alt="支付二维码" className="h-full w-full" />
              ) : (
                <span className="text-xs text-ink-4">二维码生成中…</span>
              )}
            </div>
          ) : null}

          {order.checkoutUrl ? (
            <a
              href={order.checkoutUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-5 block rounded-xl bg-brand px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              跳转支付宝收银台
            </a>
          ) : null}

          <p className="mt-4 text-sm text-ink-3">
            {isWechat ? "请使用微信扫一扫完成支付" : "请使用支付宝扫码或跳转收银台完成支付"}
          </p>
          <p className="mt-2 flex items-center justify-center gap-2 text-xs text-ink-4">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
            等待支付结果…支付成功后自动到账
          </p>
          {mock && (
            <p className="mt-2 rounded-lg bg-page px-3 py-1.5 text-xs text-ink-4">
              Mock 模式：扫码不会真实扣款，仅用于联调
            </p>
          )}
          {pollError && (
            <p className="mt-2 text-xs text-danger">状态刷新异常，请保持网络畅通</p>
          )}
          <p className="mt-4 text-xs text-ink-4">订单号 {order.orderNo}</p>
        </>
      )}
    </div>
  );
}

export function RechargeClient({ plans }: { plans: RechargePlan[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<"buy" | "redeem">("buy");
  const [channel, setChannel] = useState<PayChannel>("wechat");
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [orderingId, setOrderingId] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    order: OrderView;
    mock: boolean;
    plan: RechargePlan;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const order = async (plan: RechargePlan) => {
    setError(null);
    setNotice(null);
    setOrderingId(plan.id);
    try {
      const res = await fetch("/api/recharge/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-anppt-action": "1" },
        body: JSON.stringify({ planId: plan.id, channel }),
      });
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent("/recharge")}`);
        return;
      }
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && json.data?.order) {
        setPending({ order: json.data.order, mock: Boolean(json.data.mock), plan });
      } else {
        setError(apiErrorMessage(json, "下单失败，请稍后再试"));
      }
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setOrderingId(null);
    }
  };

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
        router.refresh();
      } else {
        setError(apiErrorMessage(json, "兑换失败，请检查兑换码是否正确"));
      }
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setRedeeming(false);
    }
  };

  if (pending) {
    return (
      <PaymentPanel
        order={pending.order}
        mock={pending.mock}
        plan={pending.plan}
        onClose={() => setPending(null)}
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        {tab === "buy" ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-ink-3">支付方式</span>
            <div className="flex rounded-full bg-page p-1">
              {(
                [
                  { key: "wechat", label: "微信支付" },
                  { key: "alipay", label: "支付宝" },
                ] as const
              ).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setChannel(c.key)}
                  className={`rounded-full px-4 py-1.5 text-sm transition ${
                    channel === c.key
                      ? "bg-card font-medium text-ink shadow-card"
                      : "text-ink-3 hover:text-ink"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <span />
        )}
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
            <PlanCard
              key={plan.id}
              plan={plan}
              ordering={orderingId === plan.id}
              onOrder={order}
            />
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
