import * as fs from "node:fs";
import * as path from "node:path";

/*
 * Pages the loopback OAuth server returns to the browser after the portal
 * redirects back. They follow the Maraha design language (lampas2-portal:
 * plan/DESIGN.md) and mirror the portal's launcher sign-in card, so the tab
 * reads as the same page settling into its result.
 *
 * The loopback server closes once it answers, so the page cannot load its
 * fonts afterwards. They are inlined as data URIs from the renderer bundle,
 * and the font stacks fall back to system faces when the files are missing.
 */

const FONTS = [
  {
    family: "IM Fell English",
    style: "normal",
    weight: 400,
    file: "IMFellEnglish-Regular",
  },
  {
    family: "IM Fell English",
    style: "italic",
    weight: 400,
    file: "IMFellEnglish-Italic",
  },
  {
    family: "Alegreya Sans",
    style: "normal",
    weight: 400,
    file: "AlegreyaSans-Regular",
  },
  {
    family: "Alegreya Sans",
    style: "normal",
    weight: 500,
    file: "AlegreyaSans-Medium",
  },
] as const;

// Packaged and built: Vite writes hashed copies to dist/renderer/assets.
// Unbuilt checkouts: the sources in ui/assets/fonts.
const FONT_DIRS = [
  path.join(__dirname, "renderer", "assets"),
  path.join(__dirname, "..", "ui", "assets", "fonts"),
];

let fontFaceCss: string | undefined;

function findFont(dir: string, entries: string[], name: string): string | null {
  const pattern = new RegExp(`^${name}(?:-[A-Za-z0-9_-]+)?\\.woff2$`);
  const match = entries.find((entry) => pattern.test(entry));
  return match ? path.join(dir, match) : null;
}

function loadFontFaceCss(): string {
  if (fontFaceCss !== undefined) return fontFaceCss;
  const rules: string[] = [];
  for (const font of FONTS) {
    for (const dir of FONT_DIRS) {
      try {
        const file = findFont(dir, fs.readdirSync(dir), font.file);
        if (!file) continue;
        const data = fs.readFileSync(file).toString("base64");
        rules.push(
          `@font-face { font-family: "${font.family}"; font-style: ${font.style}; font-weight: ${font.weight}; font-display: swap; src: url(data:font/woff2;base64,${data}) format("woff2"); }`,
        );
        break;
      } catch {
        // Missing directory or unreadable file: try the next one, then fall back.
      }
    }
  }
  fontFaceCss = rules.join("\n");
  return fontFaceCss;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderPage(options: {
  title: string;
  lede: string;
  notice: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>${options.title}</title>
    <style>
      ${loadFontFaceCss()}
      :root {
        --vault: #141026;
        --dusk-raised: #2a1f3b;
        --miasma: #9daf95;
        --gilt: #e2b45c;
        --gilt-bright: #f0cb7e;
        --bone: #ece6da;
        --ash: #a49db0;
        --hairline: rgb(236 230 218 / 0.14);
        --font-display: "IM Fell English", "Iowan Old Style", Georgia, serif;
        --font-sans: "Alegreya Sans", system-ui, sans-serif;
        color-scheme: dark;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { min-height: 100%; }
      body {
        background: var(--vault);
        color: var(--bone);
        font-family: var(--font-sans);
        -webkit-font-smoothing: antialiased;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 2.5rem 1rem;
      }
      ::selection { background: rgb(226 180 92 / 0.3); color: var(--bone); }
      main {
        width: 100%;
        max-width: 28rem;
        border: 1px solid var(--hairline);
        background: var(--dusk-raised);
        padding: 2rem;
      }
      header { text-align: center; }
      h1 {
        font-family: var(--font-display);
        font-weight: 400;
        font-size: 1.875rem;
        line-height: 1.25;
        color: var(--bone);
      }
      h1 em { color: var(--gilt-bright); }
      .lede { margin-top: 0.75rem; font-size: 0.875rem; line-height: 1.5; color: var(--ash); }
      .notice {
        margin-top: 1.5rem;
        border-left: 2px solid var(--hairline);
        background: rgb(20 16 38 / 0.6);
        padding: 0.75rem 1rem;
        font-size: 0.875rem;
        line-height: 1.5;
      }
      .notice.lit { border-left-color: rgb(226 180 92 / 0.6); }
      .notice.mist { border-left-color: var(--miasma); }
      .notice-title { font-weight: 500; }
      .notice.lit .notice-title { color: var(--gilt); }
      .notice.mist .notice-title { color: var(--miasma); }
      .notice-body { margin-top: 0.25rem; color: rgb(236 230 218 / 0.9); }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Lampas Launcher <em>sign-in</em></h1>
        <p class="lede">${options.lede}</p>
      </header>
      ${options.notice}
    </main>
  </body>
</html>`;
}

export function renderSuccessHtml(): string {
  return renderPage({
    title: "Signed in · Lampas Launcher",
    lede: "The launcher is connected to your Lampas account.",
    notice: `<div class="notice lit" role="status">
        <p class="notice-title">Signed in</p>
        <div class="notice-body">Close this tab and return to the Lampas Launcher.</div>
      </div>`,
  });
}

export function renderErrorHtml(
  message: string = "Authentication failed. Please return to the launcher and try again.",
): string {
  return renderPage({
    title: "Sign-in failed · Lampas Launcher",
    lede: "The launcher couldn't connect to your Lampas account.",
    notice: `<div class="notice mist" role="alert">
        <p class="notice-title">Sign-in failed</p>
        <div class="notice-body">${escapeHtml(message)}</div>
      </div>`,
  });
}
