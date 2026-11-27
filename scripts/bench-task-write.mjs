// Run against a built checkout. DATABASE_URL selects isolated PostgreSQL schemas.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] ?? ".");
const load = (file) => import(pathToFileURL(join(root, file)));
const { createSystemIdGenerator, createWorkUseCases } = await load(
  "packages/application/dist/index.js",
);
const { selectDatabaseClient } = await load("apps/server/dist/index.js");
const pg = await load("packages/persistence/postgres/dist/index.js");
const url = process.env.DATABASE_URL;
const dir = mkdtempSync(join(tmpdir(), "prood-write-bench-"));
const schema = "bench_" + randomUUID().replaceAll("-", "");
if (url) await pg.createPostgresSchema(url, schema);
const db = url
  ? pg.createPostgresDatabase({ connectionString: url, schema })
  : selectDatabaseClient({ PROOD_SQLITE_PATH: join(dir, "bench.sqlite") });
function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
try {
  await db.migrate();
  const ids = createSystemIdGenerator();
  const user = ids.next("usr"),
    workspace = ids.next("wks"),
    createdAt = new Date().toISOString();
  const actor = { actorType: "user", userId: user, channel: "web" };
  const work = createWorkUseCases({
    uow: db.uow,
    idGenerator: ids,
    clock: { now: () => new Date() },
  });
  await db.uow.run(async (repos) => {
    await repos.users.create({
      id: user,
      email: "bench@example.test",
      displayName: "Bench",
      createdAt,
    });
    await repos.workspaces.create({ id: workspace, name: "Bench", slug: "bench", createdAt });
    await repos.memberships.create({
      id: ids.next("mbr"),
      workspaceId: workspace,
      userId: user,
      role: "admin",
      createdAt,
    });
  });
  const { project } = value(
    await work.createProject(actor, workspace, {
      name: "Bench",
      kind: "general",
      visibility: "private",
    }),
  );
  const { task } = value(await work.createTask(actor, project.id, { title: "Bench" }));
  for (const subscribers of work.manageAutomation ? [0, 1] : [0]) {
    if (subscribers)
      value(
        await work.manageAutomation(actor, project.id, "state", {
          op: "publish",
          revision: 0,
          delegate: user,
          definition: {
            when: "status.changed",
            action: { field: "assigneeId", value: user },
          },
        }),
      );
    const samples = [];
    for (let i = 0; i < 220; i++) {
      const start = performance.now();
      value(
        await work.updateTask(actor, task.id, { statusId: project.statuses[(i + 1) % 2].id }),
      );
      if (i >= 20) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        backend: url ? "postgres" : "sqlite",
        subscribers,
        samples: samples.length,
        p95Ms: samples[189],
      }),
    );
  }
} finally {
  await db.close();
  if (url) await pg.dropPostgresSchema(url, schema);
  rmSync(dir, { recursive: true, force: true });
}
