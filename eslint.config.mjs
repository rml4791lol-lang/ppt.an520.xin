import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 架构边界（docs/DEVELOPMENT.md §1 金字塔 + 模块纪律的机器执行）：
  // 平台件（src/lib）不得 import 功能模块（src/modules）；模块之间不交叉（新增模块时按对补 zone）。
  // 例外：single-pages.ts 承载复刻分支是登记过的平台扩展点（src/modules/ppt-replicate/README.md）。
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
            {
              target: "./src/plugins/models",
              from: "./src/plugins/pricing",
            },
          ],
        },
      ],
    },
  },
  // 登记例外：single-pages.ts 承载复刻生图分支（模块与单页运行时共享扣费/恢复，
  // 见 src/modules/ppt-replicate/README.md「依赖的平台件」）。新增例外必须同步登记。
  {
    files: ["src/lib/server/generation/single-pages.ts"],
    rules: { "import/no-restricted-paths": "off" },
  },
  // 登记例外：lib/plugin/default.ts 是插件组合根（boot defaultProfile 必须 import 插件清单）。
  {
    files: ["src/lib/plugin/default.ts"],
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
  ]),
]);

export default eslintConfig;
