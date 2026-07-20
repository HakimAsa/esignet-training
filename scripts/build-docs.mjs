#!/usr/bin/env node
/**
 * Converts the markdown docs in docs/ into styled, self-contained HTML pages
 * under public/docs/, served directly by the app (express.static already
 * covers public/) and suitable to publish standalone (e.g. as an Artifact).
 *
 * Run: npm run docs:build
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const DOCS_DIR = path.join(ROOT, "docs");
const FONTS_DIR = path.join(ROOT, "scripts/fonts");
const OUT_DIR = path.join(ROOT, "public/docs");

// cleanPath matches the routes mounted in src/routes/docs.route.ts — the
// canonical, linkable URL for each page. The .html files under public/docs/
// (built from `slug`) stay reachable too, directly via express.static, but
// all in-page navigation below points at the clean path.
const PAGES = [
  {
    slug: "integration-guide",
    file: "integration-guide.md",
    lang: "en",
    title: "eSignet Integration Guide",
    cleanPath: "/docs/integration-guide",
  },
  {
    slug: "integration-guide.fr",
    file: "integration-guide.fr.md",
    lang: "fr",
    title: "Guide d'intégration eSignet",
    cleanPath: "/docs/integration-guide/fr",
  },
  { slug: "debug", file: "debug.md", lang: "en", title: "Debugging Field Guide", cleanPath: "/docs/debug" },
  { slug: "debug.fr", file: "debug.fr.md", lang: "fr", title: "Guide de débogage", cleanPath: "/docs/debug/fr" },
];

async function b64(file) {
  const buf = await readFile(path.join(FONTS_DIR, file));
  return buf.toString("base64");
}

function fontFaceCss({ montserrat, sourceserif, plexmono }) {
  return `
@font-face {
  font-family: "Doc Display";
  font-weight: 700;
  font-style: normal;
  font-display: swap;
  src: url(data:font/woff2;base64,${montserrat}) format("woff2");
}
@font-face {
  font-family: "Doc Body";
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  src: url(data:font/woff2;base64,${sourceserif}) format("woff2");
}
@font-face {
  font-family: "Doc Mono";
  font-weight: 400;
  font-style: normal;
  font-display: swap;
  src: url(data:font/woff2;base64,${plexmono}) format("woff2");
}`;
}

const BASE_CSS = `
:root {
  --navy: #7fb2e6;
  --navy-ink: #050d18;
  --green: #3ddc91;
  --orange: #ff9d52;
  --paper: #0b1626;
  --ink: #e7ecf5;
  --ink-soft: #a9b4cc;
  --line: #223148;
  --card: #101d30;
  --code-bg: #0f1c30;
  --tag-symptom: #ff9d52;
  --tag-cause: #7fb2e6;
  --tag-fix: #3ddc91;
  --tag-lesson: #b79dee;
  --link: #8ec2f2;
}
/* Dark is the deliberate default here, regardless of OS/browser preference —
   these docs are meant to read like a technical reference at any hour. Light
   is available only via the explicit toggle button (see THEME_SCRIPT below)
   or an embedding viewer's own theme control ([data-theme]). */
:root[data-theme="dark"] {
  --navy: #7fb2e6; --navy-ink: #050d18; --green: #3ddc91; --orange: #ff9d52;
  --paper: #0b1626; --ink: #e7ecf5; --ink-soft: #a9b4cc; --line: #223148;
  --card: #101d30; --code-bg: #0f1c30; --tag-symptom: #ff9d52; --tag-cause: #7fb2e6;
  --tag-fix: #3ddc91; --tag-lesson: #b79dee; --link: #8ec2f2;
}
:root[data-theme="light"] {
  --navy: #073d69; --navy-ink: #0a2540; --green: #1f9d64; --orange: #c8600e;
  --paper: #f7f8fb; --ink: #1b2230; --ink-soft: #4e5872; --line: #dde3ee;
  --card: #ffffff; --code-bg: #eef1f8; --tag-symptom: #c8600e; --tag-cause: #073d69;
  --tag-fix: #1f9d64; --tag-lesson: #6a4fa0; --link: #0a5490;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Doc Body", Georgia, "Times New Roman", serif;
  font-size: 1.05rem;
  line-height: 1.7;
}

a { color: var(--link); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }

.topbar {
  background: var(--navy-ink);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 28px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: #fff;
  font-family: "Doc Display", sans-serif;
  font-weight: 700;
  font-size: 0.82rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--orange);
  color: var(--orange);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  font-weight: 700;
  flex-shrink: 0;
}

.lang-switch {
  display: flex;
  gap: 6px;
  font-family: "Doc Display", sans-serif;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.lang-switch a {
  color: rgba(255, 255, 255, 0.65);
  text-decoration: none;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.25);
}
.lang-switch a.active { color: #fff; border-color: #fff; }

.topbar-controls { display: flex; align-items: center; gap: 14px; }

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 999px;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  font-family: "Doc Display", sans-serif;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 5px 12px 5px 8px;
}
.theme-toggle:hover { border-color: rgba(255, 255, 255, 0.6); color: #fff; }
.theme-toggle svg { width: 14px; height: 14px; flex-shrink: 0; }

.doc {
  max-width: 740px;
  margin: 0 auto;
  padding: 48px 24px 96px;
}

.doc-header { margin-bottom: 8px; }
.eyebrow {
  font-family: "Doc Display", sans-serif;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin: 0 0 10px;
}
.doc h1 {
  font-family: "Doc Display", sans-serif;
  font-size: clamp(1.7rem, 4vw, 2.3rem);
  line-height: 1.2;
  color: var(--navy);
  margin: 0 0 6px;
  text-wrap: balance;
}
.doc .subtitle {
  color: var(--ink-soft);
  font-size: 1.05rem;
  margin: 0 0 32px;
}
.doc .subtitle a { font-weight: 600; }

.doc h2 {
  font-family: "Doc Display", sans-serif;
  font-size: 1.3rem;
  color: var(--navy);
  margin: 2.6em 0 0.7em;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--line);
}
.doc h3 {
  font-family: "Doc Display", sans-serif;
  font-size: 1.05rem;
  color: var(--ink);
  margin: 2em 0 0.5em;
}
.doc h3 code { font-size: 0.92em; }

.doc p { margin: 0 0 1.05em; }
.doc ul, .doc ol { margin: 0 0 1.05em; padding-left: 1.3em; }
.doc li { margin: 0.3em 0; }

.doc code {
  font-family: "Doc Mono", ui-monospace, monospace;
  font-size: 0.86em;
  background: var(--code-bg);
  border-radius: 4px;
  padding: 0.12em 0.4em;
}

.doc pre {
  background: var(--code-bg);
  border-left: 3px solid var(--navy);
  border-radius: 8px;
  padding: 16px 18px;
  overflow-x: auto;
  margin: 0 0 1.3em;
}
.doc pre code {
  background: none;
  padding: 0;
  font-size: 0.84em;
  line-height: 1.6;
  white-space: pre;
}

.table-wrap { overflow-x: auto; margin: 0 0 1.6em; }
.doc table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.92rem;
  font-family: "Doc Mono", ui-monospace, monospace;
}
.doc th {
  background: var(--navy);
  color: #fff;
  font-family: "Doc Display", sans-serif;
  font-weight: 700;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-align: left;
  padding: 9px 12px;
}
.doc td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.doc tr:last-child td { border-bottom: none; }

.doc p.tag {
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--line);
  border-left-width: 4px;
  padding: 12px 16px;
  margin: 0 0 10px;
  font-family: "Doc Mono", ui-monospace, monospace;
  font-size: 0.9rem;
}
.doc p.tag strong {
  font-family: "Doc Display", sans-serif;
  display: block;
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.tag-symptom { border-left-color: var(--tag-symptom); }
.tag-symptom strong { color: var(--tag-symptom); }
.tag-cause { border-left-color: var(--tag-cause); }
.tag-cause strong { color: var(--tag-cause); }
.tag-fix { border-left-color: var(--tag-fix); }
.tag-fix strong { color: var(--tag-fix); }
.tag-lesson { border-left-color: var(--tag-lesson); }
.tag-lesson strong { color: var(--tag-lesson); }

.doc blockquote {
  margin: 0 0 1.3em;
  padding: 4px 0 4px 16px;
  border-left: 3px solid var(--line);
  color: var(--ink-soft);
}

.doc hr { border: none; border-top: 1px solid var(--line); margin: 2.6em 0; }

footer.site {
  text-align: center;
  color: var(--ink-soft);
  font-size: 0.82rem;
  padding: 0 24px 48px;
}

@media (max-width: 600px) {
  .topbar { padding: 12px 16px; }
  .doc { padding: 32px 16px 64px; }
}
`;

function wrapTagParagraphs(html) {
  const labels = [
    ["Symptom", "tag-symptom"],
    ["Symptôme", "tag-symptom"],
    ["Root cause", "tag-cause"],
    ["Cause réelle", "tag-cause"],
    ["Diagnosis", "tag-cause"],
    ["Diagnostic", "tag-cause"],
    ["How we found it", "tag-cause"],
    ["Comment on l'a trouvé", "tag-cause"],
    ["Fix", "tag-fix"],
    ["Correctif", "tag-fix"],
    ["Lesson", "tag-lesson"],
    ["Leçon", "tag-lesson"],
  ];
  let out = html;
  for (const [label, cls] of labels) {
    const re = new RegExp(`<p><strong>(${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<]*)</strong>`, "g");
    out = out.replace(re, `<p class="tag ${cls}"><strong>$1</strong>`);
  }
  out = out.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  return out;
}

// Runs before first paint (placed early in <head>) so a stored light-mode
// choice applies immediately — otherwise the page would flash dark before
// switching, since dark is the CSS default.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("docs-theme");if(t)document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

const THEME_TOGGLE_BUTTON = `<button class="theme-toggle" id="theme-toggle" type="button" aria-label="Toggle light/dark theme">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>
  <span id="theme-toggle-label">Light</span>
</button>`;

// Wires the button up once it exists in the DOM — placed at the end of body,
// after the button markup, so no DOMContentLoaded listener is needed.
const THEME_WIRE_SCRIPT = `(function(){
  var btn = document.getElementById("theme-toggle");
  var label = document.getElementById("theme-toggle-label");
  if (!btn) return;
  function current() { return document.documentElement.getAttribute("data-theme") || "dark"; }
  function render() { label.textContent = current() === "dark" ? "Light" : "Dark"; }
  render();
  btn.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("docs-theme", next); } catch (e) {}
    render();
  });
})();`;

async function renderPage({ file, lang, title, cleanPath }, fonts) {
  const markdown = await readFile(path.join(DOCS_DIR, file), "utf8");
  const bodyHtml = wrapTagParagraphs(marked.parse(markdown, { gfm: true }));

  const enPath = cleanPath.endsWith("/fr") ? cleanPath.slice(0, -3) : cleanPath;
  const frPath = cleanPath.endsWith("/fr") ? cleanPath : `${cleanPath}/fr`;
  const langSwitch = `
    <div class="lang-switch">
      <a href="${enPath}" class="${lang === "en" ? "active" : ""}">EN</a>
      <a href="${frPath}" class="${lang === "fr" ? "active" : ""}">FR</a>
    </div>`;

  const eyebrow = lang === "fr" ? "ANIP eServices · Documentation technique" : "ANIP eServices · Technical documentation";

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script>${THEME_INIT_SCRIPT}</script>
<title>${title} — eSignet / ANIP</title>
<style>${fontFaceCss(fonts)}${BASE_CSS}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/docs"><span class="brand-mark">O</span> eSignet Docs</a>
  <div class="topbar-controls">
    ${langSwitch}
    ${THEME_TOGGLE_BUTTON}
  </div>
</header>
<main class="doc">
  <p class="eyebrow">${eyebrow}</p>
  ${bodyHtml}
</main>
<footer class="site">eService Lab × eSignet Bénin — documentation interne</footer>
<script>${THEME_WIRE_SCRIPT}</script>
</body>
</html>`;
}

async function renderIndex(fonts) {
  const cards = [
    {
      href: "/docs/integration-guide",
      title: "Integration Guide",
      lang: "EN",
      desc: "The real, battle-tested configuration for a split frontend/backend eSignet integration.",
    },
    {
      href: "/docs/integration-guide/fr",
      title: "Guide d'intégration",
      lang: "FR",
      desc: "La configuration réelle et éprouvée pour une intégration eSignet frontend/backend séparée.",
    },
    {
      href: "/docs/debug",
      title: "Debugging Field Guide",
      lang: "EN",
      desc: "Every real bug hit building this integration — symptom, root cause, fix, lesson.",
    },
    {
      href: "/docs/debug/fr",
      title: "Guide de débogage",
      lang: "FR",
      desc: "Chaque bug réellement rencontré en construisant cette intégration.",
    },
  ];

  const cardHtml = cards
    .map(
      (c) => `
    <a class="doc-card" href="${c.href}">
      <span class="doc-card-lang">${c.lang}</span>
      <h2>${c.title}</h2>
      <p>${c.desc}</p>
    </a>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<script>${THEME_INIT_SCRIPT}</script>
<title>eSignet Documentation — ANIP eServices</title>
<style>${fontFaceCss(fonts)}${BASE_CSS}
.index-main { max-width: 900px; margin: 0 auto; padding: 56px 24px 96px; }
.index-main h1 { font-family: "Doc Display", sans-serif; font-size: clamp(1.9rem, 4vw, 2.6rem); color: var(--navy); margin: 0 0 10px; text-wrap: balance; }
.index-main .lede { color: var(--ink-soft); font-size: 1.1rem; max-width: 56ch; margin: 0 0 40px; }
.card-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; }
@media (max-width: 640px) { .card-grid { grid-template-columns: 1fr; } }
.doc-card {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 22px 24px;
  text-decoration: none;
  color: var(--ink);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.doc-card:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(7, 61, 105, 0.1); }
.doc-card-lang {
  display: inline-block;
  font-family: "Doc Display", sans-serif;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--navy);
  background: var(--code-bg);
  border-radius: 999px;
  padding: 3px 10px;
  margin-bottom: 10px;
}
.doc-card h2 { font-family: "Doc Display", sans-serif; font-size: 1.15rem; margin: 0 0 8px; color: var(--ink); }
.doc-card p { margin: 0; color: var(--ink-soft); font-size: 0.95rem; }
</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/docs"><span class="brand-mark">O</span> eSignet Docs</a>
  <div class="topbar-controls">
    ${THEME_TOGGLE_BUTTON}
  </div>
</header>
<main class="index-main">
  <p class="eyebrow">ANIP eServices · eService Lab</p>
  <h1>eSignet integration documentation</h1>
  <p class="lede">Reference material from building the eSignet OIDC integration for ANIP eServices — the real, verified configuration and every bug it took to get there.</p>
  <div class="card-grid">
    ${cardHtml}
  </div>
</main>
<footer class="site">eService Lab × eSignet Bénin — documentation interne</footer>
<script>${THEME_WIRE_SCRIPT}</script>
</body>
</html>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const fonts = {
    montserrat: await b64("montserrat-700.woff2"),
    sourceserif: await b64("sourceserif-var.woff2"),
    plexmono: await b64("plexmono-400.woff2"),
  };

  for (const page of PAGES) {
    const html = await renderPage(page, fonts);
    await writeFile(path.join(OUT_DIR, `${page.slug}.html`), html);
    console.log(`built public/docs/${page.slug}.html`);
  }

  const indexHtml = await renderIndex(fonts);
  await writeFile(path.join(OUT_DIR, "index.html"), indexHtml);
  console.log("built public/docs/index.html");
}

main();
