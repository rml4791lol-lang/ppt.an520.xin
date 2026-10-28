// 生成恢复的运行源装配点（顶层组合根）：平台恢复入口不得 import 功能模块
// （docs/DEVELOPMENT.md §1），模块源只在这里登记。
// 进程启动钩子 src/instrumentation.ts 与测试入口都调用本函数，两处共用一套登记口径。
import { listRunSources, registerRunSources } from './lib/server/generation/run-source';
import { registerPlatformRunSources } from './lib/server/generation/platform-run-sources';
import { pptToBaseRunSource } from './modules/ppt-to-base/server/recovery';

/** 装配期登记全部恢复运行源；重复调用幂等，返回域名清单（启动日志与测试断言用）。 */
export function registerGenerationRecoverySources(): string[] {
  registerPlatformRunSources();
  registerRunSources([pptToBaseRunSource]);
  const domains = listRunSources().map((source) => source.domain);
  console.log(`[anppt-v2][recovery] 启动期登记运行源：${domains.join(', ')}`);
  return domains;
}
