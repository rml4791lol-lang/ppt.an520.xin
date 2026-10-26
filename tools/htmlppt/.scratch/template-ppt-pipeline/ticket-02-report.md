# Ticket 02 交付报告 · deck 清单、describe 与契约文档

日期：2026-10-22 · Status: completed

## 一、交付物

| 产物 | 说明 |
|---|---|
| `tools/contract/describe.py` | 从 potx/pptx（zip+XML，不依赖 python-pptx）反算契约；输出 describe JSON / 每版式 layout.md / deck 清单 |
| `contracts/describe.json` | 24 版式 / **728 槽位** / 10 主题 / 20 组件（`htmlppt/describe@1`） |
| `contracts/layouts/S01.md … S24.md` | 每版式一页：槽位表（类型/位置/字号/建议字数/必填/示例）+ 填写规则 |
| `contracts/deck.example.json` | deck 清单示例（24 页、来源 `spec:Sxx`、主题、内容引用） |
| `contracts/{describe,deck,layout,component}.schema.json` | JSON Schema（draft 2020-12） |
| `contracts/components.json` | 组件注册表种子（20 类 45 变体口径） |
| `cli/htmlppt.py describe` | 统一入口：`describe --json` / `--layout-md` / `--deck-out` / `--contract` |

## 二、对拍结果（外部事实核对）

- 槽位类型计数：title 24 · body 605 · pic 74 · obj 1 · sldNum 24 = **728**，与 XML 实测、与《槽位契约.md》逐节计数三方一致。
- 24 个版式的「槽位数 / 版式名」与契约 md 逐条比对通过。
- 容量口径与 `capacity.py` 对齐（例：赛事全称 384×34 @13.5pt → 21 字单行）。
- sample / required 从契约 md 回填（必填 99 条；页码为自动域）。

## 三、测试

`tools/contract/test_contract.py`：**9/9 通过**（0.6s）
- describe schema/画布/24 版式
- 槽位类型计数 = 728
- 所有槽位在 1280×720 内
- 文本槽位有 capacity
- 版式名/槽位数与契约 md 对拍
- layout.md 生成 24 份且含槽位名
- describe.json / deck.example.json 通过 JSON Schema 校验
- `cli describe --json` 契约稳定

## 四、约束与后续

- `.potx` 用 zip/XML 读取（python-pptx 1.0.2 打不开 potx）。
- 契约文件是生成物：模板变了要重跑 `describe`，不要手改。
- 下一步（Ticket 03）：plan 协议 + validate，直接消费本契约的槽位/容量/权限面。
