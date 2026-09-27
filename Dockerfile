FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# 只拷贝依赖清单，利用 Docker 层缓存
COPY package.json ./

# 仅安装生产依赖（express）
RUN npm install --omit=dev

# 拷贝应用代码
COPY server.js ./
COPY src ./src
COPY public ./public
COPY samples ./samples

EXPOSE 3000

USER node

CMD ["node", "server.js"]
