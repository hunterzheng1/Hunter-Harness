FROM node:24.14.0-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/cli/package.json packages/cli/tsconfig.json ./packages/cli/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/next.config.ts apps/web/next-env.d.ts ./apps/web/
RUN npm ci --ignore-scripts

COPY packages/contracts/src ./packages/contracts/src
COPY apps/web/app ./apps/web/app
COPY apps/web/components ./apps/web/components
COPY apps/web/lib ./apps/web/lib
ARG HUNTER_HARNESS_INTERNAL_API_URL=http://server:3001
ARG NEXT_PUBLIC_HUNTER_HARNESS_API_URL=
ENV HUNTER_HARNESS_INTERNAL_API_URL=${HUNTER_HARNESS_INTERNAL_API_URL} \
    NEXT_PUBLIC_HUNTER_HARNESS_API_URL=${NEXT_PUBLIC_HUNTER_HARNESS_API_URL} \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w packages/contracts
RUN npm run build -w apps/web

FROM node:24.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
