# 14: 主题换色支持 schemeClr + 浅色主题对比度修复

**What to build:** 换主题时必须同时处理「主题色引用」与「浅色主题下的文字对比度」，使 10 套 palette（含 medical/bp 两套浅色）都能一键换色且文字可读。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

背景（本轮实测）：
- `retint.py` 只改 `a:srgbClr`；国金模板 108 处颜色是 `a:schemeClr` 引用 → retint 对主题色**几乎无效**（6 套"主题"渲染差异≈0，仅 p3 有 0.21 差）。
- 新增 `tools/theme-recolor.py` 直接改 `theme1.xml` 的 `clrScheme`，6 套深色主题已生效（六层验收全 PASS）。
- 浅色主题（medical/bp）把 `lt1→DARKTX` 对调后，覆盖层的白字变深字，出现「深字压深蓝带」的对比度问题；retint 的对比度检查因 run 全用 schemeClr 而报 0 runs。

验收：
- [ ] `retint --check` 能识别 schemeClr 文字 run 并按实际底色判定对比度
- [ ] medical/bp 两套浅色主题封面与内页所有文字 ≥4.5:1（大字按 3:1）
- [ ] 10 套 palette 全部生成、六层验收 PASS、渲染目检无白字压浅底/深字压深底
- [ ] 回归：深色 6 套不发生视觉回退（与当前产物逐像素比对）
