FROM node:22-slim
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
# 🔒 服務本身以 node 帳號（非 root）執行：entrypoint 先修正資料目錄的擁有者再降權（見 docker-entrypoint.sh）
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
