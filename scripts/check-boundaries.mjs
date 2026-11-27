import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function collectFiles(dir, predicate) {
  const results = [];
  if (!existsSync(dir)) {
    return results;
  }
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const st = statSync(fullPath);
    if (st.isDirectory()) {
      results.push(...collectFiles(fullPath, predicate));
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractImports(source) {
  const specs = [];
  const staticRegex = /\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicRegex = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const regex of [staticRegex, dynamicRegex]) {
    let match;
    while ((match = regex.exec(source)) !== null) {
      if (match[1]) {
        specs.push(match[1]);
      }
    }
  }
  return specs;
}

function assertNoForbiddenImports(dirOrFile, forbiddenList, label) {
  const files = statSync(dirOrFile).isDirectory()
    ? collectFiles(dirOrFile, (f) => f.endsWith(".ts") || f.endsWith(".mts"))
    : [dirOrFile];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const imports = extractImports(source);
    for (const spec of imports) {
      for (const rule of forbiddenList) {
        if (typeof rule === "string" ? spec === rule || spec.startsWith(`${rule}/`) : rule.test(spec)) {
          errors.push(`[${label}] Forbidden import "${spec}" in ${relative(rootDir, file)}`);
        }
      }
    }
  }
}

// 1. packages/domain must have zero runtime external dependencies
const domainPkg = JSON.parse(
  readFileSync(resolve(rootDir, "packages/domain/package.json"), "utf8"),
);
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  const deps = domainPkg[field];
  if (deps && Object.keys(deps).length > 0) {
    errors.push(`[domain] package.json must not declare ${field}: ${JSON.stringify(deps)}`);
  }
}

// 2. packages/domain/src/** may only import relative modules
for (const file of collectFiles(resolve(rootDir, "packages/domain/src"), (f) => f.endsWith(".ts"))) {
  const imports = extractImports(readFileSync(file, "utf8"));
  for (const spec of imports) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) {
      errors.push(`[domain] Non-relative import "${spec}" in ${relative(rootDir, file)}`);
    }
  }
}

// 3. contracts & application must not import node:*, DB drivers, Kysely, Better Auth, or persistence packages
const coreForbidden = [
  /^node:/,
  "pg",
  "better-sqlite3",
  "kysely",
  "better-auth",
  "@prood/integration-better-auth",
  /^@prood\/persistence-/,
];
assertNoForbiddenImports(resolve(rootDir, "packages/contracts/src"), coreForbidden, "contracts");
assertNoForbiddenImports(resolve(rootDir, "packages/application/src"), coreForbidden, "application");

// 4. persistence/common must remain driver- and node-free (Cloudflare D1 portability)
assertNoForbiddenImports(
  resolve(rootDir, "packages/persistence/common/src"),
  [/^node:/, "pg", "better-sqlite3", "better-auth", "@prood/integration-better-auth"],
  "persistence-common",
);

// 5. apps/server/src/app.ts must remain Cloudflare Workers portable
assertNoForbiddenImports(
  resolve(rootDir, "apps/server/src/app.ts"),
  [
    /^node:/,
    "pg",
    "better-sqlite3",
    "kysely",
    "better-auth",
    "@prood/integration-better-auth",
    "@prood/persistence-sqlite",
    "@prood/persistence-postgres",
    "@hono/node-server",
  ],
  "server-app",
);

// 6. apps/web/src/** must not import node:*, DB drivers, Kysely, Better Auth, persistence, or server
assertNoForbiddenImports(
  resolve(rootDir, "apps/web/src"),
  [
    /^node:/,
    "pg",
    "better-sqlite3",
    "kysely",
    "better-auth",
    "@prood/integration-better-auth",
    /^@prood\/persistence-/,
    "@prood/server",
  ],
  "web-src",
);

// 7. Built browser artifacts must not contain server/secret markers
const webDistFiles = collectFiles(resolve(rootDir, "apps/web/dist"), (f) => f.endsWith(".js"));
if (webDistFiles.length === 0) {
  errors.push("[web-dist] No built JS bundles found in apps/web/dist; run pnpm build first");
}
const forbiddenBundleMarkers = [
  "better-sqlite3",
  "better-auth",
  "pg-protocol",
  "kysely",
  "node:fs",
  "node:net",
  "DATABASE_URL",
  "PROOD_DB_URL",
  "PROOD_AUTH_SECRET",
];
for (const file of webDistFiles) {
  const contents = readFileSync(file, "utf8");
  for (const marker of forbiddenBundleMarkers) {
    if (contents.includes(marker)) {
      errors.push(`[web-dist] Forbidden bundle marker "${marker}" found in ${relative(rootDir, file)}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Boundary check failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

console.log("Boundary check passed (domain zero-dep, Cloudflare-portable layers, clean web bundle).");
