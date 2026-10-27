"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, resetSessionCache, type AuthResult } from "@/lib/client/api";

type Mode = "code" | "password";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^1[3-9]\d{9}$/;

// 验证码登录支持邮箱或手机号：自动识别并做基础校验
function normalizeIdentifierInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed;
  return trimmed.replace(/[\s-]+/g, "").replace(/^\+?86(?=1[3-9]\d{9}$)/, "");
}

function isValidIdentifier(value: string): boolean {
  return EMAIL_RE.test(value) || PHONE_RE.test(value);
}

export function LoginCard({ signupBonus }: { signupBonus: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/projects";

  const [mode, setMode] = useState<Mode>("code");
  const [registering, setRegistering] = useState(false);

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [confirm, setConfirm] = useState("");

  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    const target = normalizeIdentifierInput(email);
    if (!isValidIdentifier(target)) {
      setError("请输入正确的邮箱地址或手机号");
      return;
    }
    setError(null);
    setSending(true);
    const r = await api.auth.requestOtp(target);
    setSending(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setCountdown(60);
    const timer = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    let r: AuthResult;
    if (registering) {
      if (!/^[a-z0-9_]{3,32}$/.test(username.trim()))
        r = { ok: false, message: "用户名需 3–32 位，小写字母、数字或下划线" };
      else if (!EMAIL_RE.test(email.trim())) r = { ok: false, message: "请输入正确的邮箱地址" };
      else if (password.length < 8) r = { ok: false, message: "密码至少 8 位" };
      else if (password !== confirm) r = { ok: false, message: "两次输入的密码不一致" };
      else
        r = await api.auth.register({
          account: username.trim(),
          email: email.trim(),
          password,
          confirmPassword: confirm,
        });
    } else if (mode === "code") {
      const target = normalizeIdentifierInput(email);
      if (!isValidIdentifier(target)) r = { ok: false, message: "请输入正确的邮箱地址或手机号" };
      else if (!code.trim()) r = { ok: false, message: "请输入验证码" };
      else r = await api.auth.loginWithOtp({ identifier: target, code: code.trim() });
    } else {
      if (!identifier.trim()) r = { ok: false, message: "请输入邮箱或用户名" };
      else if (!password) r = { ok: false, message: "请输入密码" };
      else r = await api.auth.loginWithPassword({ account: identifier.trim(), password });
    }
    setSubmitting(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    // 登录前壳/页面可能已缓存 authenticated:false，登录成功后必须作废，否则返回后仍显示未登录
    resetSessionCache();
    router.push(next);
    router.refresh();
  };

  const inputCls =
    "w-full rounded-xl border border-line bg-card px-4 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-4 focus:border-brand";

  return (
    <div className="flex h-full flex-col justify-center p-6 sm:p-10">
      <h2 className="text-center text-xl font-bold text-ink">
        {registering ? "注册 AnPPT 账号" : "登录 AnPPT"}
      </h2>
      <p className="mt-2 text-center text-xs text-ink-3">
        {registering ? "注册即送星星，马上开始生成" : "登录后可保存作品、查看项目和使用星星"}
      </p>

      {!registering && (
        <div className="mx-auto mt-6 flex w-full max-w-xs rounded-full bg-page p-1">
          {(
            [
              { key: "code", label: "验证码登录" },
              { key: "password", label: "密码登录" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setMode(t.key);
                setError(null);
              }}
              className={`flex-1 rounded-full py-2 text-sm transition ${
                mode === t.key
                  ? "bg-card font-medium text-ink shadow-card"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="mx-auto mt-6 w-full max-w-xs space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {registering && (
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            autoComplete="username"
            className={inputCls}
          />
        )}

        {registering || mode === "code" ? (
          <>
            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={registering ? "邮箱" : "邮箱 / 手机号"}
              autoComplete={registering ? "email" : "username"}
              className={inputCls}
            />
            {!registering && (
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="验证码"
                  autoComplete="one-time-code"
                  className={`${inputCls} min-w-0 flex-1`}
                />
                <button
                  type="button"
                  disabled={sending || countdown > 0}
                  onClick={() => void sendCode()}
                  className="shrink-0 rounded-xl border border-brand-line px-3 text-sm text-brand transition hover:bg-brand-softer disabled:cursor-not-allowed disabled:border-line disabled:text-ink-4"
                >
                  {countdown > 0 ? `${countdown}s 后重发` : sending ? "发送中…" : "发送验证码"}
                </button>
              </div>
            )}
          </>
        ) : (
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="邮箱 / 手机号 / 用户名"
            autoComplete="username"
            className={inputCls}
          />
        )}

        {(registering || mode === "password") && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            autoComplete={registering ? "new-password" : "current-password"}
            className={inputCls}
          />
        )}
        {registering && (
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="确认密码"
            autoComplete="new-password"
            className={inputCls}
          />
        )}

        {error && (
          <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs leading-5 text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-xl bg-brand py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-60"
        >
          {submitting ? "请稍候…" : registering ? "注册" : "登录"}
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-ink-3">
        {registering ? (
          <>
            已有账号？
            <button
              type="button"
              className="font-medium text-brand hover:underline"
              onClick={() => {
                setRegistering(false);
                setError(null);
              }}
            >
              去登录
            </button>
          </>
        ) : (
          <>
            没有账号？
            <button
              type="button"
              className="font-medium text-brand hover:underline"
              onClick={() => {
                setRegistering(true);
                setError(null);
              }}
            >
              注册
            </button>
          </>
        )}
      </p>

      <div className="mx-auto mt-6 w-full max-w-xs rounded-xl bg-brand-softer px-4 py-3 text-center text-xs text-brand">
        🎁 新用户赠送 {signupBonus} 🌟 星星
      </div>
    </div>
  );
}
