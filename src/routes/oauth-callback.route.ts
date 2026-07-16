import { Router } from "express";
import { oauthCallbackController } from "../controllers/oauth-callback.controller.js";

// Mounted directly at /auth (not under /api) in app.ts: this path is the
// literal redirect_uri registered with eSignet, and the browser navigates here
// directly on redirect — it's never called as a same-origin API fetch.
export const oauthCallbackRouter = Router();

oauthCallbackRouter.get("/callback", oauthCallbackController.handle);
