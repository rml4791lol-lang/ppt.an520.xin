"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIcon,
  AlertIcon,
  CheckIcon,
  CoinIcon,
  CopyIcon,
  DatabaseIcon,
  KeyIcon,
  RefreshIcon,
  ServerIcon,
  SettingsIcon,
  ShieldIcon,
  StarIcon,
  UsersIcon,
} from "@/components/icons";

type ConfigGroup = "llm" | "image" | "editable" | "capacity";
type ConfigSource = "runtime" | "environment" | "default" | "missing";
type IntegrationKind = "llm" | "image" | "editable";

interface ConfigField {
  key: string;
  group: ConfigGroup;
  label: string;
  description: string;
  input: "text" | "password" | "number" | "url";
  secret: boolean;
  value: string | null;
  configured: boolean;
  source: ConfigSource;
  fingerprint: string | null;
  runtimeOverride: boolean;
  min?: number;
  max?: number;
}

interface ConfigPayload {
  storageReady: boolean;
  fields: ConfigField[];
}

type FeatureFlagState = "off" | "beta" | "public";

interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  state: FeatureFlagState;
  updatedAt: number;
}

interface TaskSnapshot {
  kind: "generation" | "export";
  status: string;
  label: string;
  progress: number;
  error: string;
  updatedAt: number;
}

interface UserSnapshot {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  plan: string;
  balance: number;
  createdAt: number;
  lastLoginAt: number | null;
  activeSessions: number;
  projectCount: number;
  activeJobs: number;
  failures24h: number;
  redeemedCredits: number;
  lastActivityAt: number | null;
  lastActivityLabel: string;
  lastTask: TaskSnapshot | null;
  accountHealthy: boolean;
}

interface AuditView {
  id: string;
  adminLabel: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

interface OverviewPayload {
  generatedAt: number;
  compact: boolean;
  metrics: {
    totalUsers: number;
    newUsers24h: number;
    activeGenerationJobs: number;
    activeExportJobs: number;
    failures24h: number;
    totalProjects: number;
  };
  latestUsers?: UserSnapshot[];
  resources?: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    databaseBytes: number | null;
  };
  integrations?: {
    llm: boolean;
    image: boolean;
    editable: boolean;
    smtp: boolean;
    sms: boolean;
    payment: boolean;
    adminConfigStorage: boolean;
  };
  audits?: AuditView[];
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface CheckResult {
  kind: IntegrationKind;
  ok: true;
  latencyMs: number;
  endpoint: string;
  message: string;
}

interface AdminClientProps {
  admin: {
    id: string;
    displayName: string;
    email: string | null;
  };
}

const GROUPS: Array<{
  key: ConfigGroup;
  title: string;
  short: string;
  description: string;
  checkKind?: IntegrationKind;
}> = [
  { key: "llm", title: "大纲与内容模型", short: "LLM", description: "主模型、回退链与 OpenAI 兼容接口。", checkKind: "llm" },
  { key: "image", title: "图片生成", short: "生图", description: "生图上游、模型、尺寸与密钥。", checkKind: "image" },
  { key: "editable", title: "可编辑转换", short: "Image2PPT", description: "按主通道检查额度接口，不会创建付费转换任务。", checkKind: "editable" },
  { key: "capacity", title: "并发与恢复", short: "并发", description: "修改仅作用于后续新请求，在途任务继续使用原配置。" },
];

const SOURCE_LABEL: Record<ConfigSource, string> = {
  runtime: "后台覆盖",
  environment: "服务器环境",
  default: "系统默认",
  missing: "未配置",
};

const AUDIT_LABEL: Record<string, string> = {
  "config.update": "更新运行时配置",
  "integration.check": "检查上游连接",
  "redemption_codes.generate": "生成兑换码",
  "user.watch": "加入重点监控",
  "user.unwatch": "取消重点监控",
};

async function adminFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !payload?.ok || payload.data === undefined) {
    throw new Error(payload?.error?.message || "服务器开小差了，请稍后重试");
  }
  return payload.data;
}

function mutationInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-anppt-action": "1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function formatDate(value: number | null | undefined): string {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = Math.max(0, value);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor((seconds % 86400) / 3600)} 小时`;
}

function Toast({ message, tone }: { message: string; tone: "ok" | "error" }) {
  return (
    <div
      role="status"
      className={`fixed right-4 top-4 z-[80] max-w-sm rounded-2xl border px-4 py-3 text-sm shadow-pop ${
        tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
      }`}
    >
      {message}
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ width?: number; height?: number; className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Icon width={18} height={18} />
        </span>
        <div>
          <h2 className="font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-xs leading-5 text-ink-3">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  warning = false,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: React.ComponentType<{ width?: number; height?: number }>;
  warning?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-card sm:p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-3">{label}</span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${warning ? "bg-red-50 text-red-600" : "bg-brand-soft text-brand"}`}>
          <Icon width={16} height={16} />
        </span>
      </div>
      <div className={`mt-3 text-2xl font-semibold tracking-tight ${warning ? "text-red-600" : "text-ink"}`}>{value}</div>
      <div className="mt-1 text-[11px] text-ink-3">{hint}</div>
    </div>
  );
}

function IntegrationBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-page/60 px-3 py-2.5">
      <span className="text-sm text-ink-2">{label}</span>
      <span className={`flex items-center gap-1.5 text-xs font-medium ${ready ? "text-emerald-700" : "text-amber-700"}`}>
        <span className={`h-2 w-2 rounded-full ${ready ? "bg-emerald-500" : "bg-amber-400"}`} />
        {ready ? "已配置" : "待配置"}
      </span>
    </div>
  );
}

function UserStatus({ user }: { user: UserSnapshot }) {
  if (!user.accountHealthy) return { label: "账号异常", tone: "bg-red-50 text-red-700" };
  if (user.activeJobs > 0) return { label: "正在使用", tone: "bg-amber-50 text-amber-700" };
  if (user.failures24h > 0) return { label: "需要关注", tone: "bg-red-50 text-red-700" };
  if (user.activeSessions > 0) return { label: "登录正常", tone: "bg-emerald-50 text-emerald-700" };
  return { label: "账号正常", tone: "bg-emerald-50 text-emerald-700" };
}

export function AdminClient({ admin }: AdminClientProps) {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [activeGroup, setActiveGroup] = useState<ConfigGroup>("llm");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [clearKeys, setClearKeys] = useState<Set<string>>(() => new Set());
  const [checkResults, setCheckResults] = useState<Partial<Record<IntegrationKind, CheckResult>>>({});
  const [busyAction, setBusyAction] = useState<string>("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "error" } | null>(null);
  const [codeForm, setCodeForm] = useState({ credits: "1000", count: "1", batch: "admin", expiresDays: "" });
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);

  const showToast = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const loadFull = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [nextOverview, nextConfig, nextFlags] = await Promise.all([
        adminFetch<OverviewPayload>("/api/admin/overview"),
        adminFetch<ConfigPayload>("/api/admin/config"),
        adminFetch<{ flags: FeatureFlag[] }>("/api/admin/feature-flags"),
      ]);
      setOverview(nextOverview);
      setConfig(nextConfig);
      setFlags(nextFlags.flags);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "后台数据加载失败", "error");
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

  const loadCompact = useCallback(async () => {
    try {
      const compact = await adminFetch<OverviewPayload>("/api/admin/overview?compact=1");
      setOverview((current) => current ? {
        ...current,
        generatedAt: compact.generatedAt,
        metrics: compact.metrics,
      } : compact);
    } catch {
      // 静默保留上一帧，避免轮询抖动打扰管理员；手动刷新仍会显示错误。
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFull(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFull]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void loadCompact();
    };
    const timer = window.setInterval(tick, 10_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [loadCompact]);

  const groupFields = useMemo(
    () => config?.fields.filter((field) => field.group === activeGroup) ?? [],
    [activeGroup, config],
  );
  const activeGroupMeta = GROUPS.find((group) => group.key === activeGroup) ?? GROUPS[0];

  const updateDraft = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setClearKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const toggleClear = (key: string) => {
    setClearKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDraft((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const saveConfig = async () => {
    if (!config?.storageReady) {
      showToast("服务器尚未配置管理员加密主密钥，当前不能保存", "error");
      return;
    }
    const values: Record<string, string> = {};
    for (const field of config.fields) {
      if (!(field.key in draft) || clearKeys.has(field.key)) continue;
      const value = draft[field.key];
      if (field.secret && !value.trim()) continue;
      values[field.key] = value;
    }
    if (Object.keys(values).length === 0 && clearKeys.size === 0) {
      showToast("没有需要保存的变化", "error");
      return;
    }
    setBusyAction("save-config");
    try {
      const result = await adminFetch<{ config: ConfigPayload }>(
        "/api/admin/config",
        mutationInit("PUT", { values, clearKeys: [...clearKeys] }),
      );
      setConfig(result.config);
      setDraft({});
      setClearKeys(new Set());
      showToast("配置已加密保存，仅影响后续新请求");
      await loadCompact();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "配置保存失败", "error");
    } finally {
      setBusyAction("");
    }
  };

  const checkIntegration = async (kind: IntegrationKind) => {
    const fields = config?.fields.filter((field) => field.group === activeGroup) ?? [];
    const values: Record<string, string> = {};
    for (const field of fields) {
      if (field.key in draft && !clearKeys.has(field.key) && draft[field.key].trim()) values[field.key] = draft[field.key];
    }
    setBusyAction(`check-${kind}`);
    try {
      const result = await adminFetch<CheckResult>(
        "/api/admin/integrations/check",
        mutationInit("POST", { kind, values }),
      );
      setCheckResults((current) => ({ ...current, [kind]: result }));
      showToast(result.message);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "连接检查失败", "error");
    } finally {
      setBusyAction("");
    }
  };

  const toggleTester = async (user: UserSnapshot) => {
    const nextRole = user.role === "tester" ? "user" : "tester";
    setBusyAction(`role-${user.id}`);
    try {
      await adminFetch<{ role: string }>(
        `/api/admin/users/${encodeURIComponent(user.id)}/role`,
        mutationInit("POST", { role: nextRole }),
      );
      showToast(nextRole === "tester" ? `${user.displayName} 已设为测试用户` : `${user.displayName} 已取消测试用户`);
      await loadFull(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "测试用户设置失败", "error");
    } finally {
      setBusyAction("");
    }
  };

  const setFlag = async (key: string, state: FeatureFlagState) => {
    setBusyAction(`flag-${key}`);
    try {
      const result = await adminFetch<{ flags: FeatureFlag[] }>(
        "/api/admin/feature-flags",
        mutationInit("PUT", { key, state }),
      );
      setFlags(result.flags);
      showToast("功能开关已更新");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "开关更新失败", "error");
    } finally {
      setBusyAction("");
    }
  };

  const generateCodes = async () => {
    setBusyAction("generate-codes");
    try {
      const result = await adminFetch<{ codes: string[] }>(
        "/api/admin/redemption-codes",
        mutationInit("POST", {
          credits: Number(codeForm.credits),
          count: Number(codeForm.count),
          batch: codeForm.batch,
          expiresDays: codeForm.expiresDays ? Number(codeForm.expiresDays) : null,
        }),
      );
      setGeneratedCodes(result.codes);
      showToast(`已生成 ${result.codes.length} 张兑换码，明文仅在这里展示`);
      await loadFull(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "兑换码生成失败", "error");
    } finally {
      setBusyAction("");
    }
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(generatedCodes.join("\n"));
      showToast("兑换码已复制");
    } catch {
      showToast("浏览器未允许复制，请手动选择", "error");
    }
  };

  if (initialLoading && (!overview || !config)) {
    return (
      <div className="mx-auto flex min-h-[65vh] max-w-6xl items-center justify-center px-4">
        <div className="text-center">
          <span className="mx-auto flex h-12 w-12 animate-pulse items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <ShieldIcon width={24} height={24} />
          </span>
          <p className="mt-4 text-sm font-medium text-ink-2">正在读取安全状态与在途任务…</p>
          <p className="mt-1 text-xs text-ink-3">不读取用户文档正文，不触发任何付费上游请求</p>
        </div>
      </div>
    );
  }

  if (!overview || !config) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center">
        <AlertIcon width={28} height={28} className="mx-auto text-red-500" />
        <h1 className="mt-4 text-lg font-semibold">管理员数据暂时不可用</h1>
        <button type="button" onClick={() => void loadFull()} className="mt-5 rounded-xl bg-dark px-4 py-2 text-sm font-medium text-white">
          重新加载
        </button>
      </div>
    );
  }

  const activeTasks = overview.metrics.activeGenerationJobs + overview.metrics.activeExportJobs;
  const resource = overview.resources;
  const integrations = overview.integrations;

  return (
    <div className="pb-16">
      {toast && <Toast message={toast.message} tone={toast.tone} />}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
        <section className="relative overflow-hidden rounded-3xl border border-brand-line bg-gradient-to-br from-[#fff7f1] via-white to-[#fffaf6] px-5 py-6 shadow-card sm:px-8 sm:py-8">
          <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-brand/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
                <ShieldIcon width={15} height={15} />
                AnPPT Control Room
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">系统管理</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-2">
                管理上游配置、并发容量与重点用户状态。所有密钥仅可替换，不会回显；老板账号与最新注册用户均采用只读监控。
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="rounded-full border border-line bg-white px-2.5 py-1">管理员：{admin.displayName}</span>
                {admin.email && <span className="rounded-full border border-line bg-white px-2.5 py-1">{admin.email}</span>}
                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700">服务端权限已验证</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/admin/problems"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3.5 text-sm font-medium text-ink-2 transition hover:text-ink"
              >
                <AlertIcon width={15} height={15} />
                问题日志
              </Link>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => void loadFull()}
                className="flex h-10 items-center justify-center gap-2 rounded-xl bg-dark px-4 text-sm font-medium text-white transition hover:bg-ink disabled:opacity-60"
              >
                <RefreshIcon width={16} height={16} className={refreshing ? "animate-spin" : ""} />
                {refreshing ? "刷新中" : "刷新全量状态"}
              </button>
            </div>
          </div>
        </section>

        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-900">
          <CheckIcon width={18} height={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">在线用户保护已启用</p>
            <p className="mt-0.5 text-xs leading-5 text-emerald-800">
              配置热更新只影响保存后的新请求；已经开始的生成与转可编辑任务继续持有原配置。页面每 10 秒仅轮询轻量状态，切到后台后暂停。
            </p>
          </div>
        </div>

        <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard label="用户总数" value={overview.metrics.totalUsers} hint={`近 24h 新增 ${overview.metrics.newUsers24h}`} icon={UsersIcon} />
          <MetricCard label="在途任务" value={activeTasks} hint={`生成 ${overview.metrics.activeGenerationJobs} · 导出 ${overview.metrics.activeExportJobs}`} icon={ActivityIcon} />
          <MetricCard label="近 24h 失败" value={overview.metrics.failures24h} hint={overview.metrics.failures24h ? "建议查看重点用户与日志" : "主链路状态平稳"} icon={AlertIcon} warning={overview.metrics.failures24h > 0} />
          <MetricCard label="项目总数" value={overview.metrics.totalProjects} hint="仅统计未删除项目" icon={DatabaseIcon} />
          <div className="col-span-2 lg:col-span-1">
            <MetricCard label="后台刷新" value="10s" hint={`最近 ${formatDate(overview.generatedAt)}`} icon={RefreshIcon} />
          </div>
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
            <SectionTitle icon={ServerIcon} title="系统与服务状态" description="轻量只读采样，不触发外部付费动作。" />
            <div className="space-y-5 p-5 sm:p-6">
              {resource && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-page p-3">
                    <div className="text-[10px] text-ink-3">进程运行时长</div>
                    <div className="mt-1 text-sm font-semibold">{formatDuration(resource.uptimeSeconds)}</div>
                  </div>
                  <div className="rounded-xl bg-page p-3">
                    <div className="text-[10px] text-ink-3">Node RSS 内存</div>
                    <div className="mt-1 text-sm font-semibold">{formatBytes(resource.rssBytes)}</div>
                  </div>
                  <div className="rounded-xl bg-page p-3">
                    <div className="text-[10px] text-ink-3">数据盘剩余</div>
                    <div className="mt-1 text-sm font-semibold">{formatBytes(resource.diskFreeBytes)}</div>
                  </div>
                  <div className="rounded-xl bg-page p-3">
                    <div className="text-[10px] text-ink-3">数据库体积</div>
                    <div className="mt-1 text-sm font-semibold">{formatBytes(resource.databaseBytes)}</div>
                  </div>
                </div>
              )}
              {integrations && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <IntegrationBadge label="LLM 大纲" ready={integrations.llm} />
                  <IntegrationBadge label="图片生成" ready={integrations.image} />
                  <IntegrationBadge label="转可编辑通道" ready={integrations.editable} />
                  <IntegrationBadge label="邮件验证码" ready={integrations.smtp} />
                  <IntegrationBadge label="短信验证码" ready={integrations.sms} />
                  <IntegrationBadge label="充值支付" ready={integrations.payment} />
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
            <SectionTitle icon={UsersIcon} title="最新注册用户" description="默认展示最近 12 位；可设为测试用户以体验开关板上的 beta 功能。" />
            <div className="divide-y divide-line">
              {(overview.latestUsers ?? []).map((user) => {
                const state = UserStatus({ user });
                return (
                  <div key={user.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{user.displayName}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] ${state.tone}`}>{state.label}</span>
                        {user.role === "admin" && <span className="rounded-full bg-dark px-2 py-0.5 text-[10px] text-white">管理员</span>}
                        {user.role === "tester" && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] text-violet-700">测试用户</span>}
                      </div>
                      <p className="mt-1 truncate text-xs text-ink-3">
                        @{user.username}{user.email ? ` · ${user.email}` : ""} · 注册 {formatDate(user.createdAt)}
                      </p>
                      <p className="mt-1 text-[11px] text-ink-3">{user.balance} 🌟 · {user.projectCount} 个项目 · 最近登录 {formatDate(user.lastLoginAt)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {user.role !== "admin" && (
                        <button
                          type="button"
                          disabled={busyAction === `role-${user.id}`}
                          onClick={() => void toggleTester(user)}
                          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-2 transition hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-45"
                        >
                          {busyAction === `role-${user.id}` ? "设置中" : user.role === "tester" ? "取消测试" : "设为测试"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-card shadow-card">
          <SectionTitle
            icon={SettingsIcon}
            title="API 与并发配置"
            description="密钥永不回显；数据库使用 AES-256-GCM 加密，只显示配置来源和短指纹。"
            action={
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${config.storageReady ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                {config.storageReady ? "加密存储已就绪" : "加密主密钥未配置"}
              </span>
            }
          />
          <div className="border-b border-line px-4 pt-4 sm:px-6">
            <div className="flex gap-1 overflow-x-auto pb-3">
              {GROUPS.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  onClick={() => setActiveGroup(group.key)}
                  className={`shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition ${
                    activeGroup === group.key ? "bg-dark text-white" : "bg-page text-ink-2 hover:text-ink"
                  }`}
                >
                  {group.short}
                </button>
              ))}
            </div>
          </div>
          <div className="p-4 sm:p-6">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="font-semibold text-ink">{activeGroupMeta.title}</h3>
                <p className="mt-1 text-xs leading-5 text-ink-3">{activeGroupMeta.description}</p>
              </div>
              {activeGroupMeta.checkKind && (
                <button
                  type="button"
                  disabled={busyAction === `check-${activeGroupMeta.checkKind}`}
                  onClick={() => void checkIntegration(activeGroupMeta.checkKind!)}
                  className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl border border-brand-line bg-brand-softer px-3 py-2 text-xs font-medium text-brand transition hover:bg-brand-soft disabled:opacity-50"
                >
                  <ActivityIcon width={14} height={14} />
                  {busyAction === `check-${activeGroupMeta.checkKind}` ? "检查中" : "无付费检查连接"}
                </button>
              )}
            </div>
            {activeGroupMeta.checkKind && checkResults[activeGroupMeta.checkKind] && (
              <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-800">
                {checkResults[activeGroupMeta.checkKind]?.message} · {checkResults[activeGroupMeta.checkKind]?.latencyMs}ms
              </div>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              {groupFields.map((field) => {
                const clearing = clearKeys.has(field.key);
                const currentValue = field.key in draft ? draft[field.key] : field.secret ? "" : field.value ?? "";
                return (
                  <label key={field.key} className={`block rounded-2xl border p-4 transition ${clearing ? "border-red-200 bg-red-50/50" : "border-line bg-white"}`}>
                    <span className="flex items-start justify-between gap-3">
                      <span>
                        <span className="block text-sm font-medium text-ink">{field.label}</span>
                        <span className="mt-1 block text-[11px] leading-5 text-ink-3">{field.description}</span>
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${field.source === "runtime" ? "bg-brand-soft text-brand" : field.source === "missing" ? "bg-red-50 text-red-600" : "bg-page text-ink-3"}`}>
                        {SOURCE_LABEL[field.source]}
                      </span>
                    </span>
                    <div className="mt-3">
                      <input
                        type={field.input === "password" ? "password" : field.input === "number" ? "number" : "text"}
                        min={field.min}
                        max={field.max}
                        disabled={clearing}
                        value={currentValue}
                        onChange={(event) => updateDraft(field.key, event.target.value)}
                        placeholder={field.secret ? (field.configured ? "留空表示不修改现有密钥" : "输入新密钥") : "请输入配置值"}
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 w-full rounded-xl border border-line-strong bg-white px-3 text-sm text-ink outline-none transition placeholder:text-ink-4 focus:border-brand disabled:bg-page disabled:text-ink-4"
                      />
                    </div>
                    <div className="mt-2 flex min-h-5 items-center justify-between gap-3 text-[10px] text-ink-3">
                      <span>
                        {field.secret && field.fingerprint ? `当前指纹 ${field.fingerprint}` : field.key}
                      </span>
                      {field.runtimeOverride && (
                        <button
                          type="button"
                          onClick={(event) => { event.preventDefault(); toggleClear(field.key); }}
                          className={`font-medium ${clearing ? "text-red-700" : "text-ink-3 hover:text-red-600"}`}
                        >
                          {clearing ? "撤销清除" : "清除后台覆盖"}
                        </button>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="mt-5 flex flex-col gap-3 rounded-2xl bg-page px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2 text-xs leading-5 text-ink-3">
                <KeyIcon width={15} height={15} className="mt-0.5 shrink-0 text-brand" />
                <span>保存后 30 秒内全局缓存立即失效；新请求读取新配置，在途请求不切换、不重跑。</span>
              </div>
              <button
                type="button"
                disabled={busyAction === "save-config" || !config.storageReady}
                onClick={() => void saveConfig()}
                className="h-10 shrink-0 rounded-xl bg-brand px-5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-45"
              >
                {busyAction === "save-config" ? "加密保存中" : "保存运行时配置"}
              </button>
            </div>
          </div>
        </section>

        <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-card shadow-card">
          <SectionTitle
            icon={StarIcon}
            title="功能开关板"
            description="新功能先对测试用户开放（测试态），验收通过后转公开；隐藏态仅管理员可见可用。切换即时生效，无需重启。"
          />
          <div className="divide-y divide-line">
            {flags.map((flag) => (
              <div key={flag.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{flag.label}</span>
                    <span className="rounded-full bg-page px-2 py-0.5 text-[10px] text-ink-3">{flag.key}</span>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-ink-3">{flag.description}</p>
                </div>
                <div className="flex shrink-0 rounded-xl border border-line bg-page p-0.5">
                  {(["off", "beta", "public"] as const).map((state) => (
                    <button
                      key={state}
                      type="button"
                      disabled={busyAction === `flag-${flag.key}`}
                      onClick={() => void setFlag(flag.key, state)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        flag.state === state ? "bg-dark text-white" : "text-ink-2 hover:text-ink"
                      } disabled:opacity-45`}
                    >
                      {state === "off" ? "隐藏" : state === "beta" ? "测试" : "公开"}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
          <section className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
            <SectionTitle icon={CoinIcon} title="兑换码生成" description="明文只在生成后显示一次，数据库仅保存哈希。" />
            <div className="space-y-4 p-5 sm:p-6">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-ink-3">
                  每张积分
                  <input type="number" min="1" max="1000000" value={codeForm.credits} onChange={(event) => setCodeForm((current) => ({ ...current, credits: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-line-strong px-3 text-sm text-ink outline-none focus:border-brand" />
                </label>
                <label className="text-xs text-ink-3">
                  数量
                  <input type="number" min="1" max="100" value={codeForm.count} onChange={(event) => setCodeForm((current) => ({ ...current, count: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-line-strong px-3 text-sm text-ink outline-none focus:border-brand" />
                </label>
                <label className="text-xs text-ink-3">
                  批次名
                  <input type="text" value={codeForm.batch} onChange={(event) => setCodeForm((current) => ({ ...current, batch: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-line-strong px-3 text-sm text-ink outline-none focus:border-brand" />
                </label>
                <label className="text-xs text-ink-3">
                  有效天数（可空）
                  <input type="number" min="1" max="3650" value={codeForm.expiresDays} onChange={(event) => setCodeForm((current) => ({ ...current, expiresDays: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-line-strong px-3 text-sm text-ink outline-none focus:border-brand" />
                </label>
              </div>
              <button type="button" disabled={busyAction === "generate-codes"} onClick={() => void generateCodes()} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-dark text-sm font-medium text-white transition hover:bg-ink disabled:opacity-50">
                <StarIcon width={15} height={15} />
                {busyAction === "generate-codes" ? "生成中" : "生成兑换码"}
              </button>
              {generatedCodes.length > 0 && (
                <div className="rounded-2xl border border-brand-line bg-brand-softer p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-brand">明文仅显示本次</span>
                    <button type="button" onClick={() => void copyCodes()} className="flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-strong">
                      <CopyIcon width={13} height={13} />复制全部
                    </button>
                  </div>
                  <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-white p-3 font-mono text-xs leading-6 text-ink">{generatedCodes.join("\n")}</pre>
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
            <SectionTitle icon={ActivityIcon} title="管理员操作审计" description="只记录动作、目标和脱敏结果，不保存密钥或用户文档内容。" />
            <div className="max-h-[520px] divide-y divide-line overflow-y-auto">
              {(overview.audits ?? []).length > 0 ? (overview.audits ?? []).map((audit) => (
                <div key={audit.id} className="flex gap-3 px-5 py-4 sm:px-6">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-brand" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{AUDIT_LABEL[audit.action] || audit.action}</span>
                      <span className="text-[10px] text-ink-3">{formatDate(audit.createdAt)}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-ink-3">
                      {audit.adminLabel}{audit.targetId ? ` · ${audit.targetType || "target"}: ${audit.targetId}` : ""}
                    </p>
                  </div>
                </div>
              )) : (
                <div className="px-5 py-12 text-center text-sm text-ink-3">暂无管理员操作记录</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
