import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outdir = fileURLToPath(new URL("./dist/", import.meta.url));
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync(fileURLToPath(new URL("./static/", import.meta.url)), outdir, { recursive: true });

await build({
  entryPoints: ["src/popup.ts", "src/background.ts", "src/offscreen.ts"],
  bundle: true,
  format: "esm",
  target: "chrome127",
  outdir,
  minify: false,
  sourcemap: false,
  legalComments: "none",
});

await build({
  entryPoints: ["src/autofill-content.ts"],
  bundle: true,
  format: "iife",
  target: "chrome127",
  outdir,
  minify: false,
  sourcemap: false,
  legalComments: "none",
});

console.log("Built extension into dist/. Load it in chrome://extensions → Load unpacked.");
