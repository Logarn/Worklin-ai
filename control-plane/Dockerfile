FROM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

WORKDIR /app/control-plane

COPY control-plane/package.json control-plane/tsconfig.json control-plane/bun.lock ./
COPY control-plane/src ./src

RUN bun install --frozen-lockfile

EXPOSE 8080

ENV WORKLIN_CONTROL_PLANE_PORT=8080

CMD ["bun", "run", "src/index.ts"]
