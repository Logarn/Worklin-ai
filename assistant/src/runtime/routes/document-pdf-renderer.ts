/**
 * Markdown to PDF renderer for document export.
 *
 * Converts markdown content to styled HTML via `marked`, then renders
 * the HTML to a PDF buffer using Playwright headless Chromium.
 * The HTML template uses print-friendly styling that matches the
 * document editor typography.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { marked } from "marked";

import {
  ensureChromiumHeadlessShell,
  importPlaywright,
} from "../../tools/browser/runtime-check.js";

// ---------------------------------------------------------------------------
// Print template
// ---------------------------------------------------------------------------

const FONT_STACK = `"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

function headlessShellVersion(path: string): number {
  const match = /chromium_headless_shell-(\d+)/.exec(path);
  return match ? Number(match[1]) : 0;
}

function findInstalledHeadlessShell(): string | null {
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ].filter((value): value is string => Boolean(value));

  const executableSuffixes = [
    ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
    ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
    ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
  ];

  const candidates: string[] = [];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      for (const suffix of executableSuffixes) {
        const candidate = join(root, entry, ...suffix);
        if (existsSync(candidate)) candidates.push(candidate);
      }
    }
  }

  candidates.sort((a, b) => headlessShellVersion(b) - headlessShellVersion(a));
  return candidates[0] ?? null;
}

function wrapInPrintTemplate(innerHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: ${FONT_STACK};
    font-size: 14px;
    line-height: 1.7;
    color: #111111;
    background: #f4f5f6;
    padding: 0;
  }

  h1 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 34px;
    line-height: 1.05;
    font-weight: 800;
    margin-top: 28px;
    margin-bottom: 14px;
    letter-spacing: 0;
  }
  h2 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 24px;
    line-height: 1.15;
    font-weight: 800;
    margin-top: 34px;
    margin-bottom: 10px;
    letter-spacing: 0;
  }
  h3 { font-size: 18px; font-weight: 700; margin-top: 24px; margin-bottom: 8px; }
  h4, h5, h6 { font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 8px; }

  p {
    margin-bottom: 12px;
  }

  pre {
    background: #f5f5f5;
    border-radius: 8px;
    padding: 12px 16px;
    overflow-x: auto;
    margin-bottom: 12px;
  }

  code {
    font-family: "DM Mono", "SF Mono", monospace;
    font-size: 13px;
    background: #f5f5f5;
    border-radius: 4px;
    padding: 2px 5px;
  }

  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  blockquote {
    border-left: 3px solid #6366f1;
    padding-left: 16px;
    margin: 12px 0;
    color: #555555;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    background: #ffffff;
  }

  th, td {
    border: 1px solid #e0e0e0;
    padding: 8px 12px;
    text-align: left;
  }

  th {
    background: #f5f5f5;
    font-weight: 600;
  }

  ul, ol {
    margin: 12px 0;
    padding-left: 24px;
  }

  li {
    margin-bottom: 4px;
  }

  a {
    color: #6366f1;
    text-decoration: none;
  }

  hr {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 24px 0;
  }

  .worklin-pdf-chart-card {
    page-break-inside: avoid;
    break-inside: avoid;
    border: 1px solid #eeeeee;
    border-radius: 14px;
    padding: 22px 24px 20px;
    margin: 18px 0 22px;
    background: #ffffff;
    box-shadow: 0 18px 42px rgba(17, 17, 17, 0.08);
  }

  .worklin-pdf-chart-card h4 {
    margin: 3px 0 18px;
    font-size: 18px;
    font-weight: 800;
    color: #111111;
  }

  .worklin-pdf-chart-eyebrow {
    color: #7a7a7a;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .worklin-pdf-chart-bars {
    display: grid;
    gap: 12px;
  }

  .worklin-pdf-chart-row {
    display: grid;
    grid-template-columns: minmax(150px, 1.1fr) minmax(260px, 2.5fr) 72px;
    gap: 14px;
    align-items: center;
    font-size: 12px;
  }

  .worklin-pdf-chart-label {
    color: #262626;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .worklin-pdf-chart-track {
    display: block;
    height: 20px;
    overflow: hidden;
    border-radius: 999px;
    background: #f0f1f2;
  }

  .worklin-pdf-chart-fill {
    display: block;
    height: 100%;
    min-width: 5px;
    border-radius: inherit;
  }

  .worklin-pdf-chart-row strong {
    color: #111111;
    font-size: 12px;
    text-align: right;
  }

  .worklin-pdf-chart-caption {
    margin: 12px 0 0;
    color: #6b7280;
    font-size: 11px;
  }

  .worklin-pdf-chip-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
  }

  .worklin-pdf-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid color-mix(in srgb, var(--chip-color) 42%, #d7d7d7);
    border-left: 5px solid var(--chip-color);
    border-radius: 999px;
    padding: 7px 11px;
    background: #ffffff;
    color: #111111;
    font-size: 12px;
    font-weight: 600;
  }

  img {
    max-width: 100%;
    height: auto;
  }

</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a markdown string to a PDF buffer.
 *
 * Parses markdown to HTML via `marked`, wraps it in a print-friendly
 * template, then renders to PDF using Playwright headless Chromium.
 * The browser is always closed in a `finally` block.
 */
export async function renderMarkdownToPDF(
  title: string,
  markdown: string,
): Promise<Buffer> {
  const innerHtml = marked.parse(markdown, {
    gfm: true,
    breaks: true,
  }) as string;
  const fullHtml = wrapInPrintTemplate(innerHtml);

  const pw = await importPlaywright();
  await ensureChromiumHeadlessShell(pw);
  let browser: Awaited<ReturnType<typeof pw.chromium.launch>>;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (error) {
    const executablePath = findInstalledHeadlessShell();
    if (!executablePath) throw error;
    browser = await pw.chromium.launch({ headless: true, executablePath });
  }
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(fullHtml, { waitUntil: "domcontentloaded" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      margin: {
        top: "0.75in",
        bottom: "0.75in",
        left: "0.75in",
        right: "0.75in",
      },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}
