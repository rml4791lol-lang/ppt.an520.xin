// 未登录时"你正想做什么"的唯一定义处：登录墙与登录页共用，避免六套措辞各说各话。
// 新增场景只加一行；不要在两处各写一遍文案。
export const AUTH_SCENES = {
  home: "上传文档生成 PPT",
  projects: "查看我的项目",
  exports: "查看导出记录",
  credits: "查看星星明细",
  deck: "打开这个项目",
  beautify: "使用 PPT 美化",
  "ppt-to-base": "把截图转成可编辑底图",
  "single-page": "使用创意页面生成器",
} as const;

export type AuthScene = keyof typeof AUTH_SCENES;
