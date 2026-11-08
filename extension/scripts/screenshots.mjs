// Screenshots of the popup with sample entries of every type: node extension/scripts/screenshots.mjs <dir>
// Bundles test/screens/harness.ts, opens it with popup.css in Chromium (Playwright, 360 px wide) and
// checks every shot: no horizontal scroll, the tabs in one row, secrets masked (except the revealed one).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outDir = process.argv[2];
if (!outDir) {
  console.error("Usage: node extension/scripts/screenshots.mjs <dir>");
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const { chromium } = createRequire(import.meta.url)("playwright");

const pageDir = mkdtempSync(join(tmpdir(), "passholder-screens-"));
await build({
  entryPoints: [join(root, "test/screens/harness.ts")],
  bundle: true,
  format: "iife", // a module script would not load from file://
  target: "chrome120",
  outfile: join(pageDir, "harness.js"),
  logLevel: "warning",
});
copyFileSync(join(root, "static/popup.css"), join(pageDir, "popup.css"));
writeFileSync(join(pageDir, "index.html"), `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>PassHolder</title><link rel="stylesheet" href="popup.css"></head>
<body><main id="app"></main><script src="harness.js"></script></body></html>`);

const SHOTS = [
  ["01-loginy.png", (s) => s.show("login")],
  ["02-kontakty.png", (s) => s.show("contact")],
  ["03-karty.png", (s) => s.show("card")],
  ["04-notatki.png", (s) => s.show("note")],
  ["05-dokumenty.png", (s) => s.show("document")],
  ["06-formularz-login.png", (s) => s.openForm("login")],
  ["07-formularz-kontakt.png", (s) => s.openForm("contact")],
  ["08-formularz-karta.png", (s) => s.openForm("card")],
  ["09-formularz-dokument.png", (s) => s.openForm("document")],
  ["10-pole-ukryte-pokazane.png", async (s) => { await s.openForm("login"); s.revealCustom(); }],
];

mkdirSync(resolve(outDir), { recursive: true });
const browser = await chromium.launch();
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  await page.goto(pathToFileURL(join(pageDir, "index.html")).href);
  await page.waitForFunction(() => window.__screens, null, { timeout: 60_000 });
  await page.evaluate(() => window.__screens);
  for (const [file, action] of SHOTS) {
    await page.evaluate(`window.__screens.then((s) => (${action.toString()})(s))`);
    // The focused search or name field would show a caret blinking in and out of the shots.
    await page.evaluate(() => document.activeElement?.blur());
    const check = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tabRows: new Set([...document.querySelectorAll(".tabs button")].map((b) => b.offsetTop)).size,
      clippedTabs: [...document.querySelectorAll(".tabs button")].filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.title),
      // A secret field still masked shows „Pokaż”; one shown as text while its toggle says „Pokaż” is a bug.
      revealed: [...document.querySelectorAll(".row")].filter((row) => {
        const toggle = [...row.children].find((c) => c.tagName === "BUTTON" && !c.hidden && /^(Pokaż|Ukryj)$/.test(c.textContent));
        return toggle && row.querySelector("input")?.type !== "password";
      }).length,
    }));
    if (check.overflow > 0) problems.push(`${file}: horizontal scroll of ${check.overflow} px`);
    if (check.clippedTabs.length) problems.push(`${file}: tab labels cut off: ${check.clippedTabs.join(", ")}`);
    if (check.tabRows > 1) problems.push(`${file}: tabs in ${check.tabRows} rows`);
    const expectRevealed = file.startsWith("10-") ? 1 : 0;
    if (check.revealed !== expectRevealed) problems.push(`${file}: ${check.revealed} secret field(s) shown, expected ${expectRevealed}`);
    await page.screenshot({ path: join(resolve(outDir), file), fullPage: true });
    console.log(`${file}`);
  }
} finally {
  await browser.close();
  rmSync(pageDir, { recursive: true, force: true });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
