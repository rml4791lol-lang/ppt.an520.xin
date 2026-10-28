// 进程启动钩子：在服务就绪前装配插件 profile，缺服务键在这里就失败（ADR-0001 G3）；
// 并登记生成恢复的运行源（模块源只能由顶层组合根注入，平台件不得 import 模块）。
// NEXT_RUNTIME 是 Next 的编译期常量，非 node bundle 不会带上 node-only 的装配代码。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startDefaultPlugins } = await import('./lib/plugin/default');
    startDefaultPlugins();
    const { registerGenerationRecoverySources } = await import('./recovery-assembly');
    registerGenerationRecoverySources();
  }
}
