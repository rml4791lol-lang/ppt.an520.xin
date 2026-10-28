import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 架构边界（docs/DEVELOPMENT.md §1 金字塔 + 模块纪律的机器执行）：
  // 平台件（src/lib）不得 import 功能模块（src/modules）；模块之间不交叉（新增模块时按对补 zone）。
  {
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/lib",
              from: "./src/modules",
            },
            // 平台件不得 import 插件实现（只能经 src/lib/plugin/contracts 契约 + ctx 服务键）；
            // 唯一例外 = 组合根 src/lib/plugin/default.ts（下方 overrides 登记）。
            {
              target: "./src/lib",
              from: "./src/plugins",
            },
            // 插件边界（docs/PLUGIN-ARCHITECTURE.md §2）：插件之间禁止直接 import，
            // 只允许经 ctx 服务协作或依赖 src/lib；新增插件时按对补 zone。
            {
              target: "./src/plugins/pricing",
              from: "./src/plugins/models",
            },
            // 插件不得 import 平台内部实现（ADR-0001 G4）：运行参数经 ctx 注入的 config 服务取用，
            // 插件只依赖 src/lib/plugin/contracts 里的契约类型。
            {
              target: "./src/plugins",
              from: "./src/lib/server",
            },
            // 插件不得 import 具体功能模块（ADR-0001 G4）：插件要独立可分发，模块实现必须随插件迁移。
            // ppt-replicate 的 strangler 残留在这两个文件上登记例外（见下方 overrides 与 PLUGIN-ARCHITECTURE §5）。
            {
              target: "./src/plugins",
              from: "./src/modules",
            },
            {
              target: "./src/plugins/models",
              from: "./src/plugins/pricing",
            },
          ],
        },
      ],
    },
  },
  // 登记例外：lib/plugin/default.ts 是插件组合根（boot defaultProfile 必须 import 插件清单）。
  {
    files: ["src/lib/plugin/default.ts"],
    rules: { "import/no-restricted-paths": "off" },
  },
  // 登记例外（strangler 迁移期，ADR-0001 G4）：ppt-replicate 的 UI 贡献点仍依赖模块实现——
  // ui.ts 懒加载模块面板，beautify-tab.tsx 复用模块的文件交接工具。迁移按 PLUGIN-ARCHITECTURE §5
  // 的「ppt-replicate 整块迁入」执行，完成后删除本例外、zone 对全插件生效。
  {
    files: ["src/plugins/ppt-replicate/ui.ts", "src/plugins/ppt-replicate/client/beautify-tab.tsx"],
    rules: { "import/no-restricted-paths": "off" },
  },
  // 登记例外：生成恢复唯一入口是恢复域的组装点——模块表只由模块读写，平台这里只注入判活口径、
  // 调度模块导出的结算入口（「平台件不得 import 模块」的通用禁令让位于依赖倒置）。
  {
    files: ["src/lib/server/generation/recovery.ts"],
    rules: { "import/no-restricted-paths": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local generated previews and test artifacts are already gitignored.
    "output/**",
    "scripts/output/**",
    // pdfjs worker is copied from node_modules before dev/build.
    "public/pdf.worker.min.mjs",
    // HTMLPPT 转换工具链（2026-10-26 迁入 tools/，Python + 独立脚本，不参与 Next 应用构建与类型检查）。
    "tools/**",
    // 并行 agent 的工作树是同一批源码的嵌套 checkout（scripts/worktree.mjs 产出）：
    // 不忽略会把同一份源码 lint 两遍，且树内状态独立、误报会污染主仓的门。
    ".worktrees/**",
  ]),
]);

export default eslintConfig;
