"use client";

// 全站唯一的未登录呈现：说清"你刚才想做什么"、给一步可执行的下一步、不提供必然失败的重试。
// 六个模块（项目/导出/星星/工作台/美化/转底图）都走这里，措辞只在 AUTH_SCENES 里定义一次。
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AUTH_SCENES, type AuthScene } from "@/data/auth-scenes";

export function LoginWall({
  scene,
  detail,
  next,
}: {
  scene: AuthScene;
  /** 一句话补充：为什么这件事需要账号 */
  detail?: string;
  /** 登录后回到哪里；缺省回当前路径 */
  next?: string;
}) {
  const pathname = usePathname();
  const target = next ?? pathname ?? "/";
  const href = `/login?next=${encodeURIComponent(target)}&from=${scene}`;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-line bg-card px-5 py-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">登录后{AUTH_SCENES[scene]}</p>
        {detail && <p className="mt-1 text-sm leading-6 text-ink-3">{detail}</p>}
      </div>
      <Link
        href={href}
        className="shrink-0 self-start rounded-full bg-brand px-4 py-1.5 text-xs font-medium text-white transition hover:bg-brand-strong sm:self-auto"
      >
        去登录
      </Link>
    </div>
  );
}
