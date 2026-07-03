FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
COPY packages/skill-cli/package.json packages/skill-cli/tsconfig.json ./packages/skill-cli/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json ./apps/web/
RUN npm ci --ignore-scripts

COPY packages/contracts/src ./packages/contracts/src
COPY packages/core/src ./packages/core/src
COPY apps/server/src ./apps/server/src
COPY apps/server/migrations ./apps/server/migrations
COPY resources ./resources
RUN npx tsc -b packages/contracts packages/core apps/server

FROM node:24.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    ARTIFACT_ROOT=/var/lib/hunter-harness/artifacts
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/migrations ./apps/server/migrations
COPY --from=build /app/resources ./resources
RUN mkdir -p /var/lib/hunter-harness/artifacts && chown -R node:node /var/lib/hunter-harness /app
USER node
EXPOSE 3001
CMD ["node", "apps/server/dist/main.js"]
