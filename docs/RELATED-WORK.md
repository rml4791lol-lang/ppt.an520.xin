# 相关方向与同类项目（Related Work）

本项目有三条线：**文档 → 演示稿生成**、**转可编辑**、**HTML 展示层**。下面是与这三条线直接相关的公开项目，用于对齐业界做法、也作为后续迭代的参考。全部为第三方仓库，许可证以各自仓库为准。

## 一、转可编辑 / 可编辑 PPT 还原

| 项目 | 许可证 | 做的事 | 与本项目的关系 |
| --- | --- | --- | --- |
| [PPTAgent](https://github.com/icip-cas/PPTAgent) | MIT | 两阶段「编辑式」生成：先解析参考演示稿，再在其基础上改写，最终导出真 PPTX | 走的是 XML 级编辑；本项目走「视觉重建 + 多通道转换」，两条路互补 |
| [image2editable](https://github.com/DSY-Xueai/image2editable) | MIT | 图片 / PDF / 图片型 PPTX → 可编辑 PPT | 与本项目 `image2ppt` 通道同类；差异在于我们把它作为可自动降级的一环 |
| [slide-alchemy](https://github.com/CodingFeng101/slide-alchemy) | MIT | 截图类幻灯片 → 干净底图 + 原生形状 + 真文本框 | 同一问题的另一种工程解法，可对比还原质量 |
| [blade-slides](https://github.com/bryanbao-lab/blade-slides) | MIT | 高保真可编辑还原，强调贴近人工制作习惯 | 参考其「像人做的」评价口径 |

## 二、文档 → 演示稿生成（研究）

| 项目 | 许可证 | 做的事 |
| --- | --- | --- |
| [AutoPresent](https://github.com/para-lost/AutoPresent) | MIT | CVPR 2025：8B 模型从指令直接产出幻灯片代码（structured visuals from scratch） |

## 三、HTML 展示层（下一步方向）

| 项目 | 许可证 | 做的事 |
| --- | --- | --- |
| [reveal.js](https://github.com/hakimel/reveal.js) | MIT | HTML 演示框架基准：翻页、演讲者视图、嵌套 |
| [Slidev](https://github.com/slidevjs/slidev) | MIT | 面向开发者的 Markdown / 组件式演示 |
| [Marp](https://github.com/marp-team/marp) | MIT | Markdown 演示生态 |

这三者解决的是「手写 deck 怎么好看」；本项目要解决的是「已有内容怎么自动变成可分享、移动端自适应的网页演示」。

## 四、底层库

| 项目 | 许可证 | 做的事 |
| --- | --- | --- |
| [python-pptx](https://github.com/scanny/python-pptx) | MIT | 服务端生成 / 改写 PPTX 的事实标准 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | MIT | JS 侧 PPTX 生成（本项目图片版导出用到） |

## 一句话

研究线回答「怎么做对」，本项目回答「怎么让不写代码的人直接用」。
