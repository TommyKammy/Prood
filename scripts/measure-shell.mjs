import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  { name: "shell.js", path: resolve(rootDir, "apps/web/dist/shell.js") },
  { name: "shell.css", path: resolve(rootDir, "apps/web/dist/shell.css") },
];

const report = assets.map((asset) => {
  const buf = readFileSync(asset.path);
  const gz = gzipSync(buf, { level: 9 });
  return {
    asset: asset.name,
    rawBytes: buf.byteLength,
    gzipBytes: gz.byteLength,
  };
});

const totals = report.reduce(
  (acc, item) => ({
    asset: "TOTAL",
    rawBytes: acc.rawBytes + item.rawBytes,
    gzipBytes: acc.gzipBytes + item.gzipBytes,
  }),
  { asset: "TOTAL", rawBytes: 0, gzipBytes: 0 },
);

console.log(JSON.stringify({ shellTransfer: [...report, totals] }, null, 2));
