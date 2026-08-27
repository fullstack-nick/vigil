FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000 8080 9090
CMD ["node", "apps/control-plane/dist/main.js"]

