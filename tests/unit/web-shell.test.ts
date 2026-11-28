import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { CONTRACT_VERSION, type MeResponse } from "@prood/contracts";
import { generateEntityId } from "@prood/domain";
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

