FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    LARK_CLI_BIN=/app/node_modules/.bin/lark-cli \
    LARKSUITE_CLI_CONFIG_DIR=/var/lib/minori/lark \
    HOME=/var/lib/minori/lark/home
WORKDIR /app
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 minori \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin minori
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY --chown=minori:minori deploy/vultr/compose.production.yaml /opt/minori/release/compose.production.yaml
COPY --chown=minori:minori deploy/vultr/deployment-protocol /opt/minori/release/deployment-protocol
RUN mkdir -p /var/lib/minori/lark/home /tmp/minori \
  && chown -R 10001:10001 /app /var/lib/minori/lark /tmp/minori
USER 10001:10001
VOLUME ["/var/lib/minori/lark"]
EXPOSE 3000
CMD ["node", "dist/main.js"]
