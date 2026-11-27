import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxGzipBytes = Number(process.env.PROOD_SHELL_MAX_GZIP_BYTES ?? 16384);

const assets = [
  { name: "index.html", path: resolve(rootDir, "apps/web/dist/index.html") },
  { name: "shell.js", path: resolve(rootDir, "apps/web/dist/shell.js") },
  { name: "shell.css", path: resolve(rootDir, "apps/web/dist/shell.css") },
];

for (const asset of assets) {
  if (!existsSync(asset.path)) {
    console.error(`Missing web asset: ${asset.path}. Run pnpm build first.`);
    process.exit(1);
  }
}

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

console.log(
  JSON.stringify(
    {
      maxGzipBytes,
      shellTransfer: [...report, totals],
    },
    null,
    2,
  ),
);

if (Number.isFinite(maxGzipBytes) && totals.gzipBytes > maxGzipBytes) {
  console.error(
    `Shell transfer budget exceeded: ${totals.gzipBytes} gzip bytes > ${maxGzipBytes} max bytes`,
  );
  process.exit(1);
}
