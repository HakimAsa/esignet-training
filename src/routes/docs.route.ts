import { readFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";

// Pre-built by `npm run docs:build` (scripts/build-docs.mjs) from docs/*.md —
// see Dockerfile/prod.Dockerfile, which run that step during the image build.
// Loaded once at startup rather than read per-request: this content is
// static until the next deploy, so there's nothing to gain from re-reading
// the file on every hit.
const DOCS_DIR = path.join(import.meta.dirname, "../../public/docs");

function loadPage(file: string): string {
  return readFileSync(path.join(DOCS_DIR, file), "utf8");
}

const pages = {
  index: loadPage("index.html"),
  "integration-guide": loadPage("integration-guide.html"),
  "integration-guide/fr": loadPage("integration-guide.fr.html"),
  debug: loadPage("debug.html"),
  "debug/fr": loadPage("debug.fr.html"),
};

export const docsRouter = Router();

function serve(html: string) {
  return (_req: Request, res: Response) => {
    res.type("html").send(html);
  };
}

docsRouter.get("/", serve(pages.index));
docsRouter.get("/integration-guide", serve(pages["integration-guide"]));
docsRouter.get("/integration-guide/fr", serve(pages["integration-guide/fr"]));
docsRouter.get("/debug", serve(pages.debug));
docsRouter.get("/debug/fr", serve(pages["debug/fr"]));
