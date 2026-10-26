# contracts · 机器可读契约（单一事实来源）

全部由 `国金模板.potx` 反算生成，不要手改（改模板后重跑生成命令）。

| 文件 | 内容 |
|---|---|
| `describe.json` | 24 版式 / 728 槽位 / 10 主题 / 组件注册表（`htmlppt/describe@1`） |
| `describe.schema.json` | describe 输出的 JSON Schema |
| `layouts/S01.md … S24.md` | 每版式一页：槽位表（名字/类型/位置/字号/建议字数/必填/示例）+ 填写规则 |
| `deck.example.json` | deck 清单示例（24 页：页序、来源 `spec:Sxx`、主题、内容引用） |
| `deck.schema.json` | deck 清单 Schema（`htmlppt/deck@1`） |
| `layout.schema.json` | 单版式 Schema |
| `components.json` | 组件注册表种子（20 类：chrome/navigation/layout/data/asset/atom/chart） |
| `component.schema.json` | 组件注册表 Schema（`htmlppt/components@1`） |

## 重新生成

```bash
python3 cli/htmlppt.py describe --json \
  -o contracts/describe.json \
  --layout-md contracts/layouts \
  --deck-out contracts/deck.example.json
```

数据口径（与《槽位契约.md》双向对拍通过）：
title 24 · body 605 · pic 74 · obj 1 · sldNum 24 = **728**；必填 99 个（md 解析口径）。
