#!/usr/bin/env bash
# AnPPT v2 SQLite 热备份：VACUUM INTO 生成一致性快照，gzip 后保留 14 天。
# 只备份数据库（账户/积分/订单/项目元数据）；uploads/generated 原文件不在本脚本范围。
set -euo pipefail

DB_PATH="${ANPPT_V2_DB_PATH:-/opt/anppt-v2/shared/data/anppt-v2.db}"
BACKUP_DIR="${ANPPT_V2_BACKUP_DIR:-/opt/anppt-v2/shared/backups}"
KEEP_DAYS="${ANPPT_V2_BACKUP_KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
dest="$BACKUP_DIR/anppt-v2-$stamp.db"

/usr/bin/node - "$DB_PATH" "$dest" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const [src, dest] = process.argv.slice(2);
const db = new DatabaseSync(src, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}
NODE

gzip -f "$dest"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'anppt-v2-*.db.gz' -mtime +"$KEEP_DAYS" -delete
ls -lh "$dest.gz"
