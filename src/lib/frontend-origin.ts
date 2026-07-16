import { env } from "../config/env.js";

function resolveFrontendOrigin(): string {
  const [origin] = env.CORS_ORIGIN;
  if (!origin) {
    throw new Error("CORS_ORIGIN must include at least one origin");
  }
  return origin;
}

// The trusted frontend origin to redirect the browser to after a top-level
// navigation (OIDC callback, logout) finishes. Reuses CORS_ORIGIN's first
// entry rather than introducing a separate env var for the same concept.
export const FRONTEND_ORIGIN = resolveFrontendOrigin();
