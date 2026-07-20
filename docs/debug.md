# Debugging the eSignet OIDC Integration — A Field Guide

*[Version française →](./debug.fr.md)*

## Who this is for

You're integrating a web app with **eSignet** (MOSIP's OpenID Connect identity provider) — or with any OIDC provider, really — and you've hit an error that seems to make no sense. This document catalogs every real bug we hit while building this integration (`esignet-backend` + `vue-upload-form`, deployed on Render), what actually caused each one, and how we fixed it. It's written so a junior engineer can follow the reasoning, not just copy the fix — because the *next* integration will hit different bugs, and the debugging method matters more than any single fix.

This isn't hypothetical. Every issue below actually happened, in this exact order, on this exact project. Fixing one often revealed the next — that's normal. Don't get discouraged when a fix doesn't immediately produce a perfect login; it usually produces a **different, more specific error**, which means you're making progress.

## Architecture recap

Two separate services, deployed independently on Render:

- **`vue-upload-form`** — a Vue 3 SPA, served as static files by nginx in production.
- **`esignet-backend`** — an Express/TypeScript API that talks to eSignet server-side (token exchange, UserInfo) and to Postgres (via Supabase).

This split (frontend and backend as genuinely separate origins) is what caused most of the hardest bugs here. A monolithic app (frontend and backend on the same domain) would have skipped several of these entirely — but wouldn't reflect how most real-world integrations are actually deployed.

## Glossary (skip if you already know OIDC)

| Term | Meaning |
|---|---|
| **OIDC** | OpenID Connect — an identity layer on top of OAuth2. "Log in with X" flows use this. |
| **`redirect_uri`** | The URL the identity provider sends the browser back to after login. Must be pre-registered, character-for-character. |
| **`id_token`** | A signed JWT proving who the user is. Contains `sub` (user id), `iss` (issuer), `aud` (audience/client_id), `nonce`, etc. |
| **UserInfo endpoint** | A second endpoint you call *after* getting a token, to fetch the user's profile (name, email, ...). |
| **`private_key_jwt`** | A client authentication method where your backend signs a JWT with its own private key instead of sending a shared secret. |
| **PKCS8** | A standard format for encoding a private key as text (`-----BEGIN PRIVATE KEY-----...`). |
| **SameSite / third-party cookies** | Browser rules restricting when a cookie set by one site can be sent/read by a different site. |
| **Public Suffix List (PSL)** | A list of domains (like `onrender.com`, `github.io`, `vercel.app`) where *every subdomain* is treated as an independent site — not just a different origin. |

---

## Category A — Local environment

### A1. Postgres port already in use

**Symptom:** `docker compose up` failed to bind port 5432.

**Root cause:** another Postgres instance (from a different project) was already using that port on the shared dev machine.

**Fix:** mapped the container to a different host port (`POSTGRES_PORT=5435` in `.env`, used by `docker-compose.yml`'s `${POSTGRES_PORT:-5432}:5432`).

**Lesson:** never hardcode host ports in Docker Compose files — always make them overridable via an env var with a sane default.

### A2. A stray text note silently broke Docker Compose's env parsing

**Symptom:** `docker compose up` tried to bind the *app* container to port 5432 (which was Postgres's port), failing with "address already in use" — even though the compose file clearly said `${PORT:-3000}:3000`.

**Root cause:** someone had pasted raw connection notes into `.env` as scratch text:
```
PORT:5432
```
That's not valid `KEY=VALUE` syntax (colon instead of equals), but Docker Compose's env-file parser handled it differently than expected, corrupting the `PORT` variable used elsewhere in the file.

**Fix:** removed the stray non-`KEY=VALUE` lines from `.env`.

**Lesson:** `.env` files are not a scratchpad. A single malformed line can have surprising, hard-to-trace effects on *unrelated* variables. Keep `.env` strictly `KEY=VALUE`, and put notes in comments (`#`) or a separate file.

---

## Category B — Database hosting (Supabase)

### B1. Direct Postgres connection unreachable ("Can't reach database server")

**Symptom:** `prisma migrate deploy` (and our own app) failed to connect to Supabase's direct connection string (`db.<ref>.supabase.co:5432`), even though the password was correct.

**Root cause:** that hostname resolves to an **IPv6-only** address. Supabase dropped IPv4 support on the direct connection endpoint by default (paid add-on now). Many networks/hosts (including this dev sandbox, and potentially some hosting providers) have no IPv6 egress.

**Diagnosis:** `getent hosts <hostname>` showed only an IPv6 address; a raw curl over IPv6 confirmed no route out.

**Fix:** switched to Supabase's **Session pooler** connection string (`aws-0-<region>.pooler.supabase.com:5432`), which is IPv4-compatible. Note the username changes format too: `postgres.<project-ref>` instead of just `postgres`.

**Lesson:** when a "correct-looking" connection string fails with a generic network error, check DNS resolution first (`getent hosts`, `dig`) before assuming it's a credentials problem.

### B2. TLS error: "self-signed certificate in certificate chain"

**Symptom:** `prisma migrate deploy` worked (it uses a different, more lenient engine), but the actual app's database driver (`pg` via `@prisma/adapter-pg`) failed with a TLS handshake error.

**Root cause:** recent versions of `pg`'s connection-string parser treat `sslmode=require` as requiring *full certificate verification* — stricter than the traditional meaning of `require` (encrypt, but don't verify). Supabase's pooler presents a certificate chain that fails that stricter check.

**Fix:** appended `&uselibpqcompat=true` to the connection string, which restores the traditional "encrypt but don't verify" behavior for `sslmode=require`.

**Lesson:** "it works from one tool but not another" (here: Prisma's CLI vs. the app's own driver) is a real, common category of bug — different tools can implement the "same" protocol with different defaults. Don't assume the CLI succeeding proves the app will too.

---

## Category C — Render deployment platform

### C1. Render's managed Postgres has no free tier

**Symptom:** applying a Render Blueprint that included a `databases:` block suddenly asked for payment info.

**Root cause:** Render's own Postgres offering requires a paid plan; only the web service itself has a free tier.

**Fix:** removed the `databases:` block from `render.yaml` and used Supabase (external, free tier) instead, with `DATABASE_URL` as a manually-set env var.

**Lesson:** check what's actually free on a platform before designing infrastructure-as-code around it — don't assume "the platform has Postgres" means "the platform has *free* Postgres."

### C2. "New Web Service" vs "New Blueprint"

**Symptom:** manually configuring a Web Service in Render's dashboard would have required re-entering every env var by hand, guessing the Dockerfile path, and manually creating the database.

**Root cause:** Render has two different creation flows. Only "New → Blueprint" reads `render.yaml`.

**Fix:** always use the Blueprint flow when a `render.yaml` exists in the repo.

**Lesson:** infrastructure-as-code files are useless if you don't use the entry point that actually reads them.

### C3. Transient 502s from free-tier cold starts

**Symptom:** intermittent `502 Bad Gateway` with header `x-render-routing: no-deploy`, which resolved on its own within seconds to tens of seconds.

**Root cause:** Render's free tier spins down instances after inactivity; the first request has to wait for a cold start (can take 50+ seconds), and a proxy in front of it (in our case, one Render service's nginx proxying to another Render service) can time out before the wake-up finishes.

**Fix:** nothing to fix in code — this is expected free-tier behavior. Diagnosed by retrying a few times and confirming it self-resolved, and by checking the backend directly (bypassing the frontend's proxy) to see it was healthy.

**Lesson:** before writing code to "fix" an intermittent failure, reproduce it a few more times. Some things aren't bugs — they're the free tier being the free tier.

---

## Category D — Cross-origin & cookies (the hardest category)

This is the category that took the longest to fully resolve, because each fix revealed a *different* problem in the same area, and the underlying cause (browsers treating Render's subdomains as separate "sites") isn't something most engineers think about day to day.

### D1. Logo blocked from loading cross-origin

**Symptom:** browser console: `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin` when loading an image from the backend on a different site.

**Root cause:** Helmet (our security-headers middleware) sets `Cross-Origin-Resource-Policy: same-origin` by default, which explicitly blocks other origins from embedding the resource (as an `<img>`, in this case).

**Fix:** configured Helmet's `crossOriginResourcePolicy: { policy: "cross-origin" }` for the static-assets path — a documented, intentional relaxation for exactly this case (public assets meant to be embedded elsewhere).

**Lesson:** modern security-header defaults are often *stricter* than a naive integration expects. When something is blocked with a `NotSameOrigin`-style error, check `Cross-Origin-Resource-Policy` before assuming it's a CORS (`Access-Control-Allow-Origin`) issue — they're different mechanisms.

### D2. Cookie never arrived at the callback ("missing_or_expired_login_attempt") — attempt 1

**Symptom:** a cookie set by one endpoint (`/prepare`) was never found by a later endpoint (`/callback`), despite both being on the same backend.

**Root cause:** the frontend called the backend's `/prepare` endpoint with `credentials: "include"` (correct), but the backend's CORS configuration didn't include `credentials: true`. Browsers require **both sides** to explicitly opt into credentialed cross-origin requests — the response header `Access-Control-Allow-Credentials: true` must be present, or the browser refuses to store/send cookies for that request at all, no matter what the client asks for.

**Fix:** added `credentials: true` to the `cors()` middleware config.

**Lesson:** cross-origin cookies need three things to align: the cookie's `SameSite` attribute, the client's `credentials` mode, *and* the server's CORS credentials header. Missing any one silently breaks it — usually with no error message at all, just "the cookie isn't there."

### D3. Frontend calling a relative path that resolved to its own origin

**Symptom:** the frontend's fetch to `/api/auth/esignet/prepare` actually hit `vue-upload-form.onrender.com/api/...` — the frontend's *own* domain — not the backend, because the two are separate Render services with no proxy between them (at the time).

**Root cause:** relative URLs in `fetch()` resolve against the *current page's* origin, not some other server, unless something (a proxy, a full URL) redirects them.

**Fix (short-term):** used the backend's full URL directly (introduced cross-origin complexity, later replaced — see D4).

**Lesson:** a relative API path only works if the frontend and backend share an origin (directly, or via a reverse proxy). If they're separate services, you need either a proxy or the full backend URL — a relative path silently does something *else*, not nothing, which makes this bug sneaky (it doesn't 404 obviously; it just hits the wrong server).

### D4. The real root cause: third-party cookie blocking via the Public Suffix List

**Symptom:** even after fixing D2 and D3 (correct CORS credentials, correct cross-origin URL), the callback *still* couldn't find the cookie set moments earlier by the same browser.

**Root cause — the big one:** `onrender.com` is on the **Public Suffix List**. This means every tenant subdomain (`vue-upload-form.onrender.com`, `esignet-backend.onrender.com`) is treated by browsers as an **independent site**, not just a different origin under a shared domain — the same rule that makes `github.io` or `vercel.app` subdomains mutually untrusted. A cookie set via a `fetch()` call from one such site to another is a genuine **third-party cookie**, and modern browsers can silently refuse to store it — regardless of `SameSite`, regardless of CORS headers. No amount of header tuning fixes this; it's a different browser subsystem (tracking protection / third-party cookie deprecation) than CORS or SameSite.

**How we found it:** a browser console warning ("Chrome may soon delete state for intermediate websites in a recent navigation chain") was the tell. Confirmed by checking `curl https://publicsuffix.org/list/public_suffix_list.dat | grep onrender.com`.

**Fix — architectural, not a header:** routed the *entire* OIDC flow through the frontend's own origin. The frontend's nginx already proxied `/api/*` to the backend (to avoid plain CORS); we extended that to also proxy `/auth/*` (the callback path), and changed `redirect_uri` to point at the **frontend's own domain** (`https://vue-upload-form.onrender.com/auth/callback`), not the backend's. nginx forwards the request to the real backend server-side — the browser never knows or cares, since it only ever talks to one origin, start to finish. Cookies set and read during this flow are now first-party throughout.

**Lesson:** this is the single most important lesson in this whole document. If your frontend and backend are deployed as separate services under a shared *hosting* domain (Render, Vercel, Netlify, GitHub Pages, ...), check whether that domain is on the Public Suffix List before assuming "same parent domain" means "same site" for cookie purposes. If it does, cookies must be made first-party via a reverse proxy — CORS and SameSite configuration alone cannot fix third-party cookie blocking.

---

## Category E — eSignet/OIDC-specific gotchas

### E1. `redirect_uri` must match exactly what's registered — and match itself across steps

**Symptom:** eSignet's own error page: *"Oups! Il semble y avoir un problème avec l'URL."*

**Root cause:** the `redirect_uri` sent during `/authorize` must be byte-for-byte identical to what's registered with the identity provider for this client, AND identical to what's sent later during the token exchange. When we changed the architecture (D4) to point `redirect_uri` at the frontend's domain, that new URL hadn't been registered with MOSIP/ANIP yet.

**Fix:** requested the identity-provider team (ANIP) update the registered `redirect_uri` to the new value. No code fix possible — this is external coordination, not a bug.

**Lesson:** any time you change `redirect_uri` (even for a legitimate architectural reason), you must re-register it with the identity provider. Budget time for this coordination step — it's not instant.

### E2. Private key lost its line breaks when pasted into a dashboard

**Symptom:** `TypeError: "pkcs8" must be PKCS#8 formatted string` when the backend tried to sign a client-assertion JWT.

**Root cause:** a PKCS8 private key is multi-line text. Pasting it into some web dashboards' env-var fields can silently collapse or corrupt the line breaks.

**Fix:** reformatted the key as a **single line** with literal `\n` escape sequences instead of real line breaks, and made the app's env parsing un-escape them (`value.replace(/\\n/g, "\n")`). This form survives being pasted into almost any text field, since there's nothing for the field to "helpfully" reformat.

**Lesson:** any multi-line secret (private keys, certificates) being passed through a web UI is at risk of whitespace mangling. The single-line-with-escaped-newlines trick is a standard, robust workaround — verify it parses correctly *before* trusting it in production (we wrote a small script that actually calls `importPKCS8()` on the value to confirm).

### E3. Issuer mismatch: the real `iss` includes a path, not just the host

**Symptom:** `JWTClaimValidationFailed: unexpected "iss" claim value`.

**Root cause:** we'd configured `ESIGNET_ISSUER=https://esignet.benin.mosip.net`, but the real `id_token` we received had `iss: "https://esignet.benin.mosip.net/v1/esignet"` — a path suffix we hadn't accounted for.

**Fix:** updated `ESIGNET_ISSUER` to the exact value observed in a real, decoded token.

**Lesson:** don't trust a provider's documentation or a generic integration guide for exact endpoint/issuer values — verify against what a **real token** actually contains. Decode a real `id_token` (its payload is plain base64, not encrypted) and compare, claim by claim, against your configuration.

### E4. UserInfo endpoint doesn't behave like the id_token

**Symptom:** `JWTClaimValidationFailed: missing required "iss" claim` — this time from the *UserInfo* response, not the id_token, which had already passed validation.

**Root cause:** two separate, real quirks of this specific eSignet deployment:
1. Its UserInfo response's signing key doesn't match what its own JWKS endpoint publishes (a known, documented limitation — meaning the signature genuinely cannot be cryptographically verified).
2. Its UserInfo JWT **omits `iss` and `aud` entirely** — unlike the id_token, which includes them correctly.

**Fix:** two parts. First, a "trust but verify what you can" compatibility mode (`ESIGNET_ALLOW_UNVERIFIED_USERINFO=true`) that skips signature verification but still checks: the endpoint is HTTPS and same-origin as the issuer, the algorithm is the expected one, and `iss`/`aud` match **if present**. Second — the actual fix that took an extra iteration — that last check had to become conditional (`if present`), because we'd initially written it as a hard requirement, which broke on real data that simply doesn't include those claims.

**Lesson:** "verify against real data" applies recursively — even your compatibility/fallback logic needs testing against the real, messy response, not just against what the spec says *should* be there. Two similar-looking endpoints (id_token vs. UserInfo) from the *same* provider can have meaningfully different claim sets.

### E5. Placeholder junk value (`"nan"`) shown as if it were real data

**Symptom:** the dashboard displayed `Adresse e-mail: nan`.

**Root cause:** eSignet sends the literal string `"nan"` for some optional claims that are unavailable or unconsented — not `null`, not an omitted field, an actual four-character string. (This is a classic sign of a backend that serializes a missing value from a data-science-style pipeline, e.g. Python's `pandas.NaN`, into a plain string somewhere along the way.)

**Fix:** added a small filter that treats `"nan"`, `"null"`, `"undefined"`, `"none"`, and empty strings (case-insensitive) as "no value," on the frontend where the data is displayed.

**Lesson:** never trust that "absent" data will be represented as `null`/`undefined`/omitted. Real third-party APIs invent their own placeholder conventions. Filter defensively at the display layer, and log/inspect a real response before assuming you know its shape.

---

## A note on debugging method, not just the bugs

Across every one of these, the technique that actually found the root cause was the same: **stop guessing, go look at the real thing.**

- Don't assume a connection string is right — resolve the hostname and see what IP it actually gives you.
- Don't assume a config value matches the spec — decode a real token and diff it, claim by claim.
- Don't assume a header is the problem — check with `curl -v` / `curl -sD -` what's *actually* being sent and received.
- Don't assume an intermittent failure is a bug — reproduce it a few more times before writing a fix.
- Don't assume your own compatibility/fallback code is correct just because it typechecks — run it against the real, messy data it'll actually see in production.

## Checklist for the next eSignet (or any OIDC) integration

- [ ] Confirm whether frontend and backend hosting domains share a Public Suffix List entry. If so, plan for a same-origin proxy from the start — don't discover this after building the cross-origin version first.
- [ ] Decode a real `id_token` and a real UserInfo response early, and compare every claim against your configuration — don't trust the provider's docs alone.
- [ ] Confirm the exact registered `redirect_uri` with the identity provider before writing any code that assumes a different one.
- [ ] Test multi-line secrets (private keys) through whatever dashboard/CI system will actually hold them, before deploying — verify they parse, don't just assume.
- [ ] Check whether your hosting platform's "managed database" offering is actually free before designing around it.
- [ ] Write CORS + cookie config (`credentials`, `SameSite`, `Access-Control-Allow-Credentials`) as a deliberate, documented decision — not trial and error line by line.
