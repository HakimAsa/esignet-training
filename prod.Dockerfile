FROM node:24-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
# prisma is a regular (not dev) dependency specifically so its CLI is present
# here — postinstall's "prisma generate" runs against this stage's own
# platform, and the CLI is what lets the CMD below run migrations on start.
# prisma.config.ts isn't copied in yet: once present, the CLI loads it eagerly
# (even for `generate`), and it calls env("DATABASE_URL") which throws if
# unset — which it is at build time. Add it only after `npm ci` runs.
RUN npm ci --omit=dev && npm cache clean --force
# prisma.config.ts (not schema.prisma) is where Prisma 7's CLI resolves the
# datasource URL from — only needed now, for `migrate deploy` in the CMD below.
COPY prisma.config.ts ./
COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000
USER node
# Applies any pending migrations before every start. Safe to run repeatedly:
# migrate deploy only applies what's pending, and is safe under concurrent
# execution if multiple instances start at once.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
