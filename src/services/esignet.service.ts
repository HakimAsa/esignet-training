import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, importPKCS8, jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error-handler.js";

/**
 * Algorithm for both the private_key_jwt client assertion and eSignet's own
 * token/userinfo signatures. RS256 is the common default for MOSIP eSignet
 * relying-party registrations; if the token endpoint rejects the assertion
 * with invalid_client, check the alg your client was registered with.
 */
const SIGNING_ALG = "RS256";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

// jose fetches and caches eSignet's signing keys from this endpoint, refetching
// automatically if a token references a kid it hasn't seen yet.
const esignetJwks = createRemoteJWKSet(new URL(env.ESIGNET_JWKS_URL));

export interface EsignetTokens {
  accessToken: string;
  idToken: string;
}

export interface EsignetUserInfo {
  sub: string;
  // Whatever claims the user actually consented to (name, picture, birthdate,
  // gender, phone_number, address, individual_id, ...) — verbatim, not
  // filtered to a fixed set, so new claim types don't need a code change.
  profile: Record<string, unknown>;
  // Where these claims actually came from — "userinfo" means the JWS
  // signature was cryptographically verified; "userinfo_transport" means the
  // ESIGNET_ALLOW_UNVERIFIED_USERINFO compatibility mode was used instead
  // (transport-trust only). Surfacing this lets logs/observability tell the
  // two apart, per the integration guide's recommendation.
  claimsSource: "userinfo" | "userinfo_transport";
}

// JWT/OIDC protocol metadata that rides alongside the actual profile claims
// in the userinfo payload — excluded so "profile" only ever holds attributes
// about the person, not token bookkeeping.
const PROTOCOL_CLAIM_KEYS = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "nbf",
  "iat",
  "jti",
  "nonce",
  "at_hash",
  "c_hash",
  "auth_time",
  "acr",
  "amr",
  "azp",
]);

function extractProfile(claims: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims).filter(([key]) => !PROTOCOL_CLAIM_KEYS.has(key)));
}

/**
 * Builds the short-lived JWT a confidential client presents to authenticate
 * itself at the token endpoint (RFC 7523 "private_key_jwt"), instead of a
 * shared client_secret. eSignet verifies the signature against the public key
 * it has on file for ESIGNET_KEY_ID.
 *
 * aud is set to the token endpoint URL, per RFC 7523's "intended audience"
 * guidance and common eSignet integration examples. If eSignet rejects it,
 * some deployments expect aud = ESIGNET_ISSUER instead.
 */
async function buildClientAssertion(): Promise<string> {
  const privateKey = await importPKCS8(env.ESIGNET_PRIVATE_KEY, SIGNING_ALG);

  return new SignJWT({})
    .setProtectedHeader({ alg: SIGNING_ALG, kid: env.ESIGNET_KEY_ID, typ: "JWT" })
    .setIssuer(env.ESIGNET_CLIENT_ID)
    .setSubject(env.ESIGNET_CLIENT_ID)
    .setAudience(env.ESIGNET_TOKEN_URL)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

/**
 * Exchanges the authorization code eSignet redirected the browser back with for
 * an access_token + id_token. redirect_uri here must match, character for
 * character, the one the frontend sent in its /authorize redirect — OIDC
 * requires an exact match and eSignet will reject the exchange otherwise.
 */
export async function exchangeCodeForTokens(code: string): Promise<EsignetTokens> {
  const clientAssertion = await buildClientAssertion();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.ESIGNET_REDIRECT_URI,
    client_id: env.ESIGNET_CLIENT_ID,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: clientAssertion,
  });

  const response = await fetch(env.ESIGNET_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new AppError(502, `eSignet token exchange failed (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { access_token?: string; id_token?: string };
  if (!json.access_token || !json.id_token) {
    throw new AppError(502, "eSignet token response missing access_token/id_token");
  }

  return { accessToken: json.access_token, idToken: json.id_token };
}

/**
 * Verifies the id_token's signature (against eSignet's published JWKS), issuer
 * and audience, then checks its nonce against the one generated for this login
 * attempt in /esignet/prepare. The nonce check is what actually binds this
 * callback to *this browser's* attempt — signature/issuer/audience alone don't
 * prevent a stolen code+state pair from a different session being replayed.
 */
export async function verifyIdToken(idToken: string, expectedNonce: string) {
  const { payload } = await jwtVerify(idToken, esignetJwks, {
    issuer: env.ESIGNET_ISSUER,
    audience: env.ESIGNET_CLIENT_ID,
  });

  if (payload.nonce !== expectedNonce) {
    throw new AppError(401, "id_token nonce does not match this login attempt");
  }

  return payload;
}

/**
 * Fallback path for ESIGNET_ALLOW_UNVERIFIED_USERINFO: the userinfo JWS's
 * signature isn't cryptographically checked (a known eSignet Benin quirk —
 * its userinfo signing key doesn't match what its own JWKS publishes), but we
 * still enforce everything checkable without a valid signature, per the ANIP
 * integration guide's compatibility-mode requirements:
 *  - transport trust: the endpoint must be HTTPS and same-origin as the issuer
 *  - alg must still be the expected RS256, not something unexpected
 *  - iss/aud continuity, same as the verified path would enforce
 */
function acceptUnverifiedUserInfo(jwt: string) {
  const userinfoUrl = new URL(env.ESIGNET_USERINFO_URL);
  const issuerUrl = new URL(env.ESIGNET_ISSUER);
  if (userinfoUrl.protocol !== "https:" || userinfoUrl.origin !== issuerUrl.origin) {
    throw new AppError(502, "userinfo endpoint is not same-origin HTTPS with the issuer — refusing unverified claims");
  }

  const { alg } = decodeProtectedHeader(jwt);
  if (alg !== SIGNING_ALG) {
    throw new AppError(502, `unexpected userinfo alg "${alg}" — refusing unverified claims`);
  }

  const payload = decodeJwt(jwt);
  if (payload.iss !== env.ESIGNET_ISSUER) {
    throw new AppError(502, "userinfo iss does not match configured issuer");
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.ESIGNET_CLIENT_ID)) {
    throw new AppError(502, "userinfo aud does not include this client_id");
  }

  return payload;
}

/**
 * Fetches OIDC userinfo. eSignet returns this as a signed JWT rather than
 * plain JSON, so by default it's verified against the same JWKS as the
 * id_token. ESIGNET_ALLOW_UNVERIFIED_USERINFO exists only to unblock
 * local/sandbox eSignet instances whose userinfo-signing cert doesn't
 * validate — never enable it against a real deployment.
 */
export async function fetchUserInfo(accessToken: string): Promise<EsignetUserInfo> {
  const response = await fetch(env.ESIGNET_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new AppError(502, `eSignet userinfo request failed: ${response.status}`);
  }

  const jwt = await response.text();

  const claims = env.ESIGNET_ALLOW_UNVERIFIED_USERINFO
    ? acceptUnverifiedUserInfo(jwt)
    : (await jwtVerify(jwt, esignetJwks, { issuer: env.ESIGNET_ISSUER, audience: env.ESIGNET_CLIENT_ID })).payload;

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new AppError(502, "eSignet userinfo response missing sub claim");
  }

  return {
    sub: claims.sub,
    profile: extractProfile(claims),
    claimsSource: env.ESIGNET_ALLOW_UNVERIFIED_USERINFO ? "userinfo_transport" : "userinfo",
  };
}
