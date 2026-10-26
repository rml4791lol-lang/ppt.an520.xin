# Ticket 01 交付报告 · 结构修复与验收套件骨架

日期：2026-10-22 · Status: completed

## 一、修复的真实缺陷（全部有前后对照）

| # | 缺陷 | 命中范围 | 修法 |
|---|---|---|---|
| 1 | `p:presentation` 子元素顺序违规（`notesMasterIdLst` 在 `sldIdLst` 之后） | prototype/out、gold/out、新作-科创港6页 三个产物 | `postprocess.mjs` 按 ECMA-376 顺序重排；历史文件用 `tools/fix-pptx-structure.py` 修 |
| 2 | `a:lin@ang = 21600000`（=360°，约束 <21600000） | 新作 6 页稿 slide3/slide5；round-trip 18 页稿 slide10 | 渐变角度归一化 `((angle%360)+360)%360`；修复器兜底 |
| 3 | 同一 `a:p` 内出现多个 `a:pPr` | round-trip 18 页稿，16 处 | 修复器只保留第一个 pPr 并置首 |

**效果**：round-trip 18 页稿 130 个结构/语义错误 → **0**（XSD 10 → 0，SDK 118 → 0）。
三个历史产物修复后：两种独立校验器（xmllint + Open XML SDK 3.5.1）全部通过。

## 二、验收套件（tools/verify/）

| 层 | 实现 | 说明 |
|---|---|---|
| pkg | `verify.py pkg` | CT 覆盖、rels 悬空、重复 part、压缩方法、slide→layout→master、画布 1280×720 |
| order | `verify.py order` | presentation 子元素顺序 + `a:lin` 角度越界（零依赖） |
| xsd | `verify.py xsd` | ECMA-376 Transitional XSD（首次自动下载缓存到 `~/.cache/htmlppt/xsd`） |
| sdk | `verify.py sdk` | Open XML SDK 3.5.1 预编译二进制（自动下载缓存；JSON 输出解析） |
| potx | `verify.py potx` | main CT / master / layout 关系闭合 / layout 名唯一 |
| fonts | `verify.py fonts` | fntdata EOT 头、fsType 可嵌入性、embeddedFontLst↔rels 一致 |
| lo | `verify.py lo` | LibreOffice 打开+转 PDF，只看 stderr 是否有 `Error:` |
| all | `verify.py all --json` | 聚合输出：`{ok, errors, skipped, layers}`，退出码 0/1/2 |

## 三、实测结果

| 产物 | pkg | order | xsd | sdk | potx | fonts | lo | 结论 |
|---|---|---|---|---|---|---|---|---|
| `新作-科创港6页.pptx`（修复后） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 errors / 0 skipped |
| `gold/out/deck.pptx`（修复后） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 0 / 0 |
| `国金模板.potx` | — | — | — | — | ✓ | — | — | potx 层通过 |
| round-trip 18 页（修复后） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 130 → 0 |
| `prototype/out/deck.pptx`（重新 postprocess） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | pipeline 源头已修 |

报告 JSON：`verify-new6.json`、`verify-roundtrip.json`。

## 四、接入构建管线

`prototype/src/run.mjs` 新增步骤 **3c/9 fix OOXML structure**：每次构建后自动跑修复器，
保证后续产物不再带 presentation 顺序 / 角度越界 / 重复 pPr。

## 五、测试（契约测试，外部行为）

`tools/verify/test_verify.py`，7 个用例全绿（2.0s）：
- 注入 presentation 顺序违规 → verifier 报 `E_PRES_ORDER`；修复后 0
- 注入 `ang=21600000` → 报 `E_ANG_RANGE`；修复后 0
- 注入重复 `a:pPr` → 修复后每段 ≤1 个
- OPC 包零错误；potx 零错误；`verify all --json` 字段契约稳定

## 六、遗留

- 真机（Windows PowerPoint）回归仍需用户机器：见 `spec.md` 的 8 条人工清单。
- 本仓库非 git 仓库，无法提交 commit；改动以文件形式落盘。
