# MCP Server / Mail Worker 공용 이미지 (Playwright 미포함). Railway 서비스마다 시작 명령만 다르게 지정한다.
FROM node:22-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/drizzle ./drizzle
COPY web ./web
COPY package.json ./
EXPOSE 3000
# 기본은 MCP 서버. Worker 는 startCommand 로 `node build/worker/main.js` 를 지정한다.
CMD ["node", "build/remote/server.js"]
