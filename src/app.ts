import path from "node:path";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { oauthCallbackRouter } from "./routes/oauth-callback.route.js";
import { apiRouter } from "./routes/index.js";

// Resolves to <project root>/public in both dev (tsx running src/app.ts) and
// prod (node running dist/app.js) — src/ and dist/ both sit one level below
// the project root, so "../public" lands in the same place either way.
const PUBLIC_DIR = path.join(import.meta.dirname, "../public");

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(compression());
  app.use(express.static(PUBLIC_DIR));
  app.use(express.json());
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.use("/api", apiRouter);
  // Not under /api: this must be the exact path (host:port/auth/callback)
  // registered as this client's redirect_uri with eSignet.
  app.use("/auth", oauthCallbackRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
