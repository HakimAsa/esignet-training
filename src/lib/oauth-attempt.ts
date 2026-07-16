import { z } from "zod";

export const OAUTH_ATTEMPT_COOKIE = "esignet_oauth";
export const OAUTH_ATTEMPT_TTL_SECONDS = 10 * 60;

const attemptSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
});

export type OAuthAttempt = z.infer<typeof attemptSchema>;

/** Packs {state, nonce} into the opaque value stored in the esignet_oauth cookie. */
export function encodeAttempt(attempt: OAuthAttempt): string {
  return Buffer.from(JSON.stringify(attempt)).toString("base64url");
}

/**
 * Reverses encodeAttempt. Returns null instead of throwing on any malformed or
 * missing input — the caller (the callback route) treats that as "no attempt in
 * flight" and fails the login rather than crashing on a tampered/expired cookie.
 */
export function decodeAttempt(value: string | undefined): OAuthAttempt | null {
  if (!value) return null;

  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    const result = attemptSchema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
