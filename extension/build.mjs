import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const outdir = new URL("./dist/", import.meta.url).pathname;
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync(new URL("./static/", import.meta.url).pathname, outdir, { recursive: true });

await build({
  entryPoints: ["src/popup.ts"],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outfile: `${outdir}popup.js`,
  minify: false,
  sourcemap: false,
  legalComments: "none",
});

console.log("Built extension into dist/. Load it in chrome://extensions → Load unpacked.");
