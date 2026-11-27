import { describe, expect, it } from "vitest";
import {
  canManageProject,
  canReadProject,
  canWriteProjectTasks,
  resolveEffectiveProjectRole,
} from "@prood/domain";

describe("@prood/domain effective project access rules", () => {
  it("isolates cross-workspace actors and grants workspace admins full access", () => {
    expect(
      resolveEffectiveProjectRole({
        workspaceRole: null,
        projectVisibility: "workspace",
        projectMembershipRole: "admin",
      }),
    ).toBeNull();

    expect(
      resolveEffectiveProjectRole({
        workspaceRole: "admin",
        projectVisibility: "private",
        projectMembershipRole: null,
      }),
    ).toBe("admin");
  });

  it("enforces workspace visibility vs private membership and caps workspace viewers", () => {
    const privateNoMember = resolveEffectiveProjectRole({
      workspaceRole: "member",
      projectVisibility: "private",
      projectMembershipRole: null,
    });
    expect(privateNoMember).toBeNull();
    expect(canReadProject(privateNoMember)).toBe(false);

    const openMember = resolveEffectiveProjectRole({
      workspaceRole: "member",
      projectVisibility: "workspace",
      projectMembershipRole: null,
    });
    expect(openMember).toBe("member");
    expect(canReadProject(openMember)).toBe(true);
    expect(canWriteProjectTasks(openMember)).toBe(true);
    expect(canManageProject(openMember)).toBe(false);

    const openViewer = resolveEffectiveProjectRole({
      workspaceRole: "viewer",
      projectVisibility: "workspace",
      projectMembershipRole: null,
    });
    expect(openViewer).toBe("viewer");
    expect(canReadProject(openViewer)).toBe(true);
    expect(canWriteProjectTasks(openViewer)).toBe(false);

    // Workspace-level viewer remains capped to read-only even if project membership says member
    const viewerCapped = resolveEffectiveProjectRole({
      workspaceRole: "viewer",
      projectVisibility: "private",
      projectMembershipRole: "member",
    });
    expect(viewerCapped).toBe("viewer");
    expect(canWriteProjectTasks(viewerCapped)).toBe(false);

    const explicitProjectAdmin = resolveEffectiveProjectRole({
      workspaceRole: "member",
      projectVisibility: "private",
      projectMembershipRole: "admin",
    });
    expect(explicitProjectAdmin).toBe("admin");
    expect(canManageProject(explicitProjectAdmin)).toBe(true);
  });
});
