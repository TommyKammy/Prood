import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSystemIdGenerator,
  createWorkUseCases,
} from "@prood/application";
import type {
  ApiErrorResponse,
  DbDriverKind,
  MeResponse,
  ProjectDevSettingsResponse,
  ProjectListResponse,
  ProjectResponse,
  TaskResponse,
  TaskSearchResponse,
} from "@prood/contracts";
import { createBetterAuthAdapter } from "@prood/integration-better-auth";
import type { KyselyBackedDatabaseClient } from "@prood/persistence-common";
import {
  createPostgresDatabase,
  createPostgresSchema,
  dropPostgresSchema,
} from "@prood/persistence-postgres";
import { createSqliteDatabase } from "@prood/persistence-sqlite";
import { createApp } from "@prood/server/app";
import type {
  ProodShellElement as ProodShellElementType,
  PartialMessageCatalog,
} from "@prood/web";

const targetDb = process.env.PROOD_TEST_DB as DbDriverKind | undefined;
if (targetDb !== "sqlite" && targetDb !== "postgres") {
  throw new Error(
    `PROOD_TEST_DB must be "sqlite" or "postgres" (received: ${String(targetDb)})`,
  );
}

const BASE_URL = "http://127.0.0.1:3000";
const AUTH_SECRET = "prood-web-list-dev-settings-secret-32-chars!";

class CookieJar {
  private cookies = new Map<string, string>();

  updateFrom(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const firstPart = header.split(";")[0];
      if (!firstPart) continue;
      const eqIdx = firstPart.indexOf("=");
      if (eqIdx <= 0) continue;
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

interface IsolatedDb {
  openClient(): KyselyBackedDatabaseClient;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function createIsolatedDb(): Promise<IsolatedDb> {
  const opened: KyselyBackedDatabaseClient[] = [];

  if (targetDb === "sqlite") {
    const dir = mkdtempSync(join(tmpdir(), "prood-web-sqlite-"));
    const filePath = join(dir, "web.sqlite");
    const ctx: IsolatedDb = {
      openClient() {
        const client = createSqliteDatabase({ filePath });
        opened.push(client);
        return client;
      },
      async cleanup() {
        for (const client of opened.splice(0)) {
          await client.close();
        }
        rmSync(dir, { recursive: true, force: true });
      },
    };
    cleanups.push(() => ctx.cleanup());
    return ctx;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be set when PROOD_TEST_DB=postgres");
  }

  const schema = `prood_web_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await createPostgresSchema(connectionString, schema);

  const ctx: IsolatedDb = {
    openClient() {
      const client = createPostgresDatabase({ connectionString, schema });
      opened.push(client);
      return client;
    },
    async cleanup() {
      for (const client of opened.splice(0)) {
        await client.close();
      }
      await dropPostgresSchema(connectionString, schema);
    },
  };
  cleanups.push(() => ctx.cleanup());
  return ctx;
}

async function flushUi(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  debugInfo?: () => string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  const extra = debugInfo ? `\nDebug: ${debugInfo()}` : "";
  throw new Error(`Timed out waiting for: ${label}${extra}`);
}

function createServerHarness(db: KyselyBackedDatabaseClient) {
  let tick = Date.parse("2026-11-28T12:15:00.000Z");
  const clock = {
    now: () => {
      tick += 1000;
      return new Date(tick);
    },
  };
  const idGenerator = createSystemIdGenerator();
  const auth = createBetterAuthAdapter({
    db,
    secret: AUTH_SECRET,
    baseURL: BASE_URL,
    trustedOrigins: [BASE_URL],
    mcpResource: `${BASE_URL}/mcp`,
  });
  const app = createApp({
    clock,
    dbHealth: db,
    auth,
    uow: db.uow,
    idGenerator,
    mcpAuth: auth,
  });
  const workUseCases = createWorkUseCases({
    uow: db.uow,
    idGenerator,
    clock,
  });

  async function apiRequest(
    path: string,
    init: { method?: string; json?: unknown; jar?: CookieJar } = {},
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("origin", BASE_URL);
    if (init.jar) {
      const cookieHeader = init.jar.toHeader();
      if (cookieHeader) headers.set("cookie", cookieHeader);
    }
    let body: string | undefined;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await app.request(
      new Request(`${BASE_URL}${path}`, {
        method: init.method ?? "GET",
        headers,
        body,
      }),
    );
    init.jar?.updateFrom(res);
    return res;
  }

  async function signUpUser(email: string, name: string) {
    const jar = new CookieJar();
    const res = await apiRequest("/api/auth/sign-up/email", {
      method: "POST",
      jar,
      json: { email, password: "prood-test-password-123", name },
    });
    expect(res.status).toBe(200);
    const meRes = await apiRequest("/api/v1/me", { jar });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeResponse;
    return { jar, userId: me.user.id, email: me.user.email };
  }

  async function setupBrowserSession(jar: CookieJar) {
    vi.resetModules();
    const win = new Window({ url: `${BASE_URL}/` });
    const copiedTexts: string[] = [];
    const doc = win.document as unknown as Document;

    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("HTMLElement", win.HTMLElement);
    vi.stubGlobal("HTMLInputElement", win.HTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
    vi.stubGlobal("HTMLSelectElement", win.HTMLSelectElement);
    vi.stubGlobal("HTMLDialogElement", win.HTMLDialogElement);
    vi.stubGlobal("Element", win.Element);
    vi.stubGlobal("Node", win.Node);
    vi.stubGlobal("Event", win.Event);
    vi.stubGlobal("KeyboardEvent", win.KeyboardEvent);
    vi.stubGlobal("CustomEvent", win.CustomEvent);
    vi.stubGlobal("customElements", win.customElements);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async (text: string) => {
          copiedTexts.push(text);
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const rawUrl = typeof input === "string" ? input : input.toString();
        const url = new URL(rawUrl, BASE_URL);
        const headers = new Headers(init?.headers);
        headers.set("origin", BASE_URL);
        const cookieHeader = jar.toHeader();
        if (cookieHeader) headers.set("cookie", cookieHeader);
        const res = await app.request(
          new Request(url.toString(), {
            method: init?.method ?? "GET",
            headers,
            body: init?.body ?? undefined,
          }),
        );
        jar.updateFrom(res);
        return res;
      },
    );

    const web = await import("@prood/web");
    web.registerProodLoginForm();
    web.registerProodShell();

    let shell = doc.createElement("prood-shell") as unknown as ProodShellElementType;
    doc.body.appendChild(shell as unknown as Node);

    async function reloadShell(): Promise<ProodShellElementType> {
      const currentHref = win.location.href;
      shell.remove();
      win.happyDOM.setURL(currentHref);
      const next = doc.createElement("prood-shell") as unknown as ProodShellElementType;
      doc.body.appendChild(next as unknown as Node);
      await flushUi(12);
      shell = next;
      return next;
    }

    return {
      win,
      doc,
      web,
      copiedTexts,
      getShell: () => shell,
      reloadShell,
    };
  }

  return { app, apiRequest, signUpUser, setupBrowserSession, workUseCases };
}

describe(`PR 09: Web List, Dev Settings & ⌘K Search (${targetDb})`, () => {
  it("supports General/Dev project creation, reload persistence, key/ID copy, Japanese dictionary swap, permissions & ⌘K search", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksId = ids.next("wks");
    const now = "2026-11-28T12:15:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "web-ui-ws",
        name: "Web UI Workspace",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: false,
        updatedAt: now,
      });
    });

    const admin = await harness.signUpUser("web-admin@example.com", "Admin");
    const member = await harness.signUpUser("web-member@example.com", "Member");
    const viewer = await harness.signUpUser("web-viewer@example.com", "Viewer");

    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: member.userId,
        role: "member",
        createdAt: now,
      });
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: viewer.userId,
        role: "viewer",
        createdAt: now,
      });
    });

    // Private project with secret matching keyword so search isolation can be verified later
    const privRes = await harness.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      jar: admin.jar,
      json: { name: "Secret Vault", visibility: "private" },
    });
    expect(privRes.status).toBe(201);
    const privProjId = ((await privRes.json()) as ProjectResponse).project.id;
    const privTaskRes = await harness.apiRequest(`/api/v1/projects/${privProjId}/tasks`, {
      method: "POST",
      jar: admin.jar,
      json: { title: "認証フロー秘密タスク" },
    });
    expect(privTaskRes.status).toBe(201);

    // 1. Admin signs in via <prood-login-form> using an empty CookieJar
    const adminSessionJar = new CookieJar();
    const browser = await harness.setupBrowserSession(adminSessionJar);

    await waitFor(
      () => browser.doc.querySelector("[data-login-form]") !== null,
      "login form visible",
    );

    const emailInput = browser.doc.querySelector<HTMLInputElement>('input[name="email"]')!;
    const passInput = browser.doc.querySelector<HTMLInputElement>('input[name="password"]')!;
    emailInput.value = admin.email;
    passInput.value = "prood-test-password-123";
    browser.doc
      .querySelector<HTMLFormElement>("[data-login-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () => browser.doc.querySelector('[data-nav-view="settings"]') !== null,
      "authenticated workspace nav",
    );

    // 2. Open Settings view & enable devProjectsEnabled for workspace
    browser.doc
      .querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!
      .click();
    await waitFor(
      () => browser.doc.querySelector("[data-ws-dev-toggle]") !== null,
      "workspace settings chunk loaded",
    );

    const wsToggle = browser.doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!;
    expect(wsToggle.checked).toBe(false);
    expect(wsToggle.disabled).toBe(false);
    wsToggle.checked = true;
    browser.doc
      .querySelector<HTMLFormElement>("[data-workspace-settings-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc
          .querySelector(".prood-status-banner")
          ?.textContent?.includes("Settings saved") ?? false,
      "workspace settings saved",
    );

    // Reload browser shell and confirm URL view=settings + enabled workspace setting persist
    expect(browser.win.location.search).toContain("view=settings");
    await browser.reloadShell();
    await waitFor(
      () => browser.doc.querySelector("[data-ws-dev-toggle]") !== null,
      "settings view restored after reload",
    );
    expect(
      browser.doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!.checked,
    ).toBe(true);

    // 3. Create General project & create a task in List UI (verify no keys rendered/copied, only tsk_*)
    browser.doc.querySelector<HTMLButtonElement>("[data-toggle-new-project]")!.click();
    const newProjName = browser.doc.querySelector<HTMLInputElement>("[data-new-project-name]")!;
    newProjName.value = "General Board";
    newProjName.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-new-project-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc
          .querySelector<HTMLHeadingElement>(".prood-view-title")
          ?.textContent?.trim() === "General Board",
      "General Board selected",
    );
    expect(
      browser.doc.querySelector("[data-project-kind]")?.getAttribute("data-project-kind"),
    ).toBe("general");

    const genTitleInput = browser.doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    genTitleInput.value = "General task alpha";
    genTitleInput.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-create-task-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc
          .querySelector("[data-task-row] th")
          ?.textContent?.trim() === "General task alpha",
      "general task row rendered",
    );
    expect(browser.doc.querySelector("[data-task-key]")).toBeNull();
    expect(browser.doc.querySelector('[data-copy-kind="key"]')).toBeNull();

    const generalIdEl = browser.doc.querySelector<HTMLElement>("[data-task-public-id]")!;
    const generalTaskId = generalIdEl.textContent!.trim();
    expect(generalTaskId.startsWith("tsk_")).toBe(true);

    // Copy general task ID via button click (fallback click path when CommandEvent not in happy-dom)
    browser.doc.querySelector<HTMLButtonElement>('[data-copy-kind="id"]')!.click();
    await flushUi(3);
    expect(browser.copiedTexts).toContain(generalTaskId);

    // Reload and verify General Board & General task alpha persist
    const genProjectId = browser.getShell().getActiveProjectId()!;
    await browser.reloadShell();
    await waitFor(
      () => browser.doc.querySelector(`[data-task-row="${generalTaskId}"]`) !== null,
      "general task persists after reload",
      () =>
        `expected=${JSON.stringify(generalTaskId)} rows=${Array.from(browser.doc.querySelectorAll("[data-task-row]")).map((el) => el.getAttribute("data-task-row")).join(",")} url=${browser.win.location.href}`,
    );

    // 4. Create Development project (prefix: PRD) from sidebar & create task in List UI
    browser.doc.querySelector<HTMLButtonElement>("[data-toggle-new-project]")!.click();
    const devProjName = browser.doc.querySelector<HTMLInputElement>("[data-new-project-name]")!;
    devProjName.value = "Core Platform";
    devProjName.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    const devCheck = browser.doc.querySelector<HTMLInputElement>("[data-new-project-dev-toggle]")!;
    devCheck.checked = true;
    devCheck.dispatchEvent(new browser.win.Event("change") as unknown as Event);
    const devPrefix = browser.doc.querySelector<HTMLInputElement>("[data-new-project-prefix]")!;
    devPrefix.value = "PRD";
    devPrefix.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-new-project-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc
          .querySelector<HTMLHeadingElement>(".prood-view-title")
          ?.textContent?.trim() === "Core Platform",
      "Core Platform selected",
    );
    expect(
      browser.doc.querySelector("[data-project-kind]")?.getAttribute("data-project-kind"),
    ).toBe("development");
    expect(
      browser.doc.querySelector("[data-project-prefix]")?.textContent?.trim(),
    ).toBe("PRD");

    const devTitleInput = browser.doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    devTitleInput.value = "認証フローのUI連携確認";
    devTitleInput.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-create-task-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () => browser.doc.querySelector('[data-task-key="PRD-1"]') !== null,
      "PRD-1 task rendered",
    );
    const devTaskId = browser.doc
      .querySelector<HTMLElement>("[data-task-public-id]")!
      .textContent!.trim();
    const devProjectId = browser.getShell().getActiveProjectId()!;

    // Copy both key and ID in development project
    browser.doc.querySelector<HTMLButtonElement>('[data-copy-kind="key"]')!.click();
    browser.doc.querySelector<HTMLButtonElement>('[data-copy-kind="id"]')!.click();
    await flushUi(3);
    expect(browser.copiedTexts).toContain("PRD-1");
    expect(browser.copiedTexts).toContain(devTaskId);

    // 5. Swap to Japanese test dictionary: UI labels translate cleanly while immutable tsk_* ID stays identical & copy works
    const jaCatalog: PartialMessageCatalog = {
      "action.createTask": "タスクを作成",
      "action.copyId": "IDをコピー",
      "action.copyKey": "キーをコピー",
      "task.created": "タスクを作成しました。",
      "task.count.other": "{count}件のタスク",
      "project.kind.development": "開発プロジェクト",
    };
    browser
      .getShell()
      .setI18n(browser.web.createI18n({ locale: "ja", catalogs: { ja: jaCatalog } }));
    await flushUi(2);
    expect(
      browser.doc.querySelector("[data-create-task-submit]")?.textContent?.trim(),
    ).toBe("タスクを作成");
    expect(
      browser.doc.querySelector<HTMLElement>("[data-task-public-id]")?.textContent?.trim(),
    ).toBe(devTaskId);
    browser.copiedTexts.length = 0;
    browser.doc.querySelector<HTMLButtonElement>('[data-copy-kind="id"]')!.click();
    await flushUi(2);
    expect(browser.copiedTexts).toEqual([devTaskId]);

    // Switch back to English default & test prefix rename PRD -> APP in Project Dev Settings
    browser.getShell().setI18n(browser.web.createI18n());
    browser.doc.querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!.click();
    await waitFor(
      () => browser.doc.querySelector("[data-proj-prefix-input]") !== null,
      "project dev settings loaded",
    );
    const renameInput = browser.doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")!;
    renameInput.value = "APP";
    renameInput.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-project-dev-settings-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc
          .querySelector<HTMLElement>("[data-old-prefixes]")
          ?.textContent?.includes("PRD") ?? false,
      "prefix renamed to APP and old prefix PRD recorded",
    );
    expect(
      browser.doc.querySelector("[data-branch-prefix]")?.getAttribute("data-branch-prefix"),
    ).toBe("prd");

    // 6. Press Cmd+K to open search dialog: search old key PRD-1, exact ID, and Japanese query
    browser.win.dispatchEvent(
      new browser.win.KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        cancelable: true,
      }),
    );
    await waitFor(
      () => browser.doc.querySelector("[data-search-input]") !== null,
      "search dialog chunk opened on Cmd+K",
    );

    const searchInput = browser.doc.querySelector<HTMLInputElement>("[data-search-input]")!;
    searchInput.value = "PRD-1";
    searchInput.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    await waitFor(
      () =>
        browser.doc.querySelector(`[data-search-result-id="${devTaskId}"]`) !== null,
      "PRD-1 resolves to APP-1 task in search dialog",
    );
    const firstResult = browser.doc.querySelector(`[data-search-result-id="${devTaskId}"]`)!;
    expect(firstResult.getAttribute("data-match-kind")).toBe("exact_key");

    // Select item via Enter -> jumps to List view of Core Platform with APP-1 displayed
    searchInput.dispatchEvent(
      new browser.win.KeyboardEvent("keydown", {
        key: "Enter",
        cancelable: true,
      }) as unknown as Event,
    );
    await waitFor(
      () =>
        browser.getShell().getActiveView() === "list" &&
        browser.doc.querySelector('[data-task-key="APP-1"]') !== null,
      "navigated from search to List showing APP-1",
    );

    // 7. Non-admin member & viewer checks (both UI disabled controls and API 403)
    const memberBrowser = await harness.setupBrowserSession(member.jar);
    await waitFor(
      () => memberBrowser.doc.querySelector('[data-nav-view="settings"]') !== null,
      "member shell loaded",
    );
    memberBrowser.doc
      .querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!
      .click();
    await waitFor(
      () =>
        memberBrowser.doc.querySelector("[data-ws-dev-toggle]") !== null &&
        memberBrowser.doc.querySelector("[data-proj-prefix-input]") !== null,
      "member settings loaded",
    );
    expect(
      memberBrowser.doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!.disabled,
    ).toBe(true);
    expect(
      memberBrowser.doc.querySelector<HTMLButtonElement>("[data-ws-dev-save]")!.disabled,
    ).toBe(true);
    expect(
      memberBrowser.doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")!.disabled,
    ).toBe(true);

    // Verify member search NEVER leaks the private project task matching "認証フロー"
    memberBrowser.win.dispatchEvent(
      new memberBrowser.win.KeyboardEvent("keydown", {
        key: "k",
        ctrlKey: true,
        cancelable: true,
      }),
    );
    await waitFor(
      () => memberBrowser.doc.querySelector("[data-search-input]") !== null,
      "member search opened",
    );
    const memberSearchInput =
      memberBrowser.doc.querySelector<HTMLInputElement>("[data-search-input]")!;
    memberSearchInput.value = "認証フロー";
    memberSearchInput.dispatchEvent(
      new memberBrowser.win.Event("input") as unknown as Event,
    );
    await waitFor(
      () =>
        memberBrowser.doc.querySelector(`[data-search-result-id="${devTaskId}"]`) !== null,
      "member sees public dev task match",
    );
    const memberResults = Array.from(
      memberBrowser.doc.querySelectorAll("[data-search-result-id]"),
    ).map((el) => el.getAttribute("data-search-result-id"));
    expect(memberResults).toEqual([devTaskId]);

    // API 403 checks for member & viewer
    expect(
      (
        await harness.apiRequest(`/api/v1/workspaces/${wksId}/settings`, {
          method: "PATCH",
          jar: member.jar,
          json: { devProjectsEnabled: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.apiRequest(`/api/v1/projects/${genProjectId}/dev-settings/enable`, {
          method: "POST",
          jar: member.jar,
          json: { prefix: "GEN" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.apiRequest(`/api/v1/projects/${devProjectId}/tasks`, {
          method: "POST",
          jar: viewer.jar,
          json: { title: "Viewer blocked" },
        })
      ).status,
    ).toBe(403);

    // Viewer UI check: read-only notice rendered instead of create form
    const viewerBrowser = await harness.setupBrowserSession(viewer.jar);
    await waitFor(
      () => viewerBrowser.doc.querySelector("[data-readonly-notice]") !== null,
      "viewer sees read-only list notice",
    );
    expect(viewerBrowser.doc.querySelector("[data-create-task-form]")).toBeNull();

    // 8. Admin disables devProjectsEnabled -> existing APP-1 key remains usable while dev settings edit is blocked
    const disableRes = await harness.apiRequest(`/api/v1/workspaces/${wksId}/settings`, {
      method: "PATCH",
      jar: admin.jar,
      json: { devProjectsEnabled: false },
    });
    expect(disableRes.status).toBe(200);

    const blockedEdit = await harness.apiRequest(
      `/api/v1/projects/${devProjectId}/dev-settings`,
      {
        method: "PATCH",
        jar: admin.jar,
        json: { prefix: "NEWP" },
      },
    );
    expect(blockedEdit.status).toBe(403);
    expect(((await blockedEdit.json()) as ApiErrorResponse).error.messageKey).toBe(
      "error.devProjectsDisabled",
    );

    const searchStillWorks = await harness.apiRequest(
      `/api/v1/workspaces/${wksId}/tasks/search?q=APP-1`,
      { jar: member.jar },
    );
    expect(searchStillWorks.status).toBe(200);
    const body = (await searchStillWorks.json()) as TaskSearchResponse;
    expect(body.items[0]?.task.id).toBe(devTaskId);
    expect(body.items[0]?.task.issueKey).toBe("APP-1");

    // Verify General Board task still has null issueKey via API as well
    const genTaskGet = await harness.apiRequest(`/api/v1/tasks/${generalTaskId}`, {
      jar: admin.jar,
    });
    expect(genTaskGet.status).toBe(200);
    expect(((await genTaskGet.json()) as TaskResponse).task.issueKey).toBeNull();
  }, 25_000);

  it("reuses created project when dev activation fails and persists explicit null startStatusId on enable", async () => {
    const isolated = await createIsolatedDb();
    const db = isolated.openClient();
    await db.migrate();
    const ids = createSystemIdGenerator();
    const harness = createServerHarness(db);

    const wksId = ids.next("wks");
    const now = "2026-11-28T12:15:00.000Z";
    await db.uow.run(async (repos) => {
      await repos.workspaces.create({
        id: wksId,
        slug: "retry-null-ws",
        name: "Retry & Null Workspace",
        createdAt: now,
      });
      await repos.workspaceSettings.upsert({
        workspaceId: wksId,
        defaultLocale: "en",
        devProjectsEnabled: true,
        updatedAt: now,
      });
    });

    const admin = await harness.signUpUser("retry-admin@example.com", "Admin");
    await db.uow.run(async (repos) => {
      await repos.memberships.create({
        id: ids.next("mbr"),
        workspaceId: wksId,
        userId: admin.userId,
        role: "admin",
        createdAt: now,
      });
    });

    // Seed an existing dev project reserving prefix DUP
    const seedRes = await harness.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      jar: admin.jar,
      json: { name: "Seed Dev", visibility: "workspace" },
    });
    expect(seedRes.status).toBe(201);
    const seedProjId = ((await seedRes.json()) as ProjectResponse).project.id;
    const enableSeedRes = await harness.apiRequest(
      `/api/v1/projects/${seedProjId}/dev-settings/enable`,
      { method: "POST", jar: admin.jar, json: { prefix: "DUP" } },
    );
    expect(enableSeedRes.status).toBe(200);

    // 1. Finding 4725269046: duplicate prefix failure retains project and reuses it on retry
    const browser = await harness.setupBrowserSession(admin.jar);
    await waitFor(
      () =>
        browser.doc.querySelector("[data-toggle-new-project]") !== null &&
        browser.doc.querySelector(`[data-project-id="${seedProjId}"]`) !== null,
      "authenticated workspace and settings ready",
    );

    browser.doc.querySelector<HTMLButtonElement>("[data-toggle-new-project]")!.click();
    await waitFor(
      () => browser.doc.querySelector("[data-new-project-dev-toggle]") !== null,
      "new project dev toggle rendered",
    );
    const nameInput = browser.doc.querySelector<HTMLInputElement>("[data-new-project-name]")!;
    nameInput.value = "Retry Target";
    nameInput.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    const devCheck = browser.doc.querySelector<HTMLInputElement>("[data-new-project-dev-toggle]")!;
    devCheck.checked = true;
    devCheck.dispatchEvent(new browser.win.Event("change") as unknown as Event);
    const prefixInput = browser.doc.querySelector<HTMLInputElement>("[data-new-project-prefix]")!;
    prefixInput.value = "DUP";
    prefixInput.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-new-project-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc
          .querySelector('.prood-sidebar-form [role="alert"]')
          ?.textContent?.includes("already reserved") ?? false,
      "duplicate prefix error displayed",
    );
    expect(
      browser.doc.querySelector<HTMLInputElement>("[data-new-project-name]")!.disabled,
    ).toBe(true);

    // Fix prefix and re-submit: must reuse the created project without creating a duplicate
    const retryPrefix = browser.doc.querySelector<HTMLInputElement>("[data-new-project-prefix]")!;
    retryPrefix.value = "RETRY";
    retryPrefix.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    browser.doc
      .querySelector<HTMLFormElement>("[data-new-project-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () =>
        browser.doc.querySelector("[data-new-project-form]") === null &&
        browser.doc.querySelector("[data-project-prefix]")?.textContent?.trim() === "RETRY",
      "retry succeeded with RETRY prefix",
    );

    const listRes = await harness.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
      jar: admin.jar,
    });
    expect(listRes.status).toBe(200);
    const allProjects = ((await listRes.json()) as ProjectListResponse).projects;
    expect(allProjects.filter((p) => p.name === "Retry Target")).toHaveLength(1);

    // 2. Finding 4725269042: enabling dev mode via Settings with "Default (keep current status)" sends explicit null
    const genRes = await harness.apiRequest(`/api/v1/workspaces/${wksId}/projects`, {
      method: "POST",
      jar: admin.jar,
      json: { name: "Keep Status Board", visibility: "workspace" },
    });
    expect(genRes.status).toBe(201);
    const keepProjId = ((await genRes.json()) as ProjectResponse).project.id;

    browser.doc.querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!.click();
    await waitFor(
      () => browser.doc.querySelector(`[data-project-id="${keepProjId}"]`) !== null,
      "Keep Status Board listed in sidebar",
    );
    browser.doc.querySelector<HTMLButtonElement>(`[data-project-id="${keepProjId}"]`)!.click();

    await waitFor(
      () =>
        browser.getShell().getActiveProjectId() === keepProjId &&
        browser.doc.querySelector("[data-proj-dev-enable]") !== null,
      "Keep Status Board dev settings ready to enable",
    );

    const settingsPrefix = browser.doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")!;
    settingsPrefix.value = "KEEP";
    settingsPrefix.dispatchEvent(new browser.win.Event("input") as unknown as Event);
    const startSelect = browser.doc.querySelector<HTMLSelectElement>(
      "[data-proj-start-status-select]",
    )!;
    expect(startSelect.value).toBe("");
    browser.doc
      .querySelector<HTMLFormElement>("[data-project-dev-settings-form]")!
      .dispatchEvent(new browser.win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitFor(
      () => browser.doc.querySelector("[data-proj-dev-save]") !== null,
      "Keep Status Board enabled as dev project",
    );

    const devGet = await harness.apiRequest(`/api/v1/projects/${keepProjId}/dev-settings`, {
      jar: admin.jar,
    });
    expect(devGet.status).toBe(200);
    const devData = (await devGet.json()) as ProjectDevSettingsResponse;
    expect(devData.dev?.prefix).toBe("KEEP");
    expect(devData.dev?.startStatusId).toBeNull();
  }, 20_000);
});
