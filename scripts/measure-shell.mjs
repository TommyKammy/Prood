import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const maxGzipBytes = Number(process.env.PROOD_SHELL_MAX_GZIP_BYTES ?? 16384);
const distDir = resolve(rootDir, "apps/web/dist");
const metafilePath = resolve(distDir, "metafile.json");

if (!existsSync(metafilePath)) {
  console.error(`Missing web metafile: ${metafilePath}. Run pnpm build first.`);
  process.exit(1);
}

const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
const outputs = metafile.outputs ?? {};
const entryKey =
  "dist/shell.js" in outputs
    ? "dist/shell.js"
    : Object.keys(outputs).find((key) =>
        outputs[key]?.entryPoint?.endsWith("src/index.ts"),
      );

if (!entryKey) {
  console.error("Missing shell entry output in apps/web/dist/metafile.json.");
  process.exit(1);
}

const visited = new Set([entryKey]);
const queue = [entryKey];
while (queue.length > 0) {
  const cur = queue.shift();
  for (const imp of outputs[cur]?.imports ?? []) {
    if (imp.kind !== "dynamic-import" && imp.path && !visited.has(imp.path)) {
      visited.add(imp.path);
      queue.push(imp.path);
    }
  }
}

const eagerJsAssets = [
  entryKey,
  ...Array.from(visited)
    .filter((key) => key !== entryKey)
    .sort(),
];

const assets = [
  { name: "index.html", path: resolve(distDir, "index.html") },
  ...eagerJsAssets.map((metaKey) => ({
    name: metaKey.replace(/^dist\//, ""),
    path: resolve(rootDir, "apps/web", metaKey),
  })),
  { name: "shell.css", path: resolve(distDir, "shell.css") },
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
