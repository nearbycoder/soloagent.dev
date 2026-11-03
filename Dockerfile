# soloagent — one service, one volume.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @soloagent/web && npm prune --omit=dev --no-audit --no-fund

FROM node:26-slim
ENV NODE_ENV=production \
    PORT=7420 \
    SOLOAGENT_DATA_DIR=/data \
    NODE_NO_WARNINGS=1
# git, curl, and ca-certificates help the optional `workspace` skill run useful shell commands.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
RUN ln -s /app/packages/cli/src/main.ts /usr/local/bin/soloagent && chmod +x /app/packages/cli/src/main.ts
# Mount a volume at /data (Railway: add a volume; Docker: -v soloagent:/data).
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7420)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/src/main.ts"]
