FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY bot/ ./bot/

CMD ["npx", "tsx", "bot/src/engine.ts"]
