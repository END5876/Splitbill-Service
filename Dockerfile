# 基底映像固定到 digest，每次建置內容一致；新版由 Dependabot 每月開 PR 更新
FROM node:22-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
WORKDIR /app
ENV NODE_ENV=production
# 先只複製 package*.json：依賴沒變時這一層會直接用快取，不必每次重裝
COPY package*.json ./
# npm ci：嚴格照 package-lock.json 安裝，每次建置結果一致
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
# 去掉 Windows 換行（CRLF 的 shell 腳本在 Linux 上無法執行）
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh \
    && mkdir -p /app/data && chown node:node /app/data
# 分帳資料（splitbill.db 與 backups/）存放位置，部署時請把 Volume 掛載到這個目錄
ENV SPLITBILL_DATA_DIR=/app/data
EXPOSE 3000
# 健康檢查：只看資料庫讀不讀得到。「沒掛 Volume」也會讓 /healthz 回 503，但重啟修不好，
# 而 VPS 的 heal.sh 會重啟 unhealthy 的容器，所以這裡不採用狀態碼，避免一直重啟。
# start-period 留給啟動時的資料庫遷移與備份。
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3     CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.SPLITBILL_WEB_PORT||3000)+'/healthz').then(r=>r.json()).then(b=>process.exit(b.db==='ok'?0:1)).catch(()=>process.exit(1))"
# 🔒 服務本身以 node 帳號（非 root）執行：entrypoint 先修正資料目錄的擁有者再降權（見 docker-entrypoint.sh）
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
