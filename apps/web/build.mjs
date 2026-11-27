import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "dist");

mkdirSync(distDir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  metafile: true,
  outfile: resolve(distDir, "shell.js"),
});

writeFileSync(
  resolve(distDir, "metafile.json"),
  JSON.stringify(result.metafile, null, 2),
);
copyFileSync(resolve(__dirname, "src/styles.css"), resolve(distDir, "shell.css"));
copyFileSync(resolve(__dirname, "public/index.html"), resolve(distDir, "index.html"));

await esbuild.build({
  entryPoints: [resolve(__dirname, "src/automation.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: resolve(distDir, "automation.js"),
});
copyFileSync(
  resolve(__dirname, "public/automation.html"),
  resolve(distDir, "automation.html"),
);
