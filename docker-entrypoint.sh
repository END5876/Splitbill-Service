#!/bin/sh
# 容器啟動：以 root 修正資料目錄的擁有者後，改用 node 帳號（uid 1000）執行服務。
#
# 為什麼不直接在 Dockerfile 寫 USER node：舊版映像以 root 執行，Volume 裡的
# splitbill.db、-wal、backups/ 都屬於 root。直接換成 node 的話 SQLite 會沒有寫入權限。
# 這裡每次啟動先把「不屬於 node 的檔案」改過去，新舊映像之間可以雙向切換
# （回滾到舊的 root 映像也照樣能讀寫）。
set -e

DATA_DIR="${SPLITBILL_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # 只改不屬於 node 的檔案，資料很多時重啟也不會每次都全量改權限；-xdev 不跨到別的檔案系統
  # 失敗不中止啟動（set -e 下會讓容器不斷重啟）；真的沒有寫入權限時，服務開資料庫會失敗並在 log 說明
  find "$DATA_DIR" -xdev ! -user node -exec chown node:node {} + \
    || echo "[entrypoint] ⚠️ 無法修正 $DATA_DIR 的擁有者，服務可能沒有寫入權限" >&2
  # setpriv 會 exec 成目標程式（PID 不變），node 直接收到 SIGTERM、正常關閉資料庫
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
