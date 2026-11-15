# One image for the platform and hydration (M2-01). The apps run their
# TypeScript through tsx, as `pnpm platform` and `pnpm live` do locally; only
# production dependencies are installed. Built for ARM (Fargate on Graviton).
#
#   docker build -t aia .
#   docker run aia                                        the platform (default)
#   docker run aia tsx apps/hydration/src/live.ts         hydration's live stream
#   docker run aia tsx apps/hydration/src/backfill.ts ... a one-off backfill

FROM node:22.22.0-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate && npm install -g tsx@4.23.15

WORKDIR /app
# The workspace as .dockerignore leaves it: no secrets, local data or parity exports.
COPY . .
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

USER node
ENV AIA_HOST=0.0.0.0 AIA_PORT=8080
EXPOSE 8080
CMD ["tsx", "apps/platform/src/main.ts"]
