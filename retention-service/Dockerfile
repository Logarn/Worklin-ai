FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

WORKDIR /app

COPY packages/retention-domain/package.json ./packages/retention-domain/package.json
COPY packages/retention-domain/src ./packages/retention-domain/src
COPY retention-service/package.json retention-service/tsconfig.json retention-service/bun.lock ./retention-service/

WORKDIR /app/retention-service
RUN bun install --frozen-lockfile --production

COPY retention-service/src ./src

EXPOSE 8080

ENV WORKLIN_RETENTION_PORT=8080

CMD ["bun", "run", "src/index.ts"]
