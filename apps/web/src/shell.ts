import type {
  MeResponse,
  ProjectDevSettingsResponse,
  ProjectDto,
  TaskDto,
  WorkspaceSettingsDto,
} from "@prood/contracts";
import {
  normalizeDevPrefix,
  type ProjectId,
  type ProjectVisibility,
  type StatusId,
  type TaskPublicId,
  type WorkspaceId,
  type WorkspaceRole,
} from "@prood/domain";
import {
  createProject,
  createTask,
  enableDevProject,
  getProjectDevSettings,
  getWorkspaceSettings,
  listProjects,
  listProjectTasks,
  updateDevProjectSettings,
  updateWorkspaceSettings,
} from "./api.js";
import { ensureCopyCommandListener } from "./clipboard.js";
import { alertBanner, el, fieldGroup } from "./dom.js";
import {
  createI18n,
  translateApiError,
  type I18nInstance,
} from "./i18n/messages.js";
import {
  extractSignedOAuthQuery,
  isSafeRedirectUrl,
  ProodLoginFormElement,
} from "./login-form.js";
import type { SearchPaletteController } from "./search-dialog.js";
import type { renderSettingsPanel } from "./settings-panel.js";
import { renderTaskListView } from "./task-list.js";

const BaseElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as typeof HTMLElement);

export type ShellAuthState = "loading" | "authenticated" | "unauthenticated";
export type ShellView = "list" | "settings";

const ROLE_LABEL_KEYS: Record<WorkspaceRole, "role.admin" | "role.member" | "role.viewer"> = {
  admin: "role.admin",
  member: "role.member",
  viewer: "role.viewer",
};

function parseRouteState(): {
  workspaceId: WorkspaceId | null;
  projectId: ProjectId | null;
  view: ShellView;
} {
  if (typeof window === "undefined") {
    return { workspaceId: null, projectId: null, view: "list" };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    workspaceId: (params.get("workspace") as WorkspaceId | null) || null,
    projectId: (params.get("project") as ProjectId | null) || null,
    view: params.get("view") === "settings" ? "settings" : "list",
  };
}

export class ProodShellElement extends BaseElement {
  private i18n: I18nInstance = createI18n();
  private sessionProfile: MeResponse | null = null;
  private authState: ShellAuthState = "loading";
  private signingOut = false;
  private signOutError = "";
  private consentError = "";
  private consentSubmitting = false;
  private consentClientName: string | null = null;
  private consentClientFetchedFor: string | null = null;
  private sessionRequestSeq = 0;
  private workspaceDataSeq = 0;
  private projectDataSeq = 0;
  private listenersController: AbortController | null = null;

  private activeWorkspaceId: WorkspaceId | null = null;
  private activeProjectId: ProjectId | null = null;
  private activeView: ShellView = "list";
  private projects: ProjectDto[] = [];
  private workspaceSettings: WorkspaceSettingsDto | null = null;
  private tasks: TaskDto[] = [];
  private activeDevSettings: ProjectDevSettingsResponse | null = null;
  private loadingWorkspace = false;
  private workspaceLoadError = "";

  private newProjectOpen = false;
  private newProjectName = "";
  private newProjectVisibility: ProjectVisibility = "workspace";
  private newProjectEnableDev = false;
  private newProjectPrefix = "";
  private creatingProject = false;
  private newProjectError = "";

  private taskTitleDraft = "";
  private taskStatusDraft: StatusId | "" = "";
  private creatingTask = false;
  private taskCreateError = "";
  private taskCreateNotice = "";
  private highlightedTaskId: TaskPublicId | null = null;

  private savingWorkspaceSettings = false;
  private workspaceSettingsNotice = "";
  private workspaceSettingsError = "";
  private savingProjectSettings = false;
  private projectSettingsNotice = "";
  private projectSettingsError = "";
  private devPrefixDraft = "";
  private devStartStatusDraft: StatusId | "" = "";

  private shellRoot: HTMLDivElement | null = null;
  private searchPalette: SearchPaletteController | null = null;
  private searchPalettePromise: Promise<SearchPaletteController | null> | null = null;
  private renderSettingsFn: typeof renderSettingsPanel | null = null;
  private settingsLoadPromise: Promise<void> | null = null;

  connectedCallback(): void {
    this.listenersController?.abort();
    const controller = new AbortController();
    this.listenersController = controller;

    ensureCopyCommandListener(() => ({
      copied: this.i18n.t("copy.copied"),
      failed: this.i18n.t("copy.failed"),
    }));

    this.addEventListener(
      "prood-authenticated",
      () => void this.refreshSession(),
      { signal: controller.signal },
    );

    if (typeof window !== "undefined") {
      window.addEventListener(
        "pageshow",
        (event) => {
          if ((event as PageTransitionEvent).persisted) void this.refreshSession();
        },
        { signal: controller.signal },
      );
      window.addEventListener(
        "popstate",
        () => this.applyRouteFromLocation(),
        { signal: controller.signal },
      );
      window.addEventListener(
        "keydown",
        (event) => {
          if (
            this.authState === "authenticated" &&
            !this.isConsentRoute() &&
            this.activeWorkspaceId &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            event.key.toLowerCase() === "k"
          ) {
            event.preventDefault();
            void this.openSearch();
          }
        },
        { signal: controller.signal },
      );
    }

    this.render();
    void this.refreshSession();
  }

  disconnectedCallback(): void {
    this.listenersController?.abort();
    this.listenersController = null;
    this.searchPalette?.destroy();
    this.searchPalette = null;
    this.shellRoot = null;
  }

  setI18n(i18n: I18nInstance): void {
    this.i18n = i18n;
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = i18n.getLocale();
    }
    this.searchPalette?.syncLabels();
    this.render();
  }

  getAuthState(): ShellAuthState {
    return this.authState;
  }
  getSignOutError(): string {
    return this.signOutError;
  }
  getConsentError(): string {
    return this.consentError;
  }
  getActiveWorkspaceId(): WorkspaceId | null {
    return this.activeWorkspaceId;
  }
  getActiveProjectId(): ProjectId | null {
    return this.activeProjectId;
  }
  getActiveView(): ShellView {
    return this.activeView;
  }

  async openSearch(): Promise<void> {
    if (
      this.authState !== "authenticated" ||
      this.isConsentRoute() ||
      !this.activeWorkspaceId
    ) {
      return;
    }
    this.ensureMountNodes();
    const palette = await this.ensureSearchPalette();
    palette?.open();
  }

  private async ensureSettingsPanel(): Promise<void> {
    if (this.renderSettingsFn) return;
    if (!this.settingsLoadPromise) {
      this.settingsLoadPromise = import("./settings-panel.js")
        .then((mod) => {
          this.renderSettingsFn = mod.renderSettingsPanel;
        })
        .finally(() => {
          this.settingsLoadPromise = null;
        });
    }
    await this.settingsLoadPromise;
    this.render();
  }

  private async ensureSearchPalette(): Promise<SearchPaletteController | null> {
    if (this.searchPalette) return this.searchPalette;
    if (!this.searchPalettePromise) {
      this.searchPalettePromise = import("./search-dialog.js")
        .then((mod) => {
          if (typeof document === "undefined") return null;
          const palette = new mod.SearchPaletteController({
            getContext: () => ({
              workspaceId: this.activeWorkspaceId,
              activeProjectId: this.activeProjectId,
              projects: this.projects,
              i18n: this.i18n,
            }),
            onSelectItem: (item) => {
              this.highlightedTaskId = item.task.id;
              void this.selectProject(item.task.effectiveProjectId, true, true);
            },
          });
          this.searchPalette = palette;
          this.appendChild(palette.element);
          return palette;
        })
        .finally(() => {
          this.searchPalettePromise = null;
        });
    }
    return this.searchPalettePromise;
  }

  private clearFeedback(): void {
    this.taskCreateError = "";
    this.taskCreateNotice = "";
    this.workspaceSettingsError = "";
    this.workspaceSettingsNotice = "";
    this.projectSettingsError = "";
    this.projectSettingsNotice = "";
    this.newProjectError = "";
  }

  private resetWorkspaceState(): void {
    this.workspaceDataSeq += 1;
    this.projectDataSeq += 1;
    this.activeWorkspaceId = null;
    this.activeProjectId = null;
    this.activeView = "list";
    this.projects = [];
    this.workspaceSettings = null;
    this.tasks = [];
    this.activeDevSettings = null;
    this.loadingWorkspace = false;
    this.workspaceLoadError = "";
    this.newProjectOpen = false;
    this.newProjectName = "";
    this.newProjectPrefix = "";
    this.taskTitleDraft = "";
    this.taskStatusDraft = "";
    this.highlightedTaskId = null;
    this.devPrefixDraft = "";
    this.devStartStatusDraft = "";
    this.clearFeedback();
    this.searchPalette?.destroy();
  }

  async refreshSession(): Promise<void> {
    if (typeof fetch === "undefined") return;
    const seq = ++this.sessionRequestSeq;
    try {
      const res = await fetch("/api/v1/me", { credentials: "same-origin" });
      if (seq !== this.sessionRequestSeq) return;
      if (res.ok) {
        this.sessionProfile = (await res.json()) as MeResponse;
        this.authState = "authenticated";
        this.signOutError = "";
      } else {
        this.sessionProfile = null;
        this.authState = "unauthenticated";
        this.resetWorkspaceState();
        this.render();
        return;
      }
    } catch {
      if (seq !== this.sessionRequestSeq) return;
      this.sessionProfile = null;
      this.authState = "unauthenticated";
      this.resetWorkspaceState();
      this.render();
      return;
    }

    const memberships = this.sessionProfile?.memberships ?? [];
    if (memberships.length > 0 && !this.isConsentRoute()) {
      const initial = parseRouteState();
      const validWs = memberships.find((m) => m.workspaceId === initial.workspaceId);
      if (
        !this.activeWorkspaceId ||
        !memberships.some((m) => m.workspaceId === this.activeWorkspaceId)
      ) {
        this.activeWorkspaceId = validWs
          ? validWs.workspaceId
          : memberships[0]!.workspaceId;
        if (initial.projectId) this.activeProjectId = initial.projectId;
        this.activeView = initial.view;
      }
      this.render();
      await this.loadWorkspaceData(this.activeWorkspaceId);
      return;
    }

    this.render();
  }

  async signOut(): Promise<boolean> {
    if (typeof fetch === "undefined" || this.signingOut) return false;
    this.signingOut = true;
    this.signOutError = "";
    this.render();

    try {
      const res = await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
      });
      if (res.ok || res.status === 401) {
        this.sessionRequestSeq += 1;
        this.sessionProfile = null;
        this.authState = "unauthenticated";
        this.signOutError = "";
        this.resetWorkspaceState();
        return true;
      }
      this.signOutError = this.i18n.t("auth.signOutFailed");
      return false;
    } catch {
      this.signOutError = this.i18n.t("auth.signOutFailed");
      return false;
    } finally {
      this.signingOut = false;
      this.render();
    }
  }

  private applyRouteFromLocation(): void {
    if (this.authState !== "authenticated" || !this.sessionProfile) return;
    const memberships = this.sessionProfile.memberships;
    if (memberships.length === 0) return;
    const route = parseRouteState();
    const targetWs =
      memberships.find((m) => m.workspaceId === route.workspaceId)?.workspaceId ??
      memberships[0]!.workspaceId;
    this.activeView = route.view;
    if (targetWs !== this.activeWorkspaceId) {
      this.activeWorkspaceId = targetWs;
      this.activeProjectId = route.projectId;
      void this.loadWorkspaceData(targetWs);
      return;
    }
    if (
      route.projectId &&
      route.projectId !== this.activeProjectId &&
      this.projects.some((p) => p.id === route.projectId)
    ) {
      void this.selectProject(route.projectId, false);
      return;
    }
    this.render();
  }

  private syncUrlState(): void {
    if (
      typeof window === "undefined" ||
      this.isConsentRoute() ||
      !this.activeWorkspaceId ||
      !window.history ||
      typeof window.history.replaceState !== "function"
    ) {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set("workspace", this.activeWorkspaceId);
    if (this.activeProjectId) params.set("project", this.activeProjectId);
    else params.delete("project");
    params.set("view", this.activeView);
    const nextHref = `${window.location.pathname}?${params.toString()}`;
    if (`${window.location.pathname}${window.location.search}` !== nextHref) {
      window.history.replaceState(null, "", nextHref);
    }
  }

  private async loadWorkspaceData(workspaceId: WorkspaceId): Promise<void> {
    const seq = ++this.workspaceDataSeq;
    this.loadingWorkspace = true;
    this.workspaceLoadError = "";
    this.render();

    const [projRes, wsSettingsRes] = await Promise.all([
      listProjects(workspaceId),
      getWorkspaceSettings(workspaceId),
      this.activeView === "settings" ? this.ensureSettingsPanel() : Promise.resolve(),
    ]);
    if (seq !== this.workspaceDataSeq || this.activeWorkspaceId !== workspaceId) {
      return;
    }

    this.loadingWorkspace = false;
    if (!projRes.ok) {
      this.projects = [];
      this.activeProjectId = null;
      this.tasks = [];
      this.activeDevSettings = null;
      this.workspaceLoadError = translateApiError(this.i18n, projRes.messageKey);
      this.render();
      return;
    }

    this.projects = projRes.data.projects;
    this.workspaceSettings = wsSettingsRes.ok ? wsSettingsRes.data.settings : null;
    if (!this.projects.some((p) => p.id === this.activeProjectId)) {
      this.activeProjectId = this.projects[0]?.id ?? null;
      this.tasks = [];
      this.activeDevSettings = null;
    }
    this.syncUrlState();
    this.render();

    if (this.activeProjectId) {
      await this.loadProjectData(this.activeProjectId);
    } else {
      this.tasks = [];
      this.activeDevSettings = null;
      this.render();
    }
  }

  private async loadProjectData(projectId: ProjectId): Promise<void> {
    const seq = ++this.projectDataSeq;
    const project = this.projects.find((p) => p.id === projectId) ?? null;
    if (project && !project.statuses.some((s) => s.id === this.taskStatusDraft)) {
      this.taskStatusDraft = project.statuses[0]?.id ?? "";
    }

    const [tasksRes, devRes] = await Promise.all([
      listProjectTasks(projectId),
      getProjectDevSettings(projectId),
    ]);
    if (seq !== this.projectDataSeq || this.activeProjectId !== projectId) return;

    this.tasks = tasksRes.ok ? tasksRes.data.tasks : [];
    if (devRes.ok) {
      this.activeDevSettings = devRes.data;
      this.devPrefixDraft = devRes.data.dev?.prefix ?? "";
      this.devStartStatusDraft = devRes.data.dev?.startStatusId ?? "";
    } else {
      this.activeDevSettings = null;
      this.devPrefixDraft = "";
      this.devStartStatusDraft = "";
    }
    this.searchPalette?.syncLabels();
    this.render();
  }

  private async selectWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (workspaceId === this.activeWorkspaceId) return;
    this.activeWorkspaceId = workspaceId;
    this.activeProjectId = null;
    this.tasks = [];
    this.activeDevSettings = null;
    this.newProjectOpen = false;
    this.highlightedTaskId = null;
    this.clearFeedback();
    this.syncUrlState();
    await this.loadWorkspaceData(workspaceId);
  }

  private async selectProject(
    projectId: ProjectId,
    switchToList = false,
    preserveHighlight = false,
  ): Promise<void> {
    if (projectId !== this.activeProjectId) {
      this.tasks = [];
      this.activeDevSettings = null;
      if (!preserveHighlight) this.highlightedTaskId = null;
    }
    this.activeProjectId = projectId;
    if (switchToList) this.activeView = "list";
    this.clearFeedback();
    this.syncUrlState();
    this.render();
    await this.loadProjectData(projectId);
  }

  private switchView(view: ShellView): void {
    if (this.activeView === view) return;
    this.activeView = view;
    this.clearFeedback();
    this.syncUrlState();
    this.render();
    if (view === "settings") {
      void this.ensureSettingsPanel();
      if (this.activeWorkspaceId) {
        void this.loadWorkspaceData(this.activeWorkspaceId);
      }
    }
  }

  private async handleCreateProject(): Promise<void> {
    const workspaceId = this.activeWorkspaceId;
    if (!workspaceId || this.creatingProject) return;
    const name = this.newProjectName.trim();
    if (!name) {
      this.newProjectError = this.i18n.t("error.validation");
      this.render();
      return;
    }

    let normalizedPrefix: string | null = null;
    if (this.newProjectEnableDev) {
      normalizedPrefix = normalizeDevPrefix(this.newProjectPrefix);
      if (!normalizedPrefix) {
        this.newProjectError = this.i18n.t("error.invalidDevPrefix");
        this.render();
        return;
      }
    }

    this.creatingProject = true;
    this.newProjectError = "";
    this.render();

    const createRes = await createProject(workspaceId, {
      name,
      visibility: this.newProjectVisibility,
      kind: "general",
    });
    if (!createRes.ok) {
      this.creatingProject = false;
      this.newProjectError = translateApiError(this.i18n, createRes.messageKey);
      this.render();
      return;
    }

    const created = createRes.data.project;
    if (normalizedPrefix) {
      const enableRes = await enableDevProject(created.id, {
        prefix: normalizedPrefix,
      });
      if (!enableRes.ok) {
        this.creatingProject = false;
        this.activeProjectId = created.id;
        this.newProjectError = translateApiError(this.i18n, enableRes.messageKey);
        this.syncUrlState();
        await this.loadWorkspaceData(workspaceId);
        return;
      }
    }

    this.creatingProject = false;
    this.newProjectOpen = false;
    this.newProjectName = "";
    this.newProjectPrefix = "";
    this.newProjectEnableDev = false;
    this.newProjectVisibility = "workspace";
    this.activeProjectId = created.id;
    this.activeView = "list";
    this.tasks = [];
    this.activeDevSettings = null;
    this.highlightedTaskId = null;
    this.syncUrlState();
    await this.loadWorkspaceData(workspaceId);
  }

  private async handleCreateTask(
    title: string,
    statusId: StatusId | null,
  ): Promise<void> {
    const projectId = this.activeProjectId;
    if (!projectId || this.creatingTask) return;
    this.creatingTask = true;
    this.taskCreateError = "";
    this.taskCreateNotice = "";
    this.render();

    const res = await createTask(projectId, {
      title: title.trim(),
      ...(statusId ? { statusId } : {}),
    });
    this.creatingTask = false;
    if (!res.ok) {
      this.taskCreateError = translateApiError(this.i18n, res.messageKey);
      this.render();
      return;
    }

    this.taskTitleDraft = "";
    this.taskCreateNotice = this.i18n.t("task.created");
    this.highlightedTaskId = res.data.task.id;
    await this.loadProjectData(projectId);
  }

  private async handleSaveWorkspaceSettings(devProjectsEnabled: boolean): Promise<void> {
    const workspaceId = this.activeWorkspaceId;
    if (!workspaceId || this.savingWorkspaceSettings) return;
    this.savingWorkspaceSettings = true;
    this.clearFeedback();
    this.render();

    const res = await updateWorkspaceSettings(workspaceId, { devProjectsEnabled });
    this.savingWorkspaceSettings = false;
    if (!res.ok) {
      this.workspaceSettingsError = translateApiError(this.i18n, res.messageKey);
      this.render();
      return;
    }

    this.workspaceSettings = res.data.settings;
    this.workspaceSettingsNotice = this.i18n.t("settings.saved");
    if (this.activeProjectId) await this.loadProjectData(this.activeProjectId);
    else this.render();
  }

  private async submitProjectDevSettings(
    mode: "enable" | "update",
    prefix: string,
    startStatusId: StatusId | null,
  ): Promise<void> {
    const workspaceId = this.activeWorkspaceId;
    const projectId = this.activeProjectId;
    if (!workspaceId || !projectId || this.savingProjectSettings) return;
    this.savingProjectSettings = true;
    this.clearFeedback();
    this.render();

    const res =
      mode === "enable"
        ? await enableDevProject(projectId, {
            prefix,
            ...(startStatusId ? { startStatusId } : {}),
          })
        : await updateDevProjectSettings(projectId, { prefix, startStatusId });
    this.savingProjectSettings = false;
    if (!res.ok) {
      this.projectSettingsError = translateApiError(this.i18n, res.messageKey);
      this.render();
      return;
    }

    this.projectSettingsNotice =
      mode === "enable" && "keyedCount" in res.data
        ? this.i18n.t("settings.enabledSummary", { count: res.data.keyedCount })
        : this.i18n.t("settings.saved");
    await this.loadWorkspaceData(workspaceId);
  }

  private isConsentRoute(): boolean {
    if (typeof window === "undefined") return false;
    return (
      window.location.pathname === "/oauth/consent" ||
      window.location.pathname === "/oauth/consent/"
    );
  }

  private async fetchConsentClientName(clientId: string): Promise<void> {
    if (
      typeof fetch === "undefined" ||
      !clientId ||
      this.consentClientFetchedFor === clientId
    ) {
      return;
    }
    this.consentClientFetchedFor = clientId;
    try {
      const res = await fetch(
        `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as {
        client_name?: string;
        name?: string;
      } | null;
      const name = data?.client_name ?? data?.name;
      if (typeof name === "string" && name.trim()) {
        this.consentClientName = name.trim();
        this.render();
      }
    } catch {
      // Keep client_id fallback
    }
  }

  async submitConsent(accept: boolean): Promise<void> {
    if (
      typeof fetch === "undefined" ||
      typeof window === "undefined" ||
      this.consentSubmitting
    ) {
      return;
    }
    const signedQuery = extractSignedOAuthQuery(window.location.search);
    if (!signedQuery) {
      this.consentError = this.i18n.t("oauth.consentInvalid");
      this.render();
      return;
    }

    this.consentSubmitting = true;
    this.consentError = "";
    this.render();

    let redirecting = false;
    try {
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: signedQuery }),
      });
      if (!res.ok) {
        this.consentError = this.i18n.t("oauth.consentError");
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        redirect_uri?: string;
        url?: string;
      } | null;
      const target = data?.redirect_uri ?? data?.url;
      if (typeof target === "string" && isSafeRedirectUrl(target)) {
        redirecting = true;
        window.location.assign(target);
        return;
      }
      this.consentError = this.i18n.t("oauth.consentError");
    } catch {
      this.consentError = this.i18n.t("oauth.consentError");
    } finally {
      if (!redirecting) this.consentSubmitting = false;
      this.render();
    }
  }

  private ensureMountNodes(): HTMLDivElement | null {
    if (typeof document === "undefined") return null;
    if (!this.shellRoot || this.shellRoot.parentNode !== this) {
      this.shellRoot = el("div", { cls: "prood-shell-root" });
      this.appendChild(this.shellRoot);
    }
    if (this.searchPalette && this.searchPalette.element.parentNode !== this) {
      this.appendChild(this.searchPalette.element);
    }
    return this.shellRoot;
  }

  private render(): void {
    const root = this.ensureMountNodes();
    if (!root) return;

    const { t, formatTaskCount } = this.i18n;
    const isConsent = this.isConsentRoute();
    const memberships = this.sessionProfile?.memberships ?? [];
    const activeMembership =
      memberships.find((m) => m.workspaceId === this.activeWorkspaceId) ?? null;

    root.innerHTML = "";

    const wsSelect =
      this.authState === "authenticated" && !isConsent && memberships.length > 0
        ? el(
            "select",
            {
              cls: "prood-select prood-ws-select",
              attrs: {
                "aria-label": t("aria.workspaceSelect"),
                "data-workspace-select": true,
              },
              on: {
                change: (e) =>
                  void this.selectWorkspace(
                    (e.target as HTMLSelectElement).value as WorkspaceId,
                  ),
              },
            },
            ...memberships.map((m) =>
              el("option", {
                val: m.workspaceId,
                selected: m.workspaceId === this.activeWorkspaceId,
                text: t("auth.workspaceItem", {
                  name: m.workspaceName,
                  slug: m.workspaceSlug,
                  role: t(ROLE_LABEL_KEYS[m.role]),
                }),
              }),
            ),
          )
        : null;

    const nav = el(
      "nav",
      { cls: "prood-nav", attrs: { "aria-label": t("aria.mainNavigation") } },
      ...(this.authState === "authenticated" && !isConsent && memberships.length > 0
        ? (["list", "settings"] as const).map((view) =>
            el("button", {
              cls:
                this.activeView === view
                  ? "prood-nav-btn is-active"
                  : "prood-nav-btn",
              attrs: {
                "data-nav-view": view,
                ...(this.activeView === view ? { "aria-current": "page" } : {}),
              },
              text: t(`nav.${view}`),
              on: { click: () => this.switchView(view) },
            }),
          )
        : (["nav.list", "nav.board", "nav.search"] as const).map((k) =>
            el("span", { cls: "prood-nav-item", text: t(k) }),
          )),
    );

    const actions = el(
      "div",
      { cls: "prood-actions" },
      this.authState === "authenticated" &&
        this.sessionProfile &&
        !isConsent &&
        memberships.length > 0
        ? el(
            "button",
            {
              type: "button",
              cls: "prood-btn-secondary",
              attrs: { "data-open-search": true },
              on: { click: () => void this.openSearch() },
            },
            `${t("nav.search")} `,
            el("kbd", { cls: "prood-kbd", text: t("nav.searchShortcut") }),
          )
        : null,
      this.authState === "authenticated" && this.sessionProfile
        ? el("button", {
            cls: "prood-btn-secondary",
            disabled: this.signingOut,
            text: this.signingOut ? t("auth.signingOut") : t("auth.signOutButton"),
            on: { click: () => void this.signOut() },
          })
        : null,
      this.authState === "authenticated" &&
        this.sessionProfile &&
        !isConsent &&
        memberships.length === 0
        ? el("button", {
            cls: "prood-btn-primary",
            text: t("action.createTask"),
          })
        : null,
    );

    const header = el(
      "header",
      { cls: "prood-header" },
      el(
        "div",
        { cls: "prood-brand-group" },
        el("div", { cls: "prood-brand", text: t("app.name") }),
        wsSelect,
      ),
      nav,
      actions,
    );

    const main = el("main", { cls: "prood-main" });

    if (this.authState === "loading") {
      main.appendChild(el("p", { cls: "prood-count", text: t("auth.loading") }));
      root.append(header, main);
      return;
    }

    if (this.authState === "unauthenticated") {
      const loginForm = new ProodLoginFormElement();
      loginForm.setI18n(this.i18n);
      main.appendChild(loginForm);
      root.append(header, main);
      return;
    }

    if (this.sessionProfile) {
      if (this.signOutError) {
        main.appendChild(
          el("p", {
            cls: "prood-auth-feedback",
            attrs: { role: "alert", "data-signout-error": true },
            text: this.signOutError,
          }),
        );
      }

      if (isConsent) {
        main.appendChild(this.renderConsentScreen());
        root.append(header, main);
        return;
      }

      main.appendChild(
        el("p", {
          cls: "prood-identity-bar",
          text: t("auth.signedInAs", {
            name: this.sessionProfile.user.displayName,
            email: this.sessionProfile.user.email,
          }),
        }),
      );

      if (memberships.length === 0) {
        main.setAttribute("aria-label", t("aria.taskList"));
        main.append(
          el(
            "section",
            {
              cls: "prood-workspaces",
              attrs: { "aria-label": t("aria.workspaces") },
            },
            el("h2", { cls: "prood-section-heading", text: t("auth.workspacesHeading") }),
            el("p", { cls: "prood-count", text: t("auth.noWorkspaces") }),
          ),
          el("p", { cls: "prood-count", text: formatTaskCount(0) }),
          el(
            "section",
            { cls: "prood-empty" },
            el("h1", { text: t("empty.tasks.title") }),
            el("p", { text: t("empty.tasks.description") }),
          ),
        );
        root.append(header, main);
        return;
      }

      const content = el("div", { cls: "prood-content-pane" });
      if (this.workspaceLoadError) {
        content.appendChild(alertBanner(this.workspaceLoadError)!);
      } else if (this.loadingWorkspace && this.projects.length === 0) {
        content.appendChild(el("p", { cls: "prood-count", text: t("auth.loading") }));
      } else if (this.activeView === "settings") {
        const activeProj =
          this.projects.find((p) => p.id === this.activeProjectId) ?? null;
        if (!this.renderSettingsFn) {
          void this.ensureSettingsPanel();
          content.appendChild(el("p", { cls: "prood-count", text: t("auth.loading") }));
        } else {
          content.appendChild(
            this.renderSettingsFn({
              workspaceRole: activeMembership?.role ?? null,
              workspaceSettings: this.workspaceSettings,
              project: activeProj,
              devSettings: this.activeDevSettings,
              i18n: this.i18n,
              savingWorkspace: this.savingWorkspaceSettings,
              savingProject: this.savingProjectSettings,
              workspaceNotice: this.workspaceSettingsNotice,
              workspaceError: this.workspaceSettingsError,
              projectNotice: this.projectSettingsNotice,
              projectError: this.projectSettingsError,
              prefixDraft: this.devPrefixDraft,
              startStatusDraft: this.devStartStatusDraft,
              onPrefixDraftChange: (v) => {
                this.devPrefixDraft = v;
              },
              onStartStatusDraftChange: (v) => {
                this.devStartStatusDraft = v;
              },
              onSaveWorkspaceSettings: (v) => void this.handleSaveWorkspaceSettings(v),
              onEnableDevProject: (p, s) =>
                void this.submitProjectDevSettings("enable", p, s),
              onUpdateDevProjectSettings: (p, s) =>
                void this.submitProjectDevSettings("update", p, s),
            }),
          );
        }
      } else {
        const activeProj =
          this.projects.find((p) => p.id === this.activeProjectId) ?? null;
        content.appendChild(
          activeProj
            ? renderTaskListView({
                project: activeProj,
                tasks: this.tasks,
                i18n: this.i18n,
                draftTitle: this.taskTitleDraft,
                draftStatusId: this.taskStatusDraft,
                creating: this.creatingTask,
                createError: this.taskCreateError,
                createNotice: this.taskCreateNotice,
                highlightedTaskId: this.highlightedTaskId,
                onDraftChange: (title, st) => {
                  this.taskTitleDraft = title;
                  this.taskStatusDraft = st;
                },
                onSubmitCreate: (title, st) =>
                  void this.handleCreateTask(title, st),
              })
            : el(
                "section",
                { cls: "prood-empty" },
                el("p", { text: t("project.selectPrompt") }),
              ),
        );
      }

      main.appendChild(
        el(
          "div",
          { cls: "prood-workspace-layout" },
          this.renderSidebar(activeMembership?.role ?? null),
          content,
        ),
      );
    }

    root.append(header, main);
  }

  private renderSidebar(wsRole: WorkspaceRole | null): HTMLElement {
    const { t } = this.i18n;
    const sidebar = el(
      "aside",
      { cls: "prood-sidebar", attrs: { "aria-label": t("aria.projectList") } },
      el(
        "div",
        { cls: "prood-sidebar-head" },
        el("h2", { cls: "prood-section-heading", text: t("nav.projects") }),
        wsRole && wsRole !== "viewer"
          ? el("button", {
              cls: "prood-btn-secondary prood-btn-compact",
              attrs: { "data-toggle-new-project": true },
              text: t("action.newProject"),
              on: {
                click: () => {
                  this.newProjectOpen = !this.newProjectOpen;
                  this.newProjectError = "";
                  this.render();
                },
              },
            })
          : null,
      ),
    );

    if (this.newProjectOpen && wsRole && wsRole !== "viewer") {
      const nameInput = el("input", {
        id: "prood-new-project-name",
        type: "text",
        required: true,
        cls: "prood-input",
        placeholder: t("project.namePlaceholder"),
        val: this.newProjectName,
        attrs: { "data-new-project-name": true },
        on: {
          input: () => {
            this.newProjectName = nameInput.value;
          },
        },
      });
      const visSelect = el(
        "select",
        {
          id: "prood-new-project-vis",
          cls: "prood-select",
          attrs: { "data-new-project-visibility": true },
        },
        ...(["workspace", "private"] as const).map((v) =>
          el("option", {
            val: v,
            text: t(`project.visibility.${v}`),
            selected: this.newProjectVisibility === v,
          }),
        ),
      );
      visSelect.addEventListener("change", () => {
        this.newProjectVisibility = visSelect.value as ProjectVisibility;
      });

      let devToggleRow: HTMLElement | null = null;
      let prefixRow: HTMLElement | null = null;
      if (this.workspaceSettings?.devProjectsEnabled) {
        const prefixInput = el("input", {
          id: "prood-new-project-prefix",
          type: "text",
          cls: "prood-input prood-mono",
          placeholder: t("settings.prefixPlaceholder"),
          val: this.newProjectPrefix,
          disabled: !this.newProjectEnableDev,
          required: this.newProjectEnableDev,
          attrs: { minlength: 2, maxlength: 10, "data-new-project-prefix": true },
          on: {
            input: () => {
              this.newProjectPrefix = prefixInput.value;
            },
          },
        });
        const devCheck = el("input", {
          type: "checkbox",
          checked: this.newProjectEnableDev,
          attrs: { "data-new-project-dev-toggle": true },
          on: {
            change: () => {
              this.newProjectEnableDev = devCheck.checked;
              prefixInput.disabled = !devCheck.checked;
              prefixInput.required = devCheck.checked;
            },
          },
        });
        devToggleRow = el(
          "label",
          { cls: "prood-checkbox-row" },
          devCheck,
          el("span", { text: t("project.enableDevCheckbox") }),
        );
        prefixRow = fieldGroup(
          "prood-new-project-prefix",
          t("settings.prefixLabel"),
          prefixInput,
        );
      }

      sidebar.appendChild(
        el(
          "form",
          {
            cls: "prood-sidebar-form",
            attrs: { "data-new-project-form": true },
            on: {
              submit: (e) => {
                e.preventDefault();
                void this.handleCreateProject();
              },
            },
          },
          fieldGroup("prood-new-project-name", t("project.nameLabel"), nameInput),
          fieldGroup(
            "prood-new-project-vis",
            t("project.visibilityLabel"),
            visSelect,
          ),
          devToggleRow,
          prefixRow,
          alertBanner(this.newProjectError),
          el(
            "div",
            { cls: "prood-actions" },
            el("button", {
              type: "submit",
              cls: "prood-btn-primary",
              disabled: this.creatingProject,
              attrs: { "data-new-project-submit": true },
              text: t("project.createTitle"),
            }),
            el("button", {
              cls: "prood-btn-secondary",
              text: t("action.cancel"),
              on: {
                click: () => {
                  this.newProjectOpen = false;
                  this.newProjectError = "";
                  this.render();
                },
              },
            }),
          ),
        ),
      );
    }

    if (this.projects.length === 0) {
      sidebar.appendChild(
        el("p", { cls: "prood-count", text: t("project.empty") }),
      );
      return sidebar;
    }

    sidebar.appendChild(
      el(
        "ul",
        { cls: "prood-project-list" },
        ...this.projects.map((proj) => {
          const isSelected = proj.id === this.activeProjectId;
          return el(
            "li",
            {},
            el(
              "button",
              {
                type: "button",
                cls: isSelected ? "prood-project-btn is-active" : "prood-project-btn",
                attrs: {
                  "data-project-id": proj.id,
                  ...(isSelected ? { "aria-current": "true" } : {}),
                },
                on: { click: () => void this.selectProject(proj.id, false) },
              },
              el("span", { cls: "prood-project-name", text: proj.name }),
              el("span", {
                cls: "prood-project-meta",
                text: proj.devSettings
                  ? proj.devSettings.prefix
                  : t(
                      proj.kind === "development"
                        ? "project.kind.development"
                        : "project.kind.general",
                    ),
              }),
            ),
          );
        }),
      ),
    );
    return sidebar;
  }

  private renderConsentScreen(): HTMLElement {
    const { t } = this.i18n;
    const card = el(
      "div",
      { cls: "prood-login-form", attrs: { "aria-label": t("aria.consentForm") } },
      el("h1", { cls: "prood-login-title", text: t("oauth.consentTitle") }),
    );
    const signedQuery = extractSignedOAuthQuery(window.location.search);
    if (!signedQuery) {
      card.append(
        alertBanner(t("oauth.consentInvalid"))!,
        el("a", {
          cls: "prood-btn-secondary",
          attrs: { href: "/" },
          text: t("oauth.backHome"),
        }),
      );
      return el("section", { cls: "prood-login-wrap" }, card);
    }

    const params = new URLSearchParams(signedQuery);
    const clientId = params.get("client_id") ?? "";
    void this.fetchConsentClientName(clientId);

    const resource = params.get("resource");
    const scopes = params.get("scope");
    const consentItems = [
      el("p", { cls: "prood-login-subtitle", text: t("oauth.consentDescription") }),
      el("p", {
        cls: "prood-count",
        text: t("oauth.consentClient", {
          client: this.consentClientName ?? clientId,
        }),
      }),
      resource
        ? el("p", {
            cls: "prood-count",
            text: t("oauth.consentResource", { resource }),
          })
        : null,
      scopes
        ? el("p", {
            cls: "prood-count",
            text: t("oauth.consentScopes", { scopes }),
          })
        : null,
      alertBanner(this.consentError),
      el(
        "div",
        { cls: "prood-actions" },
        el("button", {
          type: "button",
          cls: "prood-btn-primary",
          disabled: this.consentSubmitting,
          text: t("oauth.consentApprove"),
          on: { click: () => void this.submitConsent(true) },
        }),
        el("button", {
          type: "button",
          cls: "prood-btn-secondary",
          disabled: this.consentSubmitting,
          text: t("oauth.consentDeny"),
          on: { click: () => void this.submitConsent(false) },
        }),
      ),
    ].filter((n): n is NonNullable<typeof n> => n !== null);
    card.append(...consentItems);
    return el("section", { cls: "prood-login-wrap" }, card);
  }
}

export function registerProodShell(): void {
  if (typeof customElements !== "undefined" && !customElements.get("prood-shell")) {
    customElements.define("prood-shell", ProodShellElement);
  }
}
