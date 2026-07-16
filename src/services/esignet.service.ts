import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, decodeJwt, importPKCS8, jwtVerify, SignJWT } from "jose";
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
  email?: string;
  name?: string;
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
    ? decodeJwt(jwt)
    : (await jwtVerify(jwt, esignetJwks, { issuer: env.ESIGNET_ISSUER, audience: env.ESIGNET_CLIENT_ID })).payload;

  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new AppError(502, "eSignet userinfo response missing sub claim");
  }

  return {
    sub: claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
  };
}
