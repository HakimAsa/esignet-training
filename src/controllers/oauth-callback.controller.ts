import type { Prisma } from "@prisma/client";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { FRONTEND_ORIGIN } from "../lib/frontend-origin.js";
import { logger } from "../lib/logger.js";
import { decodeAttempt, OAUTH_ATTEMPT_COOKIE } from "../lib/oauth-attempt.js";
import { prisma } from "../lib/prisma.js";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../lib/session.js";
import { callbackQuerySchema } from "../schemas/oauth-callback.schema.js";
import { exchangeCodeForTokens, fetchUserInfo, verifyIdToken } from "../services/esignet.service.js";

function redirectWithError(res: Response, reason: string) {
  logger.warn({ reason }, "eSignet login attempt failed");
  res.redirect(`${FRONTEND_ORIGIN}/login?error=${encodeURIComponent(reason)}`);
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

// eSignet's "sub" is the real identity; email is best-effort profile data that
// can legitimately repeat across sub values (e.g. shared test identities in
// the sandbox IdP). If a *different* user already owns this email, drop it
// rather than fail the whole login — sub-keyed upsert must never 500 over
// a non-identity field.
async function upsertEsignetUser(
  sub: string,
  email: string | null,
  name: string | null,
  profile: Prisma.InputJsonValue,
) {
  try {
    return await prisma.user.upsert({
      where: { sub },
      create: { sub, email, name, profile },
      update: { email, name, profile },
    });
  } catch (err) {
    if (!isUniqueConstraintError(err) || email === null) throw err;
    logger.warn({ sub }, "eSignet email already belongs to another account; continuing without it");
    return prisma.user.upsert({
      where: { sub },
      create: { sub, email: null, name, profile },
      update: { name, profile },
    });
  }
}

export const oauthCallbackController = {
  async handle(req: Request, res: Response) {
    // The esignet_oauth cookie (set by GET /api/auth/esignet/prepare) is what
    // ties this callback back to a specific browser's login attempt. Clear it
    // unconditionally so a single attempt can never be replayed, whether this
    // request succeeds or fails.
    const attemptCookie = req.cookies?.[OAUTH_ATTEMPT_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_ATTEMPT_COOKIE, { path: "/" });

    const query = callbackQuerySchema.safeParse(req.query);
    if (!query.success) {
      redirectWithError(res, "invalid_callback_request");
      return;
    }

    // eSignet redirects here with ?error=... if the user denied consent or
    // authentication otherwise failed — there's no code to exchange in that case.
    if (query.data.error) {
      redirectWithError(res, query.data.error_description ?? query.data.error);
      return;
    }

    const { code, state } = query.data;
    if (!code || !state) {
      redirectWithError(res, "missing_code_or_state");
      return;
    }

    const attempt = decodeAttempt(attemptCookie);
    if (!attempt) {
      redirectWithError(res, "missing_or_expired_login_attempt");
      return;
    }

    // CSRF guard: the state eSignet echoes back must match the one we minted
    // and stored server-side (in the cookie) when the login attempt started.
    if (attempt.state !== state) {
      redirectWithError(res, "state_mismatch");
      return;
    }

    try {
      const { accessToken, idToken } = await exchangeCodeForTokens(code);
      // Confirms the id_token's nonce matches attempt.nonce — see
      // verifyIdToken's doc comment for why that check matters here.
      await verifyIdToken(idToken, attempt.nonce);

      const claims = await fetchUserInfo(accessToken);
      // Log provenance, never the claim values themselves (per the guide's
      // observability guidance — logs must localize failures without
      // becoming a citizen data store).
      logger.info({ claimsSource: claims.claimsSource }, "eSignet userinfo loaded");

      const email = typeof claims.profile.email === "string" ? claims.profile.email : null;
      const name = typeof claims.profile.name === "string" ? claims.profile.name : null;
      const profile = claims.profile as Prisma.InputJsonValue;

      // Onboarding: create the local user record on first login, refresh their
      // profile fields on every subsequent one. Keyed on "sub" (the stable
      // eSignet identity), never on email — email may be absent or may change.
      // "profile" holds every consented claim verbatim, so the dashboard can
      // display exactly what was shared.
      const user = await upsertEsignetUser(claims.sub, email, name, profile);

      const sessionToken = await createSessionToken(user.id);
      res.cookie(SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: env.NODE_ENV === "production",
        path: "/",
        maxAge: SESSION_TTL_SECONDS * 1000,
      });

      // /dashboard is the frontend's protected landing page (see
      // GET /api/auth/me) — matches the ANIP integration guide's convention.
      res.redirect(`${FRONTEND_ORIGIN}/dashboard`);
    } catch (err) {
      logger.error({ err }, "eSignet callback processing failed");
      redirectWithError(res, "login_failed");
    }
  },
};
