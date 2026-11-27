import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const NODE_BUILTIN_SET = new Set(
  builtinModules.flatMap((mod) =>
    mod.startsWith("node:") ? [mod, mod.slice(5)] : [mod, `node:${mod}`],
  ),
);

const SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs", ".cjs"];

function isNodeBuiltin(spec) {
  if (spec.startsWith("node:")) {
    return true;
  }
  const top = spec.split("/")[0];
  return NODE_BUILTIN_SET.has(spec) || (top ? NODE_BUILTIN_SET.has(top) : false);
}

function matchesRule(spec, rule) {
  if (rule === "NODE_BUILTIN") {
    return isNodeBuiltin(spec);
  }
  if (typeof rule === "string") {
    return spec === rule || spec.startsWith(`${rule}/`);
  }
  return rule.test(spec);
}

function collectFiles(dir, predicate) {
  const results = [];
  if (!existsSync(dir)) {
    return results;
  }
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
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

function extractImports(source, filePath) {
  const specs = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const firstArg = node.arguments[0];
      if (
        (expr.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expr) && expr.text === "require")) &&
        firstArg &&
        ts.isStringLiteralLike(firstArg)
      ) {
        specs.push(firstArg.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specs;
}

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

function assertNoForbiddenImports(
  targetPath,
  forbiddenList,
  label,
  excludeRelativePaths = new Set(),
) {
  if (!existsSync(targetPath)) {
    return;
  }
  const files = statSync(targetPath).isDirectory()
    ? collectFiles(targetPath, isSourceFile)
    : [targetPath];

  for (const file of files) {
    const rel = relative(rootDir, file).replace(/\\/g, "/");
    if (excludeRelativePaths.has(rel)) {
      continue;
    }
    const source = readFileSync(file, "utf8");
    const imports = extractImports(source, file);
    for (const spec of imports) {
      for (const rule of forbiddenList) {
        if (matchesRule(spec, rule)) {
          errors.push(`[${label}] Forbidden import "${spec}" in ${rel}`);
        }
      }
    }
  }
}

function assertPackageJsonDepsClean(pkgJsonRel, forbiddenList, label) {
  const pkgPath = resolve(rootDir, pkgJsonRel);
  if (!existsSync(pkgPath)) {
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = pkg[field];
    if (!deps) {
      continue;
    }
    for (const name of Object.keys(deps)) {
      for (const rule of forbiddenList) {
        if (matchesRule(name, rule)) {
          errors.push(
            `[${label}] Forbidden dependency "${name}" in ${pkgJsonRel} (${field})`,
          );
        }
      }
    }
  }
}

// 1. packages/domain must have zero runtime external dependencies
const domainPkg = JSON.parse(
  readFileSync(resolve(rootDir, "packages/domain/package.json"), "utf8"),
);
for (const field of [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
]) {
  const deps = domainPkg[field];
  if (deps && Object.keys(deps).length > 0) {
    errors.push(
      `[domain] package.json must not declare ${field}: ${JSON.stringify(deps)}`,
    );
  }
}

// 2. packages/domain/src/** may only import relative modules
for (const file of collectFiles(
  resolve(rootDir, "packages/domain/src"),
  isSourceFile,
)) {
  const rel = relative(rootDir, file).replace(/\\/g, "/");
  const imports = extractImports(readFileSync(file, "utf8"), file);
  for (const spec of imports) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) {
      errors.push(`[domain] Non-relative import "${spec}" in ${rel}`);
    }
  }
}

// 3. contracts & application must remain pure / Cloudflare-portable
const portableForbiddenBase = [
  "NODE_BUILTIN",
  "pg",
  "better-sqlite3",
  "kysely",
  "better-auth",
  "@better-auth/oauth-provider",
  "fastmcp",
  "@prood/integration-better-auth",
  "@prood/integration-fastmcp",
  /^@prood\/persistence-/,
  "@prood/server",
  "@prood/web",
  "hono",
  "@hono/node-server",
];
assertNoForbiddenImports(
  resolve(rootDir, "packages/contracts/src"),
  [...portableForbiddenBase, "@prood/application"],
  "contracts",
);
assertPackageJsonDepsClean(
  "packages/contracts/package.json",
  [...portableForbiddenBase, "@prood/application"],
  "contracts-pkg",
);

assertNoForbiddenImports(
  resolve(rootDir, "packages/application/src"),
  portableForbiddenBase,
  "application",
);
assertPackageJsonDepsClean(
  "packages/application/package.json",
  portableForbiddenBase,
  "application-pkg",
);

// 4. persistence/common must remain driver- and Node-free (Cloudflare D1 portability)
const persistenceCommonForbidden = [
  "NODE_BUILTIN",
  "pg",
  "better-sqlite3",
  "@prood/persistence-sqlite",
  "@prood/persistence-postgres",
  "better-auth",
  "@better-auth/oauth-provider",
  "fastmcp",
  "@prood/integration-better-auth",
  "@prood/integration-fastmcp",
  "@prood/server",
  "@prood/web",
];
assertNoForbiddenImports(
  resolve(rootDir, "packages/persistence/common/src"),
  persistenceCommonForbidden,
  "persistence-common",
);
assertPackageJsonDepsClean(
  "packages/persistence/common/package.json",
  persistenceCommonForbidden,
  "persistence-common-pkg",
);

// 5. Integrations must not import raw DB drivers directly
assertNoForbiddenImports(
  resolve(rootDir, "packages/integrations"),
  ["pg", "better-sqlite3", "@prood/persistence-sqlite", "@prood/persistence-postgres"],
  "integrations",
);

// 6. apps/server/src/** (excluding explicit Node entrypoint apps/server/src/index.ts) must remain Cloudflare Workers portable
const serverPortableForbidden = [
  "NODE_BUILTIN",
  "pg",
  "better-sqlite3",
  "kysely",
  "better-auth",
  "@better-auth/oauth-provider",
  "fastmcp",
  "@prood/integration-better-auth",
  "@prood/integration-fastmcp",
  /^@prood\/persistence-/,
  /^@prood\/integration-/,
  "@hono/node-server",
  "@prood/web",
];
assertNoForbiddenImports(
  resolve(rootDir, "apps/server/src"),
  serverPortableForbidden,
  "server-portable",
  new Set(["apps/server/src/index.ts"]),
);

// 7. apps/web/src/** must stay strictly browser-safe
const webSrcForbidden = [
  "NODE_BUILTIN",
  "pg",
  "better-sqlite3",
  "kysely",
  "better-auth",
  "@better-auth/oauth-provider",
  "fastmcp",
  "jose",
  "hono",
  "@hono/node-server",
  "@prood/application",
  /^@prood\/integration-/,
  /^@prood\/persistence-/,
  "@prood/server",
];
assertNoForbiddenImports(
  resolve(rootDir, "apps/web/src"),
  webSrcForbidden,
  "web-src",
);
assertPackageJsonDepsClean(
  "apps/web/package.json",
  webSrcForbidden,
  "web-pkg",
);

// 8. Built browser artifacts & esbuild metafile must exist and contain no server/secret dependencies
const shellJsPath = resolve(rootDir, "apps/web/dist/shell.js");
const metafilePath = resolve(rootDir, "apps/web/dist/metafile.json");
const webTypesLeakFiles = existsSync(resolve(rootDir, "apps/web/dist/types"))
  ? collectFiles(resolve(rootDir, "apps/web/dist/types"), (f) => f.endsWith(".js"))
  : [];
if (webTypesLeakFiles.length > 0) {
  errors.push(
    `[web-types] Expected emitDeclarationOnly in apps/web/tsconfig.json, found JS files in apps/web/dist/types`,
  );
}
if (!existsSync(shellJsPath)) {
  errors.push("[web-dist] Missing built bundle apps/web/dist/shell.js; run pnpm build first");
}
if (!existsSync(metafilePath)) {
  errors.push("[web-dist] Missing build metafile apps/web/dist/metafile.json; run pnpm build first");
}

if (existsSync(metafilePath)) {
  const metafile = JSON.parse(readFileSync(metafilePath, "utf8"));
  const forbiddenInputPatterns = [
    /(?:^|\/)node_modules\/(?:pg|better-sqlite3|kysely|better-auth|@better-auth\/oauth-provider|fastmcp|@hono\/node-server|jose)(?:\/|$)/,
    /(?:^|\/)packages\/(?:persistence|integrations|features)\//,
    /(?:^|\/)apps\/server\//,
  ];
  for (const inputPath of Object.keys(metafile.inputs ?? {})) {
    const normalized = inputPath.replace(/\\/g, "/");
    for (const pattern of forbiddenInputPatterns) {
      if (pattern.test(normalized)) {
        errors.push(`[web-metafile] Forbidden bundled module "${normalized}"`);
      }
    }
  }
}

if (existsSync(shellJsPath)) {
  const contents = readFileSync(shellJsPath, "utf8");
  const forbiddenBundleMarkers = [
    "better-sqlite3",
    "better-auth",
    "fastmcp",
    "pg-protocol",
    "kysely",
    "node:fs",
    "node:net",
    "DATABASE_URL",
    "PROOD_DB_URL",
    "PROOD_AUTH_SECRET",
  ];
  for (const marker of forbiddenBundleMarkers) {
    if (contents.includes(marker)) {
      errors.push(
        `[web-dist] Forbidden bundle marker "${marker}" found in apps/web/dist/shell.js`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Boundary check failed:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

console.log(
  "Boundary check passed (AST imports, domain zero-dep, Cloudflare-portable layers, clean web bundle & metafile).",
);
