# esignet-backend

Express + TypeScript API backed by Postgres (via Prisma).

## Stack

- **Express 5** — HTTP layer
- **Prisma 7** (`@prisma/adapter-pg`) — type-safe DB access, migrations
- **Zod** — request validation and env validation
- **Pino** — structured logging (pretty-printed in dev)
- **Vitest + Supertest** — testing
- **ESLint + Prettier** — linting/formatting
- **Docker Compose** — local Postgres (and an optional prod-like `app` build)

## Getting started

```bash
cp .env.example .env       # adjust POSTGRES_PORT/DATABASE_URL if 5432 is taken locally
npm install
npm run db:up              # starts Postgres in Docker
npm run prisma:migrate     # applies migrations
npm run dev                # starts the API with hot reload
```

Health check: `curl http://localhost:3000/api/health`

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run the server with hot reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run compiled output |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run prisma:migrate` | Create/apply a migration (`prisma migrate dev`) |
| `npm run prisma:studio` | Browse the DB in Prisma Studio |
| `npm run db:up` / `npm run db:down` | Start/stop the Dockerized Postgres |
| `npm run esignet:generate-key` | Generate the eSignet client's RSA key pair (see below) |

## Project layout

```
src/
  config/     # env parsing/validation (Zod)
  lib/        # prisma client, logger singletons
  middleware/ # error handling, request validation
  schemas/    # Zod request schemas
  services/   # DB access / business logic
  controllers/# request handlers
  routes/     # route wiring
  app.ts      # Express app construction (no listen)
  server.ts   # entrypoint: listens, handles graceful shutdown
prisma/
  schema.prisma
  migrations/
```

Adding a new resource means repeating the `users` pattern: a Prisma model, a Zod schema, a service, a controller, and a route mounted in `src/routes/index.ts`.

## eSignet (MOSIP) login

Login is an OIDC authorization-code flow against eSignet, using `private_key_jwt`
client authentication (a signed JWT instead of a shared client secret):

1. Frontend calls `GET /api/auth/esignet/prepare` (`src/controllers/auth.controller.ts`).
   The server generates `state`/`nonce`, stores them in an httpOnly `esignet_oauth`
   cookie, and returns them as JSON.
2. Frontend redirects the browser to eSignet's `/authorize` endpoint with those
   `state`/`nonce` values, `ESIGNET_CLIENT_ID`, and `ESIGNET_REDIRECT_URI`.
3. The user authenticates at eSignet, which redirects back to
   `GET /auth/callback` (`src/controllers/oauth-callback.controller.ts`) with a `code`.
4. The callback exchanges the code for tokens, verifies the `id_token`, fetches
   and verifies `userinfo`, upserts the local `User` (keyed on the OIDC `sub`),
   and sets a `session` cookie.

All of the token/JWKS/signing logic lives in `src/services/esignet.service.ts`.

### Required env vars

See `.env.example` for the full list (`ESIGNET_CLIENT_ID`, `ESIGNET_ISSUER`,
`ESIGNET_TOKEN_URL`, `ESIGNET_USERINFO_URL`, `ESIGNET_JWKS_URL`,
`ESIGNET_REDIRECT_URI`, plus the key pair below).

### Client key pair (private_key_jwt)

eSignet authenticates this app at the token endpoint via a JWT signed with an
RSA key it has on file for this client — there's no shared client secret.
That key pair was generated with:

```bash
npm run esignet:generate-key
```

This runs [`scripts/generate-esignet-key.mjs`](scripts/generate-esignet-key.mjs), which:

1. Generates a 2048-bit RSA key pair (`RS256`, via `jose`'s `generateKeyPair`).
2. Assigns it a random `kid` (UUID).
3. Writes the **public** key as a JWK to [`esignet-public-jwk.json`](esignet-public-jwk.json)
   — this is the file that gets sent to the MOSIP/eSignet team so they can
   register it against this client.
4. Prints the **private** key (PKCS8 PEM) and the `kid` to paste into `.env` as
   `ESIGNET_PRIVATE_KEY` / `ESIGNET_KEY_ID` — never written to disk by the
   script itself, so you decide where it's stored. `.env` is gitignored.

The currently configured key pair in this repo has `kid = ab4cddfd-8b88-4133-81b7-426af247b5bf`.

**To rotate the key:** run the script again, send the *new* `esignet-public-jwk.json`
to MOSIP, and only swap `ESIGNET_PRIVATE_KEY`/`ESIGNET_KEY_ID` in `.env` once
they confirm it's registered — the app signs with whatever key is currently in
`.env`, so swapping early means eSignet will reject the assertion with a `kid`
it doesn't recognize yet.

## Production build

```bash
docker compose up -d --build   # builds and runs the app + Postgres together
```

or without Docker:

```bash
npm run build && npm start
```
