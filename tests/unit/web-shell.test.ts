import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_VERSION, type MeResponse } from "@prood/contracts";
import { generateEntityId } from "@prood/domain";
import { ProodShellElement } from "@prood/web";

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
