import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import {
  CONTRACT_VERSION,
  type MeResponse,
  type ProjectDevSettingsResponse,
  type ProjectDto,
  type TaskDto,
  type WorkspaceSettingsDto,
} from "@prood/contracts";
import { generateEntityId, type ProjectId, type StatusId, type WorkspaceId } from "@prood/domain";
import {
  copyFromTarget,
  createCopyControl,
  createI18n,
  ensureCopyCommandListener,
  extractSignedOAuthQuery,
  isSafeRedirectUrl,
  ProodLoginFormElement,
  ProodShellElement,
  translateApiError,
} from "@prood/web";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sampleProfile(): MeResponse {
  return {
    contractVersion: CONTRACT_VERSION,
    user: {
      id: generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1)),
      email: "alice@example.com",
      displayName: "Alice",
    },
    memberships: [],
  };
}

describe("@prood/web ProodShellElement signOut", () => {
  it("retains authenticated state and surfaces an error when sign-out returns 500 or rejects, then transitions on retry success", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // 1. refreshSession -> 200
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sampleProfile()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      // 2. signOut -> 500
      .mockResolvedValueOnce(new Response("Server error", { status: 500 }))
      // 3. signOut -> network error
      .mockRejectedValueOnce(new Error("Network down"))
      // 4. signOut -> 200
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const shell = new ProodShellElement();
    await shell.refreshSession();
    expect(shell.getAuthState()).toBe("authenticated");
    expect(shell.getSignOutError()).toBe("");

    const firstAttempt = await shell.signOut();
    expect(firstAttempt).toBe(false);
    expect(shell.getAuthState()).toBe("authenticated");
    expect(shell.getSignOutError()).toBe("Unable to sign out. Please try again.");

    const secondAttempt = await shell.signOut();
    expect(secondAttempt).toBe(false);
    expect(shell.getAuthState()).toBe("authenticated");
    expect(shell.getSignOutError()).toBe("Unable to sign out. Please try again.");

    const thirdAttempt = await shell.signOut();
    expect(thirdAttempt).toBe(true);
    expect(shell.getAuthState()).toBe("unauthenticated");
    expect(shell.getSignOutError()).toBe("");
  });

  it("transitions to unauthenticated when sign-out returns 401 (already revoked)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sampleProfile()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    vi.stubGlobal("fetch", fetchMock);

    const shell = new ProodShellElement();
    await shell.refreshSession();
    expect(shell.getAuthState()).toBe("authenticated");

    const signedOut = await shell.signOut();
    expect(signedOut).toBe(true);
    expect(shell.getAuthState()).toBe("unauthenticated");
    expect(shell.getSignOutError()).toBe("");
  });
});

describe("@prood/web login & asset paths", () => {
  it("extracts signed OAuth query only when sig and client_id are present", () => {
    expect(extractSignedOAuthQuery("")).toBeUndefined();
    expect(extractSignedOAuthQuery("?tab=list")).toBeUndefined();
    expect(
      extractSignedOAuthQuery("?client_id=c1&scope=openid&sig=abc123&exp=999"),
    ).toBe("client_id=c1&scope=openid&sig=abc123&exp=999");
  });

  it("forwards oauth_query on sign-in and follows Better Auth OAuth redirect", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            redirect: true,
            url: "/oauth/consent?client_id=c1&sig=next",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const redirects: string[] = [];
    const form = new ProodLoginFormElement();
    form.setCredentials("alice@example.com", "secret-pass");
    form.setOAuthContext({
      search: "?client_id=c1&sig=abc123",
      onRedirect: (url) => redirects.push(url),
    });
    await form.submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody).toEqual({
      email: "alice@example.com",
      password: "secret-pass",
      oauth_query: "client_id=c1&sig=abc123",
    });
    expect(redirects).toEqual(["/oauth/consent?client_id=c1&sig=next"]);

    // Ordinary sign-in without OAuth query omits oauth_query
    const normalForm = new ProodLoginFormElement();
    normalForm.setCredentials("alice@example.com", "secret-pass");
    normalForm.setOAuthContext({ search: "", onRedirect: (u) => redirects.push(u) });
    await normalForm.submit();

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody).toEqual({
      email: "alice@example.com",
      password: "secret-pass",
    });
    expect(redirects).toHaveLength(1);
  });

  it("uses root-relative shell asset URLs so /oauth/consent loads shell assets", () => {
    const html = readFileSync(
      resolve(process.cwd(), "apps/web/public/index.html"),
      "utf8",
    );
    expect(html).toContain('href="/shell.css"');
    expect(html).toContain('src="/shell.js"');
  });

  it("validates redirect URLs safely and distinguishes expired oauth_query / 500 / 401 on login", async () => {
    expect(isSafeRedirectUrl("/oauth/consent?client_id=c1")).toBe(true);
    expect(isSafeRedirectUrl("https://prood.example/cb")).toBe(true);
    expect(isSafeRedirectUrl("//evil.example/phish")).toBe(false);
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,hi")).toBe(false);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_signature" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "INVALID_EMAIL_OR_PASSWORD" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const form = new ProodLoginFormElement();
    form.setCredentials("alice@example.com", "pw");

    form.setOAuthContext({ search: "?client_id=c1&sig=expired" });
    await form.submit();
    expect(form.getErrorMessage()).toContain("authorization request has expired");

    await form.submit();
    expect(form.getErrorMessage()).toContain("Server error");

    await form.submit();
    expect(form.getErrorMessage()).toBe("Invalid email or password.");
  });

  it("guards stale refreshSession races and missing oauth_query on submitConsent", async () => {
    let resolveDelayedMe!: (value: Response) => void;
    const delayedMe = new Promise<Response>((resolve) => {
      resolveDelayedMe = resolve;
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sampleProfile()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockReturnValueOnce(delayedMe) // inflight refreshSession started before signOut
      .mockResolvedValueOnce(new Response(null, { status: 200 })); // signOut

    vi.stubGlobal("fetch", fetchMock);

    const shell = new ProodShellElement();
    expect(shell.getAuthState()).toBe("loading");
    await shell.refreshSession();
    expect(shell.getAuthState()).toBe("authenticated");

    const inflightRefresh = shell.refreshSession();
    await shell.signOut();
    expect(shell.getAuthState()).toBe("unauthenticated");

    // Late 200 response from earlier refreshSession must NOT flip state back to authenticated
    resolveDelayedMe(
      new Response(JSON.stringify(sampleProfile()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await inflightRefresh;
    expect(shell.getAuthState()).toBe("unauthenticated");

    // Missing signed oauth_query on consent submit sets explicit error without calling fetch
    vi.stubGlobal("window", { location: { pathname: "/oauth/consent", search: "" } });
    await shell.submitConsent(true);
    expect(shell.getConsentError()).toBe("This authorization request is missing or invalid.");
  });
});

describe("@prood/web i18n error translation & accessible copy control", () => {
  it("translates known API error keys and falls back to error.generic for unknown keys", () => {
    const i18n = createI18n({
      locale: "ja",
      catalogs: {
        ja: {
          "error.prefixAlreadyInUse": "この接頭辞は既に使用中です。",
          "error.generic": "エラーが発生しました。",
        },
      },
    });
    expect(translateApiError(i18n, "error.prefixAlreadyInUse")).toBe(
      "この接頭辞は既に使用中です。",
    );
    expect(translateApiError(i18n, "error.unknownServerCode")).toBe(
      "エラーが発生しました。",
    );
  });

  it("copies target text via Clipboard API or legacy fallback and updates status live region cleanly", async () => {
    const win = new Window({ url: "http://127.0.0.1:3000/" });
    const doc = win.document as unknown as Document;
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("HTMLElement", win.HTMLElement);
    vi.stubGlobal("HTMLInputElement", win.HTMLInputElement);
    vi.stubGlobal("HTMLTextAreaElement", win.HTMLTextAreaElement);
    vi.stubGlobal("Element", win.Element);

    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const code = doc.createElement("code");
    code.id = "copy-target-1";
    code.textContent = "tsk_01jf8x9z2k3m4n5p6q7r8s9t0v";
    const copyControl = createCopyControl({
      targetId: "copy-target-1",
      buttonText: "Copy ID",
      screenReaderSuffix: "tsk_01jf8x9z2k3m4n5p6q7r8s9t0v",
      copyKind: "id",
    });
    doc.body.append(code, copyControl);

    ensureCopyCommandListener(() => ({ copied: "Copied", failed: "Copy failed" }));

    const btn = copyControl.querySelector("button")!;
    const tip = copyControl.querySelector('[role="status"]')!;

    const firstOk = await copyFromTarget(btn, code, {
      copied: "Copied",
      failed: "Copy failed",
    });
    expect(firstOk).toBe(true);
    expect(writeText).toHaveBeenCalledWith("tsk_01jf8x9z2k3m4n5p6q7r8s9t0v");
    expect(btn.hasAttribute("data-copied")).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(tip.textContent).toBe("Copied");

    // Repeated announcement adds NBSP so screen readers re-announce identical status
    await copyFromTarget(btn, code, { copied: "Copied", failed: "Copy failed" });
    expect(tip.textContent).toBe("Copied\u00A0");

    // Clipboard failure with failed legacyCopy shows failure message without disabling button
    writeText.mockRejectedValueOnce(new Error("Permission denied"));
    const failedOk = await copyFromTarget(btn, code, {
      copied: "Copied",
      failed: "Copy failed",
    });
    expect(failedOk).toBe(false);
    expect(btn.hasAttribute("data-failed")).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(tip.textContent).toBe("Copy failed");
  });
});

async function flushUiTicks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function mountMockedShell(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  vi.resetModules();
  const win = new Window({ url: "http://127.0.0.1:3000/" });
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
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    return await fetchImpl(new URL(raw, "http://127.0.0.1:3000").pathname + new URL(raw, "http://127.0.0.1:3000").search, init);
  });

  const web = await import("@prood/web");
  const shell = doc.createElement("prood-shell") as unknown as InstanceType<
    typeof web.ProodShellElement
  >;
  doc.body.appendChild(shell as unknown as Node);
  return { win, doc, shell };
}

function makeProject(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  statusId: StatusId,
  name: string,
): ProjectDto {
  const now = "2026-11-28T12:00:00.000Z";
  return {
    id: projectId,
    workspaceId,
    name,
    description: "",
    visibility: "workspace",
    kind: "general",
    createdAt: now,
    updatedAt: now,
    myRole: "admin",
    devSettings: null,
    statuses: [
      {
        id: statusId,
        projectId,
        name: "To Do",
        category: "todo",
        position: 0,
      },
    ],
  };
}

function makeTask(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  statusId: StatusId,
  byte: number,
  title: string,
): TaskDto {
  const now = "2026-11-28T12:00:00.000Z";
  return {
    id: generateEntityId("tsk", 1_795_000_000_000 + byte, new Uint8Array(10).fill(byte)),
    workspaceId,
    projectId,
    effectiveProjectId: projectId,
    title,
    description: "",
    statusId,
    issueKey: null,
    branchName: null,
    parentTaskId: null,
    assigneeId: null,
    createdBy: null,
    dueOn: null,
    completedAt: null,
    position: byte,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMembershipId(byte: number) {
  return generateEntityId("mbr", 1_795_000_000_000 + byte, new Uint8Array(10).fill(byte));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("@prood/web async race regressions", () => {
  it("ignores late task-creation completions after switching projects (4725269036)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const projB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const statusB = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(6));

    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");
    const projectB = makeProject(wksA, projB, statusB, "Project Beta");
    const taskA = makeTask(wksA, projA, statusA, 10, "Existing Alpha Task");
    const lateCreatedInA = makeTask(wksA, projA, statusA, 11, "Late Alpha Task");
    const taskB = makeTask(wksA, projB, statusB, 12, "Existing Beta Task");

    let resolveCreateA!: (res: Response) => void;
    const createADeferred = new Promise<Response>((resolve) => {
      resolveCreateA = resolve;
    });
    let projATaskFetchCount = 0;

    const { win, doc, shell } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(101),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS A",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA, projectB] });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks` && (init?.method ?? "GET") === "GET") {
        projATaskFetchCount += 1;
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [taskA] });
      }
      if (path === `/api/v1/projects/${projB}/tasks` && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [taskB] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: path.includes(projA) ? projectA.statuses : projectB.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      if (path === `/api/v1/projects/${projA}/tasks` && init?.method === "POST") {
        return createADeferred;
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => doc.body.textContent?.includes("Existing Alpha Task") ?? false,
      "project A initial task rendered",
    );

    const titleInput = doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    titleInput.value = "Late Alpha Task";
    titleInput.dispatchEvent(new win.Event("input") as unknown as Event);
    doc
      .querySelector<HTMLFormElement>("[data-create-task-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);

    doc.querySelector<HTMLButtonElement>(`[data-project-id="${projB}"]`)!.click();
    await waitForCondition(
      () => doc.body.textContent?.includes("Existing Beta Task") ?? false,
      "switched to project B",
    );

    const bTitleInput = doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    bTitleInput.value = "Draft in Beta";
    bTitleInput.dispatchEvent(new win.Event("input") as unknown as Event);
    expect(doc.querySelector<HTMLButtonElement>("[data-create-task-submit]")!.disabled).toBe(false);

    resolveCreateA(jsonResponse({ contractVersion: CONTRACT_VERSION, task: lateCreatedInA }, 201));
    await flushUiTicks(8);

    expect(shell.getActiveProjectId()).toBe(projB);
    expect(doc.body.textContent).toContain("Existing Beta Task");
    expect(doc.body.textContent).not.toContain("Late Alpha Task");
    expect(doc.body.textContent).not.toContain("Task created.");
    expect(doc.querySelector<HTMLInputElement>("[data-task-title-input]")!.value).toBe("Draft in Beta");
    expect(projATaskFetchCount).toBe(1);
  });

  it("discards stale workspace-setting responses after switching workspaces (4725269038)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const wksB = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(3));

    let resolveWsASave!: (res: Response) => void;
    const wsASaveDeferred = new Promise<Response>((resolve) => {
      resolveWsASave = resolve;
    });

    const { win, doc, shell } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(102),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS Alpha",
              role: "admin",
            },
            {
              membershipId: makeMembershipId(103),
              workspaceId: wksB,
              workspaceSlug: "ws-b",
              workspaceName: "WS Beta",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path.endsWith("/projects")) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [] });
      }
      if (
        (path === `/api/v1/workspaces/${wksA}/settings` ||
          path === `/api/v1/workspaces/${wksB}/settings`) &&
        (init?.method ?? "GET") === "GET"
      ) {
        const wsId = path.includes(wksA) ? wksA : wksB;
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wsId,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings` && init?.method === "PATCH") {
        return wsASaveDeferred;
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => doc.querySelector('[data-nav-view="settings"]') !== null,
      "settings nav ready",
    );
    doc.querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!.click();
    await waitForCondition(
      () => doc.querySelector("[data-ws-dev-toggle]") !== null,
      "workspace A settings loaded",
    );

    const toggleA = doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!;
    toggleA.checked = true;
    doc
      .querySelector<HTMLFormElement>("[data-workspace-settings-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);

    const wsSelect = doc.querySelector<HTMLSelectElement>("[data-workspace-select]")!;
    wsSelect.value = wksB;
    wsSelect.dispatchEvent(new win.Event("change") as unknown as Event);

    await waitForCondition(
      () =>
        shell.getActiveWorkspaceId() === wksB &&
        doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")?.disabled === false,
      "switched to workspace B settings",
    );
    expect(doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!.checked).toBe(false);

    resolveWsASave(
      jsonResponse({
        contractVersion: CONTRACT_VERSION,
        settings: {
          workspaceId: wksA,
          defaultLocale: "en",
          devProjectsEnabled: true,
          updatedAt: "2026-11-28T12:01:00.000Z",
        } satisfies WorkspaceSettingsDto,
      }),
    );
    await flushUiTicks(8);

    expect(shell.getActiveWorkspaceId()).toBe(wksB);
    expect(doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!.checked).toBe(false);
    expect(doc.body.textContent).not.toContain("Settings saved");
  });

  it("invalidates in-flight searches when the search query is cleared (4725269040)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");
    const matchedTask = makeTask(wksA, projA, statusA, 20, "Stale Search Result");

    let resolveSearch!: (res: Response) => void;
    const searchDeferred = new Promise<Response>((resolve) => {
      resolveSearch = resolve;
    });
    let searchCalls = 0;

    const { win, doc, shell } = await mountMockedShell(async (path) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(101),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS A",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: projectA.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      if (path.startsWith(`/api/v1/workspaces/${wksA}/tasks/search`)) {
        searchCalls += 1;
        return searchDeferred;
      }
      throw new Error(`Unexpected request: GET ${path}`);
    });

    await waitForCondition(
      () => shell.getActiveProjectId() === projA,
      "initial project loaded",
    );

    await shell.openSearch();
    const searchInput = doc.querySelector<HTMLInputElement>("[data-search-input]")!;
    searchInput.value = "Stale";
    searchInput.dispatchEvent(new win.Event("input") as unknown as Event);
    await waitForCondition(() => searchCalls === 1, "debounced search started");

    searchInput.value = "";
    searchInput.dispatchEvent(new win.Event("input") as unknown as Event);
    await flushUiTicks(4);

    resolveSearch(
      jsonResponse({
        contractVersion: CONTRACT_VERSION,
        items: [{ matchKind: "title", task: matchedTask }],
        nextCursor: null,
      }),
    );
    await flushUiTicks(6);

    expect(doc.querySelectorAll("[data-search-result-id]").length).toBe(0);
    expect(doc.querySelector("[data-search-dialog]")?.textContent).toContain(
      "Type a task ID",
    );
  });

  it("cancels pending project mutations when creating and selecting a new project (4725328776)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const projB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const statusB = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(6));
    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");
    const projectB = makeProject(wksA, projB, statusB, "Created Beta");
    const taskA = makeTask(wksA, projA, statusA, 10, "Alpha Existing");
    const lateTaskA = makeTask(wksA, projA, statusA, 11, "Late Alpha Task");

    let createdB = false;
    let resolveCreateTaskA!: (res: Response) => void;
    const createTaskADeferred = new Promise<Response>((resolve) => {
      resolveCreateTaskA = resolve;
    });

    const { win, doc, shell } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(110),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS A",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects` && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          projects: createdB ? [projectA, projectB] : [projectA],
        });
      }
      if (path === `/api/v1/workspaces/${wksA}/projects` && init?.method === "POST") {
        createdB = true;
        return jsonResponse({ contractVersion: CONTRACT_VERSION, project: projectB }, 201);
      }
      if (path === `/api/v1/workspaces/${wksA}/settings`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks` && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [taskA] });
      }
      if (path === `/api/v1/projects/${projA}/tasks` && init?.method === "POST") {
        return createTaskADeferred;
      }
      if (path === `/api/v1/projects/${projB}/tasks` && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: path.includes(projA) ? projectA.statuses : projectB.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => doc.body.textContent?.includes("Alpha Existing") ?? false,
      "project A loaded",
    );

    const taskInput = doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    taskInput.value = "Late Alpha Task";
    taskInput.dispatchEvent(new win.Event("input") as unknown as Event);
    doc
      .querySelector<HTMLFormElement>("[data-create-task-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);

    // Create project B while project A task creation is still in flight
    doc.querySelector<HTMLButtonElement>("[data-toggle-new-project]")!.click();
    const newName = doc.querySelector<HTMLInputElement>("[data-new-project-name]")!;
    newName.value = "Created Beta";
    newName.dispatchEvent(new win.Event("input") as unknown as Event);
    doc
      .querySelector<HTMLFormElement>("[data-new-project-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);

    await waitForCondition(
      () =>
        shell.getActiveProjectId() === projB &&
        doc.querySelector("[data-create-task-submit]") !== null,
      "created project B active",
    );
    expect(doc.querySelector<HTMLButtonElement>("[data-create-task-submit]")!.disabled).toBe(
      false,
    );

    resolveCreateTaskA(jsonResponse({ contractVersion: CONTRACT_VERSION, task: lateTaskA }, 201));
    await flushUiTicks(6);

    expect(shell.getActiveProjectId()).toBe(projB);
    expect(doc.querySelector<HTMLButtonElement>("[data-create-task-submit]")!.disabled).toBe(
      false,
    );
    expect(doc.body.textContent).not.toContain("Late Alpha Task");
  });

  it("clears previous workspace projects and settings before loading the next workspace (4725311771 / 4725328784)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const wksB = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const projB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(6));
    const statusB = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(7));
    const projectA = makeProject(wksA, projA, statusA, "Workspace A Project");
    const projectB = makeProject(wksB, projB, statusB, "Workspace B Project");

    let resolveWsBProjects!: (res: Response) => void;
    const wsBProjectsDeferred = new Promise<Response>((resolve) => {
      resolveWsBProjects = resolve;
    });

    const { win, doc, shell } = await mountMockedShell(async (path) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(120),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS Alpha",
              role: "admin",
            },
            {
              membershipId: makeMembershipId(121),
              workspaceId: wksB,
              workspaceSlug: "ws-b",
              workspaceName: "WS Beta",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksB}/projects`) {
        return wsBProjectsDeferred;
      }
      if (path.endsWith("/settings")) {
        const wsId = path.includes(wksA) ? wksA : wksB;
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wsId,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path.endsWith("/tasks")) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: path.includes(projA) ? projectA.statuses : projectB.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      throw new Error(`Unexpected request: GET ${path}`);
    });

    await waitForCondition(
      () => doc.querySelector(`[data-project-id="${projA}"]`) !== null,
      "workspace A project rendered",
    );

    const wsSelect = doc.querySelector<HTMLSelectElement>("[data-workspace-select]")!;
    wsSelect.value = wksB;
    wsSelect.dispatchEvent(new win.Event("change") as unknown as Event);
    await flushUiTicks(2);

    // While workspace B is still loading, workspace A's project buttons must already be gone
    expect(shell.getActiveWorkspaceId()).toBe(wksB);
    expect(doc.querySelectorAll("[data-project-id]").length).toBe(0);
    expect(doc.querySelector(`[data-project-id="${projA}"]`)).toBeNull();

    resolveWsBProjects(
      jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectB] }),
    );
    await waitForCondition(
      () => doc.querySelector(`[data-project-id="${projB}"]`) !== null,
      "workspace B project loaded",
    );
  });

  it("displays task-loading failures instead of an empty project state (4725328791)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");

    const { doc } = await mountMockedShell(async (path) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(130),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS A",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks`) {
        return jsonResponse(
          {
            contractVersion: CONTRACT_VERSION,
            error: {
              code: "INTERNAL_ERROR",
              messageKey: "error.generic",
              message: "Server error",
            },
          },
          500,
        );
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: projectA.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      throw new Error(`Unexpected request: GET ${path}`);
    });

    await waitForCondition(
      () => doc.querySelector("[data-task-load-error]") !== null,
      "task load error alert rendered",
    );
    expect(doc.querySelector("[data-task-load-error]")!.textContent).toContain(
      "Something went wrong",
    );
    expect(doc.querySelector("[data-task-count]")).toBeNull();
    expect(doc.body.textContent).not.toContain("No tasks yet");
  });

  it("clears cached search query and results when signing out and signing in as another user (4725311777 / 4725328797)", async () => {
    const userA = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const userB = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(9));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const wksB = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const projB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(6));
    const statusB = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(7));
    const projectA = makeProject(wksA, projA, statusA, "Secret Alpha");
    const projectB = makeProject(wksB, projB, statusB, "Beta Workspace");
    const secretTaskA = makeTask(wksA, projA, statusA, 30, "Confidential Payroll Secret");

    let activeUser: "A" | "B" = "A";

    const { win, doc, shell } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        if (activeUser === "A") {
          return jsonResponse({
            contractVersion: CONTRACT_VERSION,
            user: { id: userA, email: "a@example.com", displayName: "User A" },
            memberships: [
              {
                membershipId: makeMembershipId(140),
                workspaceId: wksA,
                workspaceSlug: "ws-a",
                workspaceName: "WS A",
                role: "admin",
              },
            ],
          } satisfies MeResponse);
        }
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userB, email: "b@example.com", displayName: "User B" },
          memberships: [
            {
              membershipId: makeMembershipId(141),
              workspaceId: wksB,
              workspaceSlug: "ws-b",
              workspaceName: "WS B",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === "/api/auth/sign-out" && init?.method === "POST") {
        return new Response(null, { status: 200 });
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksB}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectB] });
      }
      if (path.endsWith("/settings")) {
        const wsId = path.includes(wksA) ? wksA : wksB;
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wsId,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path.endsWith("/tasks")) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: path.includes(projA) ? projectA.statuses : projectB.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      if (path.startsWith(`/api/v1/workspaces/${wksA}/tasks/search`)) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          items: [{ matchKind: "text", task: secretTaskA }],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => shell.getActiveProjectId() === projA,
      "user A loaded",
    );

    await shell.openSearch();
    const inputA = doc.querySelector<HTMLInputElement>("[data-search-input]")!;
    inputA.value = "Confidential";
    inputA.dispatchEvent(new win.Event("input") as unknown as Event);
    await waitForCondition(
      () => doc.querySelector(`[data-search-result-id="${secretTaskA.id}"]`) !== null,
      "user A sees confidential search result",
    );

    await shell.signOut();
    activeUser = "B";
    await shell.refreshSession();
    await waitForCondition(
      () => shell.getActiveWorkspaceId() === wksB && shell.getActiveProjectId() === projB,
      "user B loaded",
    );

    await shell.openSearch();
    const inputB = doc.querySelector<HTMLInputElement>("[data-search-input]")!;
    expect(inputB.value).toBe("");
    expect(doc.querySelectorAll("[data-search-result-id]").length).toBe(0);
    expect(doc.querySelector("[data-search-dialog]")?.textContent).not.toContain(
      "Confidential Payroll Secret",
    );
  });

  it("disables workspace settings edits and surfaces an error when loading workspace settings fails (4725545625)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");
    let patchCalls = 0;

    const { win, doc } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(150),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS Alpha",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings` && (init?.method ?? "GET") === "GET") {
        return jsonResponse(
          {
            contractVersion: CONTRACT_VERSION,
            error: {
              code: "INTERNAL_ERROR",
              messageKey: "error.generic",
              message: "Failed to load settings",
            },
          },
          500,
        );
      }
      if (path === `/api/v1/workspaces/${wksA}/settings` && init?.method === "PATCH") {
        patchCalls += 1;
        return jsonResponse({ contractVersion: CONTRACT_VERSION }, 200);
      }
      if (path.endsWith("/tasks")) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: projectA.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => doc.querySelector('[data-nav-view="settings"]') !== null,
      "settings nav ready",
    );
    doc.querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!.click();
    await waitForCondition(
      () =>
        doc.querySelector("[data-ws-dev-toggle]") !== null &&
        doc.querySelector('[role="alert"]') !== null,
      "workspace settings error alert rendered",
    );

    expect(doc.querySelector<HTMLInputElement>("[data-ws-dev-toggle]")!.disabled).toBe(true);
    expect(doc.querySelector<HTMLButtonElement>("[data-ws-dev-save]")!.disabled).toBe(true);
    expect(doc.querySelector('[role="alert"]')!.textContent).toContain("Something went wrong");

    doc
      .querySelector<HTMLFormElement>("[data-workspace-settings-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);
    await flushUiTicks(4);

    expect(patchCalls).toBe(0);
  });

  it("preserves a newer task draft edited while task creation is pending (4725624219)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");
    const firstTask = makeTask(wksA, projA, statusA, 40, "First task");

    let created = false;
    let resolveCreate!: (res: Response) => void;
    const createDeferred = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });

    const { win, doc } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(160),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS Alpha",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks` && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          tasks: created ? [firstTask] : [],
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks` && init?.method === "POST") {
        created = true;
        return createDeferred;
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: projectA.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => doc.querySelector("[data-task-title-input]") !== null,
      "task creation form rendered",
    );

    const input1 = doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    input1.value = "First task";
    input1.dispatchEvent(new win.Event("input") as unknown as Event);
    doc
      .querySelector<HTMLFormElement>("[data-create-task-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);

    // Edit draft for a second task before the first POST settles
    const inputPending = doc.querySelector<HTMLInputElement>("[data-task-title-input]")!;
    inputPending.value = "Second task draft";
    inputPending.dispatchEvent(new win.Event("input") as unknown as Event);

    resolveCreate(jsonResponse({ contractVersion: CONTRACT_VERSION, task: firstTask }, 201));
    await waitForCondition(
      () => doc.body.textContent?.includes("First task") ?? false,
      "first task rendered after reload",
    );

    expect(doc.querySelector<HTMLInputElement>("[data-task-title-input]")!.value).toBe(
      "Second task draft",
    );
  });

  it("clears selectable search results immediately when changing the search query (4725652794)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const projB = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const statusA = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const statusB = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(6));
    const projCurrent = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(7));
    const statusCur = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(8));
    const projectCur = makeProject(wksA, projCurrent, statusCur, "Current Project");
    const projectA = makeProject(wksA, projA, statusA, "Project Alpha");
    const projectB = makeProject(wksA, projB, statusB, "Project Beta");
    const task1 = {
      ...makeTask(wksA, projA, statusA, 50, "Task One"),
      issueKey: "PRD-1",
    };
    const task2 = {
      ...makeTask(wksA, projB, statusB, 51, "Task Two"),
      issueKey: "PRD-2",
    };

    let resolveSecondSearch!: (res: Response) => void;
    const secondSearchDeferred = new Promise<Response>((resolve) => {
      resolveSecondSearch = resolve;
    });
    const searchQueries: string[] = [];

    const { win, doc, shell } = await mountMockedShell(async (path) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(170),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS Alpha",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          projects: [projectCur, projectA, projectB],
        });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings`) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: false,
            updatedAt: "2026-11-28T12:00:00.000Z",
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path.endsWith("/tasks")) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path.endsWith("/dev-settings")) {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          allowed: false,
          canManage: true,
          dev: null,
          statuses: projectCur.statuses,
        } satisfies ProjectDevSettingsResponse);
      }
      if (path.startsWith(`/api/v1/workspaces/${wksA}/tasks/search`)) {
        const q = new URL(path, "http://127.0.0.1:3000").searchParams.get("q") ?? "";
        searchQueries.push(q);
        if (q === "PRD-1") {
          return jsonResponse({
            contractVersion: CONTRACT_VERSION,
            items: [{ matchKind: "exact_key", task: task1 }],
            nextCursor: null,
          });
        }
        if (q === "PRD-2") {
          return secondSearchDeferred;
        }
      }
      throw new Error(`Unexpected request: GET ${path}`);
    });

    await waitForCondition(
      () => shell.getActiveProjectId() === projCurrent,
      "initial project loaded",
    );

    await shell.openSearch();
    const searchInput = doc.querySelector<HTMLInputElement>("[data-search-input]")!;
    const dialog = doc.querySelector<HTMLDialogElement>("[data-search-dialog]")!;
    const searchForm = dialog.querySelector("form")!;

    searchInput.value = "PRD-1";
    searchInput.dispatchEvent(new win.Event("input") as unknown as Event);
    await waitForCondition(
      () => doc.querySelector(`[data-search-result-id="${task1.id}"]`) !== null,
      "PRD-1 result rendered",
    );

    // Replace query with PRD-2 and immediately press Enter / submit before PRD-2 resolves
    searchInput.value = "PRD-2";
    searchInput.dispatchEvent(new win.Event("input") as unknown as Event);
    expect(doc.querySelectorAll("[data-search-result-id]").length).toBe(0);

    searchInput.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", cancelable: true }) as unknown as Event,
    );
    searchForm.dispatchEvent(
      new win.Event("submit", { cancelable: true }) as unknown as Event,
    );
    await waitForCondition(
      () => searchQueries.includes("PRD-2"),
      "PRD-2 search dispatched on submit",
    );

    // Previous PRD-1 result must NOT have been selected
    expect(shell.getActiveProjectId()).toBe(projCurrent);
    expect(dialog.open || dialog.hasAttribute("open")).toBe(true);
    expect(doc.querySelectorAll("[data-search-result-id]").length).toBe(0);

    // Once PRD-2 finishes, selecting via Enter navigates to task2's project (projB)
    resolveSecondSearch(
      jsonResponse({
        contractVersion: CONTRACT_VERSION,
        items: [{ matchKind: "exact_key", task: task2 }],
        nextCursor: null,
      }),
    );
    await waitForCondition(
      () => doc.querySelector(`[data-search-result-id="${task2.id}"]`) !== null,
      "PRD-2 result rendered",
    );

    searchInput.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Enter", cancelable: true }) as unknown as Event,
    );
    await waitForCondition(
      () => shell.getActiveProjectId() === projB,
      "PRD-2 selected on Enter",
    );
  });

  it("preserves project dev settings drafts edited during background reloads and workspace saves (4725756197)", async () => {
    const userId = generateEntityId("usr", 1_795_000_000_000, new Uint8Array(10).fill(1));
    const wksA = generateEntityId("wks", 1_795_000_000_000, new Uint8Array(10).fill(2));
    const projA = generateEntityId("prj", 1_795_000_000_000, new Uint8Array(10).fill(3));
    const nspA = generateEntityId("ins", 1_795_000_000_000, new Uint8Array(10).fill(4));
    const statusTodo = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(5));
    const statusInProgress = generateEntityId("sts", 1_795_000_000_000, new Uint8Array(10).fill(6));
    const now = "2026-11-28T12:00:00.000Z";

    const projectA: ProjectDto = {
      ...makeProject(wksA, projA, statusTodo, "Dev Project"),
      kind: "development",
      statuses: [
        {
          id: statusTodo,
          projectId: projA,
          name: "To Do",
          category: "todo",
          position: 0,
        },
        {
          id: statusInProgress,
          projectId: projA,
          name: "In Progress",
          category: "in_progress",
          position: 1,
        },
      ],
      devSettings: {
        namespaceId: nspA,
        projectId: projA,
        prefix: "PRD",
        branchPrefix: "prd",
        startStatusId: null,
        oldPrefixes: [],
        enabledAt: now,
        updatedAt: now,
      },
    };

    const devSettingsBody: ProjectDevSettingsResponse = {
      contractVersion: CONTRACT_VERSION,
      allowed: true,
      canManage: true,
      dev: projectA.devSettings,
      statuses: projectA.statuses,
    };

    let delayReload = false;
    let resolveDelayedDevGet: ((res: Response) => void) | null = null;
    let wsDevEnabled = true;

    const { win, doc } = await mountMockedShell(async (path, init) => {
      if (path === "/api/v1/me") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          user: { id: userId, email: "alice@example.com", displayName: "Alice" },
          memberships: [
            {
              membershipId: makeMembershipId(180),
              workspaceId: wksA,
              workspaceSlug: "ws-a",
              workspaceName: "WS Alpha",
              role: "admin",
            },
          ],
        } satisfies MeResponse);
      }
      if (path === `/api/v1/workspaces/${wksA}/projects`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, projects: [projectA] });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings` && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: wsDevEnabled,
            updatedAt: now,
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/workspaces/${wksA}/settings` && init?.method === "PATCH") {
        const parsed = JSON.parse(String(init.body ?? "{}")) as {
          devProjectsEnabled?: boolean;
        };
        wsDevEnabled = parsed.devProjectsEnabled ?? wsDevEnabled;
        return jsonResponse({
          contractVersion: CONTRACT_VERSION,
          settings: {
            workspaceId: wksA,
            defaultLocale: "en",
            devProjectsEnabled: wsDevEnabled,
            updatedAt: now,
          } satisfies WorkspaceSettingsDto,
        });
      }
      if (path === `/api/v1/projects/${projA}/tasks`) {
        return jsonResponse({ contractVersion: CONTRACT_VERSION, tasks: [] });
      }
      if (path === `/api/v1/projects/${projA}/dev-settings`) {
        if (delayReload) {
          return new Promise<Response>((resolve) => {
            resolveDelayedDevGet = resolve;
          });
        }
        return jsonResponse(devSettingsBody);
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
    });

    await waitForCondition(
      () => doc.querySelector('[data-nav-view="settings"]') !== null,
      "initial shell loaded",
    );
    doc.querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!.click();
    await waitForCondition(
      () => doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")?.value === "PRD",
      "initial dev settings loaded",
    );

    // Return to List, then re-enter Settings with a deferred background reload
    doc.querySelector<HTMLButtonElement>('[data-nav-view="list"]')!.click();
    await waitForCondition(
      () => doc.querySelector("[data-create-task-form]") !== null,
      "returned to list",
    );

    delayReload = true;
    doc.querySelector<HTMLButtonElement>('[data-nav-view="settings"]')!.click();
    await waitForCondition(
      () =>
        doc.querySelector("[data-proj-prefix-input]") !== null &&
        resolveDelayedDevGet !== null,
      "settings rendered immediately while background reload is in flight",
    );

    const prefixInput = doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")!;
    prefixInput.value = "CUSTOM";
    prefixInput.dispatchEvent(new win.Event("input") as unknown as Event);

    const startSelect = doc.querySelector<HTMLSelectElement>(
      "[data-proj-start-status-select]",
    )!;
    startSelect.value = statusInProgress;
    startSelect.dispatchEvent(new win.Event("change") as unknown as Event);

    // Finish background reload -> unsaved edits must survive
    delayReload = false;
    resolveDelayedDevGet!(jsonResponse(devSettingsBody));
    await flushUiTicks(6);

    expect(doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")!.value).toBe(
      "CUSTOM",
    );
    expect(
      doc.querySelector<HTMLSelectElement>("[data-proj-start-status-select]")!.value,
    ).toBe(statusInProgress);

    // Saving workspace settings triggers loadProjectData(), which must also keep those drafts
    doc
      .querySelector<HTMLFormElement>("[data-workspace-settings-form]")!
      .dispatchEvent(new win.Event("submit", { cancelable: true }) as unknown as Event);
    await waitForCondition(
      () =>
        doc
          .querySelector(".prood-status-banner")
          ?.textContent?.includes("Settings saved") ?? false,
      "workspace settings saved",
    );

    expect(doc.querySelector<HTMLInputElement>("[data-proj-prefix-input]")!.value).toBe(
      "CUSTOM",
    );
    expect(
      doc.querySelector<HTMLSelectElement>("[data-proj-start-status-select]")!.value,
    ).toBe(statusInProgress);
  });
});

