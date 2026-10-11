---
name: anppt-deploy
description: AnPPT v2 部署流程（ppt.an520.xin / hk-hermes）。当用户说"部署"、"上线"、"发版"时使用。
---

# AnPPT v2 部署

唯一入口：`bash deploy/deploy.sh`（本地 build → rsync → 查在途 → 重启+自检，脚本内置在途守卫）。

部署前：

1. 全量门五连全绿（见 anppt-gate）
2. docs 已同步（DEBUG-HANDBOOK 对应小节 + README 断言数）
3. 若涉及开关板新功能：确认 flag 状态符合预期（新功能一律 beta 起步）

部署后必验：

```bash
ssh hk-hermes "sudo -n cat /opt/anppt-v2/current/.next/BUILD_ID"   # 须等于本地 .next/BUILD_ID
curl -s -o /dev/null -w "%{http_code}" https://ppt.an520.xin/      # 200
curl -s https://ppt.an520.xin/api/health                           # ok:true
```

服务器纪律：线上库 `/opt/anppt-v2/shared/data/anppt-v2.db` 属 root，直读直写用 `sudo -n node`；node:sqlite 无 `db.transaction()`，用显式 BEGIN IMMEDIATE/COMMIT；重启前双队列（生成+导出在途）必须为 0。
