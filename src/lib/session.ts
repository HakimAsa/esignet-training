import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";

export const SESSION_COOKIE = "session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// Our own session mechanism — unrelated to eSignet's keys. A plain signed (not
// encrypted) JWT is fine here because the payload only ever holds our internal
// user id, never eSignet claims.
const sessionSecret = new TextEncoder().encode(env.ESIGNET_SESSION_SECRET);

export async function createSessionToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(sessionSecret);
}

/** Returns the user id embedded in a session token, or null if it's missing/invalid/expired. */
export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret);
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
