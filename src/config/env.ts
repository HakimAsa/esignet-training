import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.url(),
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:3000")
    .transform((value) => value.split(",").map((origin) => origin.trim())),

  // eSignet (MOSIP OIDC) relying-party config — see src/services/esignet.service.ts
  ESIGNET_CLIENT_ID: z.string().min(1),
  // PKCS8 PEM used to sign the private_key_jwt client assertion sent to the token
  // endpoint. Accepts either real newlines (dotenv's native multiline quoting) or
  // literal "\n" escapes (common when a key is pasted from a secret manager).
  ESIGNET_PRIVATE_KEY: z
    .string()
    .min(1)
    .transform((value) => value.replace(/\\n/g, "\n")),
  // "kid" header on the client assertion JWT — must match the public key eSignet
  // has on file for this client.
  ESIGNET_KEY_ID: z.string().min(1),
  // Secret used to sign our own post-login session cookie (HS256) — unrelated to
  // eSignet's keys.
  ESIGNET_SESSION_SECRET: z.string().min(32),
  ESIGNET_ISSUER: z.url(),
  ESIGNET_TOKEN_URL: z.url(),
  ESIGNET_USERINFO_URL: z.url(),
  ESIGNET_JWKS_URL: z.url(),
  // Must be registered with eSignet as this exact client's redirect_uri, and must
  // be sent identically in the /authorize request (frontend) and the token
  // exchange request (below) — OIDC requires an exact string match.
  ESIGNET_REDIRECT_URI: z.url(),
  // When true, userinfo claims are trusted without verifying the JWS signature.
  // Only meant for local/sandbox eSignet instances with untrusted or mismatched
  // certs — keep this false against any real environment.
  ESIGNET_ALLOW_UNVERIFIED_USERINFO: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
