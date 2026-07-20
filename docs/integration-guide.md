# eSignet OIDC Integration Guide — Split Frontend/Backend Architecture

*[Version française →](./integration-guide.fr.md)* · *See also: [debug.md](./debug.md) for the bugs we hit building this.*

## Why this document exists

Generic eSignet integration guides (including MOSIP's own reference docs) assume a monolithic app — frontend and backend on the same domain. That's not how most real deployments work: a Vue/React SPA on one host, an API on another. This guide documents the **exact, working configuration** for that split architecture, as built and verified against a real production eSignet deployment (`esignet.benin.mosip.net`). Every value, endpoint, and quirk here was confirmed against real tokens and real API responses — not copied from documentation.

If you're starting a new eSignet integration with a similar split architecture, this is the reference to follow. If something here doesn't match what you observe, trust your own observation over this document — providers evolve, and this reflects one point in time.

## 1. Architecture

```
                    ┌─────────────────────────┐
  Citizen's browser │  vue-upload-form (nginx) │
                    │  static SPA + reverse    │
                    │  proxy for /api/* and    │
                    │  /auth/*                 │
                    └───────────┬─────────────┘
                                │ proxied server-side
                                ▼
                    ┌─────────────────────────┐
                    │  esignet-backend         │
                    │  (Express/TypeScript)    │
                    │  - OIDC client logic     │
                    │  - session issuance      │
                    │  - Postgres access       │
                    └───────────┬─────────────┘
                                │
                    ┌───────────┴─────────────┐
                    │  Supabase Postgres        │
                    └───────────────────────────┘

                    ┌─────────────────────────┐
                    │  esignet.benin.mosip.net │
                    │  (MOSIP eSignet, OIDC IdP)│
                    └─────────────────────────┘
```

Two independently deployed services (Render, in our case), plus the identity provider and the database. **The browser only ever talks to the frontend's own origin.** This single design decision is what everything else in this guide is built around — see §3.

## 2. Prerequisites — what to get from MOSIP/ANIP

Before writing any code, you need, from whoever manages eSignet client registration:

| Item | Notes |
|---|---|
| `client_id` | Identifies your app to eSignet. |
| Registered `redirect_uri` | **Must be your frontend's own origin** + `/auth/callback` (e.g. `https://your-app.example.com/auth/callback`), not the backend's domain. See §3 for why. If you don't control the final production domain yet, register it once you do — don't guess. |
| Approved scopes/claims | e.g. `openid profile email phone`, plus which specific claims (`name`, `picture`, `birthdate`, `gender`, `phone_number`, `address`, `individual_id`, ...) your client is authorized to request. Requesting an unapproved claim doesn't error — it just silently comes back empty. |
| Confirmation of client auth method | This deployment uses `private_key_jwt` (RS256) — your backend signs a JWT with its own key instead of a shared secret. |

You generate the RSA key pair yourself (see §4) and send only the **public** half to be registered.

## 3. Why redirect_uri must be the frontend's own domain

This is the single most important architectural decision in this whole integration, and the one most likely to be missed by a generic guide.

**The problem:** if your frontend and backend are separate services under a shared *hosting* domain (Render's `onrender.com`, Vercel's `vercel.app`, GitHub's `github.io`, Netlify's `netlify.app`, ...), check whether that domain is on the [Public Suffix List](https://publicsuffix.org/list/). If it is, every tenant subdomain is treated by browsers as an **independent site**, not just a different origin. A cookie set via a cross-site `fetch()` call from your frontend directly to your backend is a third-party cookie, and modern browsers can silently refuse to store it — this breaks both the pre-login CSRF cookie and the post-login session cookie, with no useful error message (it just looks like "the cookie isn't there").

**The fix:** make the entire OIDC flow — not just your regular API calls — same-origin from the browser's point of view:

1. The frontend's web server (nginx, in our case) reverse-proxies **both** `/api/*` (your regular API calls) and `/auth/*` (the OIDC callback) to the backend.
2. `redirect_uri` (both `VITE_ESIGNET_REDIRECT_URI` on the frontend and `ESIGNET_REDIRECT_URI` on the backend — these must be byte-for-byte identical) is set to the **frontend's own domain**: `https://<frontend-domain>/auth/callback`.
3. When eSignet redirects the browser back after login, it lands on the frontend's own origin. nginx transparently forwards that specific request to the real backend server-side. The browser never knows a different server handled it — it only ever sees one origin, start to finish. Every cookie set or read during the flow is first-party.

```nginx
# nginx.conf (frontend) — both proxied to the same backend
location /api/ {
    proxy_pass http://backend-host:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /auth/ {
    proxy_pass http://backend-host:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

If your platform doesn't support a domain on the Public Suffix List at all (i.e. frontend and backend genuinely share a registrable domain, like `app.example.com` and `api.example.com` both under `example.com`), you can skip this and call the backend cross-origin directly with standard CORS (`Access-Control-Allow-Credentials: true` + a specific, non-wildcard `Access-Control-Allow-Origin`) — but verify this assumption before relying on it.

## 4. Generating the client key pair

The client authenticates itself to the token endpoint with a signed JWT (`private_key_jwt`), not a shared secret.

```bash
npm run esignet:generate-key
```

This generates a 2048-bit RSA key pair (RS256), assigns it a random `kid`, and produces:
- A **public** JWK (`esignet-public-jwk.json`) — send this file to the MOSIP/eSignet team for registration.
- A **private** key (PKCS8 PEM) — paste into `ESIGNET_PRIVATE_KEY`, never committed.

**Pasting a multi-line private key into a web dashboard (Render, or similar) is a known failure point.** Line breaks can get silently collapsed. Reformat the key as a single line with literal `\n` escape sequences instead of real newlines:

```
-----BEGIN PRIVATE KEY-----\nMIIEvAIB...\n-----END PRIVATE KEY-----
```

Your env-parsing code needs to un-escape this (`value.replace(/\\n/g, "\n")`). Verify it actually parses before trusting it in production:

```js
import { importPKCS8 } from "jose";
await importPKCS8(keyString.replace(/\\n/g, "\n"), "RS256"); // throws if malformed
```

## 5. Environment variables reference

### Frontend (build-time — Vite `VITE_*`, baked into the JS bundle)

| Variable | Real value / example | Notes |
|---|---|---|
| `VITE_ESIGNET_CLIENT_ID` | *(from onboarding)* | |
| `VITE_ESIGNET_REDIRECT_URI` | `https://<frontend-domain>/auth/callback` | **Frontend's own domain**, not the backend's. See §3. |
| `VITE_ESIGNET_AUTHORIZE_URI` | `https://esignet.benin.mosip.net/authorize` | |
| `VITE_ESIGNET_SCOPE` | `openid profile email phone` | |
| `VITE_ESIGNET_ACR_VALUES` | *(optional)* | |
| `VITE_API_BASE_URL` | *(empty)* | Left empty so API calls use relative paths, proxied same-origin. Do **not** set this to the backend's URL. |

### Backend (server-only secrets/config)

| Variable | Real value / example | Notes |
|---|---|---|
| `ESIGNET_CLIENT_ID` | *(same as frontend's)* | |
| `ESIGNET_PRIVATE_KEY` | PKCS8 PEM, single-line `\n`-escaped | See §4. |
| `ESIGNET_KEY_ID` | *(the `kid` from key generation)* | |
| `ESIGNET_SESSION_SECRET` | random 32+ chars | Signs **our own** session cookie — unrelated to eSignet's keys. |
| `ESIGNET_ISSUER` | `https://esignet.benin.mosip.net/v1/esignet` | **Includes the `/v1/esignet` path** — verified against a real `id_token`'s `iss` claim. Don't assume it's just the bare host. |
| `ESIGNET_TOKEN_URL` | `https://esignet.benin.mosip.net/v1/esignet/oauth/v2/token` | |
| `ESIGNET_USERINFO_URL` | `https://esignet.benin.mosip.net/v1/esignet/oidc/userinfo` | |
| `ESIGNET_JWKS_URL` | `https://esignet.benin.mosip.net/.well-known/jwks.json` | |
| `ESIGNET_REDIRECT_URI` | `https://<frontend-domain>/auth/callback` | Must be byte-for-byte identical to the frontend's value. |
| `ESIGNET_ALLOW_UNVERIFIED_USERINFO` | `true` | **Required true against this specific deployment** — see §6.4. |

## 6. The login flow, step by step

1. **User clicks "Continuer avec eSignet"** on the frontend. Before rendering MOSIP's official sign-in button (`sign-in-button-plugin.js`), the frontend calls `GET /api/auth/esignet/prepare`.
2. **Backend `/prepare`** generates `state` and `nonce` (24 random bytes each), stores them (as base64url-encoded JSON) in an httpOnly cookie (`esignet_oauth`, `SameSite=Lax`, 10-minute expiry), and returns `{state, nonce}` as JSON.
3. **Frontend initializes the eSignet button** with `oidcConfig: { ...clientConfig, state, nonce, prompt: "consent" }`. Clicking it navigates the top-level browser to eSignet's `/authorize` endpoint — a real page navigation, not a fetch.
4. **User authenticates at eSignet** (OTP, password, biometrics, ...) and consents to the requested claims, on eSignet's own hosted pages.
5. **eSignet redirects the browser** to `redirect_uri?code=...&state=...` (or `?error=...` if the user cancelled/denied).
6. **Backend `GET /auth/callback`**:
   - Reads and clears the `esignet_oauth` cookie.
   - Compares the `state` query param against the cookie's stored value (CSRF check) — mismatch or missing cookie → reject.
   - Exchanges `code` for tokens: `POST` to the token endpoint with `grant_type=authorization_code`, the same `redirect_uri`, and a signed `client_assertion` JWT (RS256, `aud` = token endpoint URL, 5-minute expiry, unique `jti`).
   - Verifies the returned `id_token`: signature against the JWKS, `iss` and `aud` match config, and `nonce` matches the value from step 2 (this last check is what actually binds the callback to *this* login attempt — signature/issuer/audience alone don't prevent a stolen code+state pair from a different session being replayed).
   - Fetches `UserInfo` with the access token — see §6.4 for this deployment's specific quirks.
   - Upserts a local `User` row keyed on `sub` (the stable eSignet identity — never key on email, which may be absent or change), storing every consented claim in a generic `profile` JSON column (not one column per possible claim — new claim types then need no schema change).
   - Issues our own session (a signed HS256 JWT containing the local user id, in an httpOnly `session` cookie), and redirects to `/dashboard` on the frontend.
7. **Frontend `/dashboard`** calls `GET /api/auth/me` on mount; if 401, redirects to `/login?esignet_required=1`. Otherwise renders whatever's in `profile`.

### 6.4 UserInfo-specific quirks (this deployment)

Two real, verified findings that a generic guide wouldn't tell you:

- **The signing key on UserInfo responses doesn't match this deployment's published JWKS.** The signature genuinely cannot be cryptographically verified. `ESIGNET_ALLOW_UNVERIFIED_USERINFO=true` is required, not optional, against `esignet.benin.mosip.net`.
- **The UserInfo JWT omits `iss` and `aud` entirely** — unlike the id_token, which includes both correctly. Any validation logic that treats `iss`/`aud` as required on UserInfo (matching the id_token's stricter checks) will fail on real data. Check them only if present.

Because signature verification is skipped, "trust but verify what's checkable" applies instead:
- The UserInfo endpoint must be HTTPS and same-origin as the issuer.
- The JWT's `alg` header must still be the expected `RS256` (reject anything else).
- `iss`/`aud`, if present, must still match.

- **Some optional claims come back as the literal string `"nan"`**, not `null` and not omitted, when unavailable or not consented. Filter these out at display time — don't assume "absent" means `null`/`undefined`.

## 7. Session & logout

| Cookie | Set by | Contents | Lifetime |
|---|---|---|---|
| `esignet_oauth` | `/api/auth/esignet/prepare` | `{state, nonce}`, base64url JSON | 10 minutes; cleared unconditionally by the callback (success or failure) |
| `session` | `/auth/callback` (on success) | Signed JWT, local user id only | 7 days |

Logout (`GET/POST /api/auth/esignet/logout`) expires both cookies and redirects to `/login`. It's meant to be triggered by a real browser navigation (`window.location.href`), not a `fetch()` — a fetch can't produce the redirect that actually navigates the browser away.

There is no known `end_session_endpoint` published by this eSignet deployment's discovery document — logout is local to this app only, not a global eSignet sign-out.

## 8. Deployment (Render)

Both services deploy via `render.yaml` Blueprints (**use "New → Blueprint" in Render's dashboard, not "New → Web Service"** — only the Blueprint flow reads `render.yaml`).

- **Database:** Render's own managed Postgres has no free tier. We use Supabase instead. Two Supabase-specific gotchas:
  - Use the **Session pooler** connection string (`aws-0-<region>.pooler.supabase.com:5432`), not the direct one (`db.<ref>.supabase.co`) — the direct one is IPv6-only and unreachable from many networks.
  - Append `&uselibpqcompat=true` to the connection string alongside `sslmode=require` — otherwise `pg` treats `sslmode=require` as requiring full certificate verification, which fails against Supabase's certificate chain.
- **Free-tier cold starts:** both services can spin down after inactivity; a request can transiently 502 while an instance wakes up (up to ~50s). This is expected, not a bug — don't chase it as one.

## 9. Real endpoint reference — esignet.benin.mosip.net

Confirmed against this deployment's discovery document and real tokens:

| Item | Value |
|---|---|
| Issuer | `https://esignet.benin.mosip.net/v1/esignet` |
| Authorization endpoint | `https://esignet.benin.mosip.net/authorize` |
| Token endpoint | `https://esignet.benin.mosip.net/v1/esignet/oauth/v2/token` |
| UserInfo endpoint | `https://esignet.benin.mosip.net/v1/esignet/oidc/userinfo` |
| JWKS | `https://esignet.benin.mosip.net/.well-known/jwks.json` |
| Response type | `code` |
| Client auth | `private_key_jwt`, RS256 |
| id_token / UserInfo signature alg | RS256 (UserInfo signature not verifiable in practice — see §6.4) |
| Subject type | `pairwise` |
| Published scopes | `profile`, `email`, `phone` (plus `openid`, always required) |
| Published claims | `name`, `address`, `gender`, `birthdate`, `picture`, `email`, `phone_number`, `individual_id`, etc. |

## 10. Quick troubleshooting reference

For the full story behind each of these, see [debug.md](./debug.md).

| Symptom | Likely cause |
|---|---|
| `missing_or_expired_login_attempt` on callback | Cookie never survived to the callback — check CORS `credentials: true`, check `VITE_API_BASE_URL` isn't pointing cross-site, check whether your hosting domain is on the Public Suffix List (§3). |
| eSignet's own "problème avec l'URL" error page | `redirect_uri` doesn't match what's registered. |
| `TypeError: "pkcs8" must be PKCS#8 formatted string` | Private key line breaks got mangled pasting into a dashboard — see §4. |
| `JWTClaimValidationFailed: unexpected "iss" claim value` | `ESIGNET_ISSUER` doesn't match the real token — decode a real `id_token` and check. |
| `JWTClaimValidationFailed: missing required "iss" claim` (from UserInfo, not id_token) | Expected on this deployment — see §6.4; don't require `iss`/`aud` on UserInfo. |
| A claim displays as the literal text `nan` | Filter placeholder values at display time — see §6.4. |
| Logo/image blocked cross-origin (`NotSameOrigin`) | Helmet's default `Cross-Origin-Resource-Policy: same-origin` — relax it for public assets. |
