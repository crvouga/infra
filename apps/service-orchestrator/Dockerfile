FROM oven/bun:1.2-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY lib /app/lib
COPY apps/service-orchestrator/server.ts /app/apps/service-orchestrator/server.ts

RUN apk add --no-cache docker-cli docker-cli-compose

ENV PORT=8080
EXPOSE 8080

CMD ["bun", "run", "apps/service-orchestrator/server.ts"]
