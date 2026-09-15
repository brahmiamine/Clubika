# syntax=docker/dockerfile:1

# Image et digest : deploy/runtime-images.lock (issue #36). Ne pas utiliser :latest.
ARG NODE_IMAGE=node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable

# Dépendances sans postinstall Playwright (navigateurs = e2e CI, pas la prod).
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Pas de postinstall Playwright. Rebuild des binaires natifs nécessaires au build Next.
RUN pnpm install --frozen-lockfile --ignore-scripts \
  && pnpm rebuild esbuild sharp unrs-resolver core-js

FROM deps AS build
COPY . .
RUN pnpm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    npm_config_cache=/tmp/.npm \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN corepack enable \
  && groupadd --gid 10001 clubika \
  && useradd --uid 10001 --gid 10001 --home-dir /tmp --shell /usr/sbin/nologin clubika \
  && mkdir -p /tmp/.cache /tmp/.npm /app/.next/cache \
  && chown -R clubika:clubika /tmp/.cache /tmp/.npm /app/.next/cache

COPY --from=build --chown=clubika:clubika /app ./

USER 10001:10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Ordre de déploiement : build → migrate → start (migrate = SQL, pas d'écriture disque).
CMD ["sh", "-c", "pnpm run db:migrate && pnpm run start"]
