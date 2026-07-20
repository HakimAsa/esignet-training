import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../config/env.js";
import { FRONTEND_ORIGIN } from "../lib/frontend-origin.js";
import { encodeAttempt, OAUTH_ATTEMPT_COOKIE, OAUTH_ATTEMPT_TTL_SECONDS } from "../lib/oauth-attempt.js";
import { prisma } from "../lib/prisma.js";
import { SESSION_COOKIE, verifySessionToken } from "../lib/session.js";

export const authController = {
  // The frontend's Dashboard calls this (with credentials: "include") to check
  // whether there's a valid session and, if so, what to display. Returns
  // "profile" as-is — whatever claims the user actually consented to — so the
  // frontend can render exactly what was shared without knowing claim names
  // in advance.
  async me(req: Request, res: Response) {
    const sessionCookie = req.cookies?.[SESSION_COOKIE] as string | undefined;
    const userId = sessionCookie ? await verifySessionToken(sessionCookie) : null;
    if (!userId) {
      res.status(401).json({ error: "not_authenticated" });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(401).json({ error: "not_authenticated" });
      return;
    }

    res.json({ sub: user.sub, profile: user.profile ?? {} });
  },

  prepareEsignetLogin(_req: Request, res: Response) {
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");

    res.cookie(OAUTH_ATTEMPT_COOKIE, encodeAttempt({ state, nonce }), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: OAUTH_ATTEMPT_TTL_SECONDS * 1000,
    });

    res.json({ state, nonce });
  },

  // Expects a real browser navigation (not a fetch call) since it needs the
  // redirect to actually move the browser to /login — e.g. window.location.href.
  logoutEsignet(_req: Request, res: Response) {
    // Clear both cookies this app ever sets, regardless of which are actually
    // present: the session cookie (the active login) and the OAuth attempt
    // cookie (should already be gone post-login, but harmless/idempotent to
    // clear defensively — e.g. a login attempt started but never completed).
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.clearCookie(OAUTH_ATTEMPT_COOKIE, { path: "/" });

    res.redirect(`${FRONTEND_ORIGIN}/login`);
  },
};
