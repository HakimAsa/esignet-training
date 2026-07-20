FROM node:24-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts
RUN npm run build
# Renders docs/*.md into public/docs/*.html (needs `marked`, a devDependency —
# hence run here, not in the runtime stage below).
RUN npm run docs:build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --ignore-scripts: the prisma CLI (devDependency) isn't installed here, so the
# postinstall "prisma generate" would fail; the generated client is copied in below instead.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

EXPOSE 3000
USER node
CMD ["node", "dist/server.js"]
