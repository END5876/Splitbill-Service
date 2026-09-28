FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# 分帳資料（splitbill.json）存放位置，部署時請把 Volume 掛載到這個目錄
ENV SPLITBILL_DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "server.js"]
