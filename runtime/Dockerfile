FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
ENV PATH="/root/.bun/bin:${PATH}"

COPY packages/assistant-client ./packages/assistant-client
COPY packages/ces-client ./packages/ces-client
COPY packages/service-contracts ./packages/service-contracts
COPY packages/credential-storage ./packages/credential-storage
COPY packages/egress-proxy ./packages/egress-proxy
COPY packages/environments ./packages/environments
COPY packages/gateway-client ./packages/gateway-client
COPY packages/ipc-server-utils ./packages/ipc-server-utils
COPY packages/retention-domain ./packages/retention-domain
COPY packages/skill-host-contracts ./packages/skill-host-contracts
COPY packages/slack-text ./packages/slack-text
COPY packages/twilio-client ./packages/twilio-client

RUN cd /app/packages/ces-client && bun install --frozen-lockfile
RUN cd /app/packages/gateway-client && bun install --frozen-lockfile
RUN cd /app/packages/service-contracts && bun install --frozen-lockfile

COPY assistant/package.json assistant/bun.lock ./assistant/
RUN cd /app/assistant && bun install --frozen-lockfile

COPY control-plane/package.json control-plane/tsconfig.json control-plane/bun.lock ./control-plane/
RUN cd /app/control-plane && bun install --frozen-lockfile

COPY gateway/package.json gateway/bun.lock ./gateway/
RUN cd /app/gateway && bun install --frozen-lockfile --production

COPY credential-executor/package.json credential-executor/bun.lock* ./credential-executor/
RUN cd /app/credential-executor && bun install --frozen-lockfile

COPY skills ./skills
RUN set -eu; for pkg in /app/skills/*/package.json; do \
      [ -e "$pkg" ] || continue; \
      dir="$(dirname "$pkg")"; \
      echo "Installing dependencies for $dir"; \
      (cd "$dir" && (bun install --frozen-lockfile 2>/dev/null || bun install)); \
    done

COPY assistant ./assistant
COPY control-plane ./control-plane
COPY gateway ./gateway
COPY credential-executor ./credential-executor
COPY runtime ./runtime

RUN bun run /app/skills/meet-join/scripts/emit-manifest.ts \
      --output /app/skills/meet-join/manifest.json

FROM debian:trixie-slim@sha256:4ffb3a1511099754cddc70eb1b12e50ffdb67619aa0ab6c13fcd800a78ef7c7a AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y \
    bash \
    ca-certificates \
    curl \
    debconf \
    ffmpeg \
    fonts-freefont-ttf \
    g++ \
    git \
    htop \
    jq \
    lsof \
    make \
    openssl \
    procps \
    python3 \
    sqlite3 \
    sudo \
    unzip \
    uuid-runtime \
    vim \
    wget \
    xclip \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    bubblewrap \
    debootstrap \
    debian-archive-keyring \
    e2fsprogs \
    iproute2 \
    mount \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdrm2 \
    libfreetype6 \
    libgbm1 \
    libharfbuzz0b \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxtst6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /root/.bun/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx

RUN groupadd --system --gid 1000 vellum && \
    groupadd --system --gid 1001 assistant && \
    useradd --system --uid 1001 --gid assistant --groups vellum --create-home --shell /bin/bash assistant && \
    echo "assistant ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers && \
    groupadd --system --gid 1002 gateway && \
    useradd --system --uid 1002 --gid gateway --groups vellum --create-home --shell /bin/bash gateway && \
    groupadd --system --gid 1003 ces && \
    useradd --system --uid 1003 --gid ces --groups vellum --create-home --shell /bin/bash ces

RUN mkdir -p /home/assistant/.vellum /home/gateway/.vellum /home/ces/.vellum && \
    chown -R assistant:assistant /home/assistant/.vellum && \
    chown -R gateway:gateway /home/gateway/.vellum && \
    chown -R ces:ces /home/ces/.vellum

ENV PATH="/home/assistant/.bun/bin:${PATH}"
ENV BUN_INSTALL="/home/assistant/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
ENV PYTHONUSERBASE="/home/assistant/.python"
ENV PATH="${PYTHONUSERBASE}/bin:${PATH}"

COPY --from=builder /app /app

COPY packages/block-volume-bootstrap/scripts/*.sh /usr/local/bin/
RUN chmod +x \
    /app/assistant/docker-entrypoint.sh \
    /app/assistant/docker-init-apt-root.sh \
    /app/assistant/docker-kata-apt-env.sh \
    /app/assistant/docker-kata-runtime-family.sh \
    /usr/local/bin/vellum-block-volume-common.sh \
    /usr/local/bin/vellum-block-volume-init.sh \
    /usr/local/bin/vellum-block-volume-mount.sh \
    /usr/local/bin/vellum-block-volume-resize.sh \
    /app/runtime/entrypoint.sh

RUN mkdir -p /run/ces-bootstrap && chmod 777 /run/ces-bootstrap

EXPOSE 8080
EXPOSE 7830
EXPOSE 8090

ENV IS_CONTAINERIZED=true
ENV CES_MODE=managed
ENV DEBUG_STDOUT_LOGS=1
ENV RUNTIME_HTTP_HOST=0.0.0.0
ENV RUNTIME_HTTP_PORT=3001
ENV ASSISTANT_HOST=127.0.0.1
ENV CES_CREDENTIAL_URL=http://127.0.0.1:8090
ENV CES_HEALTH_PORT=8090
ENV UNMAPPED_POLICY=default
ENV GATEWAY_TRUST_PROXY=true
ENV WORKLIN_RUNTIME_ROOT=/data
ENV VELLUM_WORKSPACE_DIR=/data/workspace
ENV GATEWAY_SECURITY_DIR=/data/gateway-security
ENV CES_DATA_DIR=/data/ces-data
ENV CREDENTIAL_SECURITY_DIR=/data/ces-data/security
ENV CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap
ENV WORKLIN_REQUIRE_ISOLATED_RUNTIME=true

CMD ["/app/runtime/entrypoint.sh"]
