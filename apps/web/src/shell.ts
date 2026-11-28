import type { MeResponse } from "@prood/contracts";
import type { WorkspaceRole } from "@prood/domain";
import { createI18n, type I18nInstance } from "./i18n/messages.js";
import {
  extractSignedOAuthQuery,
  isSafeRedirectUrl,
  ProodLoginFormElement,
} from "./login-form.js";

const BaseElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as typeof HTMLElement);

export type ShellAuthState = "loading" | "authenticated" | "unauthenticated";

const ROLE_LABEL_KEYS: Record<WorkspaceRole, "role.admin" | "role.member" | "role.viewer"> = {
  admin: "role.admin",
  member: "role.member",
  viewer: "role.viewer",
};

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
  private listenersController: AbortController | null = null;

  connectedCallback(): void {
    this.listenersController?.abort();
    const controller = new AbortController();
    this.listenersController = controller;

    this.addEventListener(
      "prood-authenticated",
      () => {
        void this.refreshSession();
      },
      { signal: controller.signal },
    );

    if (typeof window !== "undefined") {
      window.addEventListener(
        "pageshow",
        (event) => {
          if ((event as PageTransitionEvent).persisted) {
            void this.refreshSession();
          }
        },
        { signal: controller.signal },
      );
      window.addEventListener(
        "popstate",
        () => {
          this.render();
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
  }

  setI18n(i18n: I18nInstance): void {
    this.i18n = i18n;
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = i18n.getLocale();
    }
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

  async refreshSession(): Promise<void> {
    if (typeof fetch === "undefined") {
      return;
    }
    const seq = ++this.sessionRequestSeq;
    try {
      const res = await fetch("/api/v1/me", { credentials: "same-origin" });
      if (seq !== this.sessionRequestSeq) {
        return;
      }
      if (res.ok) {
        this.sessionProfile = (await res.json()) as MeResponse;
        this.authState = "authenticated";
        this.signOutError = "";
      } else {
        this.sessionProfile = null;
        this.authState = "unauthenticated";
      }
    } catch {
      if (seq !== this.sessionRequestSeq) {
        return;
      }
      this.sessionProfile = null;
      this.authState = "unauthenticated";
    }
    this.render();
  }

  async signOut(): Promise<boolean> {
    if (typeof fetch === "undefined" || this.signingOut) {
      return false;
    }
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

  private isConsentRoute(): boolean {
    if (typeof window === "undefined") {
      return false;
    }
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
      if (!res.ok) {
        return;
      }
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
      // Keep client_id fallback display
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
      if (!redirecting) {
        this.consentSubmitting = false;
      }
      this.render();
    }
  }

  private render(): void {
    if (typeof document === "undefined") {
      return;
    }
    const { t, formatTaskCount } = this.i18n;
    const isConsent = this.isConsentRoute();

    this.innerHTML = "";

    const header = document.createElement("header");
    header.className = "prood-header";

    const brand = document.createElement("div");
    brand.className = "prood-brand";
    brand.textContent = t("app.name");

    const nav = document.createElement("nav");
    nav.className = "prood-nav";
    nav.setAttribute("aria-label", t("aria.mainNavigation"));

    for (const key of ["nav.list", "nav.board", "nav.search"] as const) {
      const item = document.createElement("span");
      item.className = "prood-nav-item";
      item.textContent = t(key);
      nav.appendChild(item);
    }

    const actions = document.createElement("div");
    actions.className = "prood-actions";

    if (this.authState === "authenticated" && this.sessionProfile) {
      const signOutBtn = document.createElement("button");
      signOutBtn.type = "button";
      signOutBtn.className = "prood-btn-secondary";
      signOutBtn.disabled = this.signingOut;
      signOutBtn.textContent = this.signingOut
        ? t("auth.signingOut")
        : t("auth.signOutButton");
      signOutBtn.addEventListener("click", () => {
        void this.signOut();
      });
      actions.appendChild(signOutBtn);

      if (!isConsent) {
        const createBtn = document.createElement("button");
        createBtn.type = "button";
        createBtn.className = "prood-btn-primary";
        createBtn.textContent = t("action.createTask");
        actions.appendChild(createBtn);
      }
    }

    header.append(brand, nav, actions);

    const main = document.createElement("main");
    main.className = "prood-main";

    if (this.authState === "loading") {
      const loadingEl = document.createElement("p");
      loadingEl.className = "prood-count";
      loadingEl.textContent = t("auth.loading");
      main.appendChild(loadingEl);
      this.append(header, main);
      return;
    }

    if (this.authState === "unauthenticated") {
      const loginForm = new ProodLoginFormElement();
      loginForm.setI18n(this.i18n);
      main.appendChild(loginForm);
      this.append(header, main);
      return;
    }

    if (this.authState === "authenticated" && this.sessionProfile) {
      if (this.signOutError) {
        const errorBanner = document.createElement("p");
        errorBanner.className = "prood-auth-feedback";
        errorBanner.setAttribute("role", "alert");
        errorBanner.setAttribute("data-signout-error", "");
        errorBanner.textContent = this.signOutError;
        main.appendChild(errorBanner);
      }

      if (isConsent) {
        const consentWrap = document.createElement("section");
        consentWrap.className = "prood-login-wrap";

        const consentCard = document.createElement("div");
        consentCard.className = "prood-login-form";
        consentCard.setAttribute("aria-label", t("aria.consentForm"));

        const title = document.createElement("h1");
        title.className = "prood-login-title";
        title.textContent = t("oauth.consentTitle");

        const signedQuery = extractSignedOAuthQuery(window.location.search);
        if (!signedQuery) {
          const invalidEl = document.createElement("p");
          invalidEl.className = "prood-auth-feedback";
          invalidEl.setAttribute("role", "alert");
          invalidEl.textContent = t("oauth.consentInvalid");

          const backLink = document.createElement("a");
          backLink.href = "/";
          backLink.className = "prood-btn-secondary";
          backLink.textContent = t("oauth.backHome");

          consentCard.append(title, invalidEl, backLink);
          consentWrap.appendChild(consentCard);
          main.appendChild(consentWrap);
          this.append(header, main);
          return;
        }

        const params = new URLSearchParams(signedQuery);
        const clientId = params.get("client_id") ?? "";
        void this.fetchConsentClientName(clientId);

        const desc = document.createElement("p");
        desc.className = "prood-login-subtitle";
        desc.textContent = t("oauth.consentDescription");

        const clientEl = document.createElement("p");
        clientEl.className = "prood-count";
        clientEl.textContent = t("oauth.consentClient", {
          client: this.consentClientName ?? clientId,
        });

        consentCard.append(title, desc, clientEl);

        const resourceParam = params.get("resource");
        if (resourceParam) {
          const resourceEl = document.createElement("p");
          resourceEl.className = "prood-count";
          resourceEl.textContent = t("oauth.consentResource", {
            resource: resourceParam,
          });
          consentCard.appendChild(resourceEl);
        }

        const scopes = params.get("scope") ?? "";
        if (scopes) {
          const scopeText = document.createElement("p");
          scopeText.className = "prood-count";
          scopeText.textContent = t("oauth.consentScopes", { scopes });
          consentCard.appendChild(scopeText);
        }

        if (this.consentError) {
          const errEl = document.createElement("p");
          errEl.className = "prood-auth-feedback";
          errEl.setAttribute("role", "alert");
          errEl.textContent = this.consentError;
          consentCard.appendChild(errEl);
        }

        const btnRow = document.createElement("div");
        btnRow.className = "prood-actions";

        const approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "prood-btn-primary";
        approveBtn.disabled = this.consentSubmitting;
        approveBtn.textContent = t("oauth.consentApprove");
        approveBtn.addEventListener("click", () => {
          void this.submitConsent(true);
        });

        const denyBtn = document.createElement("button");
        denyBtn.type = "button";
        denyBtn.className = "prood-btn-secondary";
        denyBtn.disabled = this.consentSubmitting;
        denyBtn.textContent = t("oauth.consentDeny");
        denyBtn.addEventListener("click", () => {
          void this.submitConsent(false);
        });

        btnRow.append(approveBtn, denyBtn);
        consentCard.appendChild(btnRow);
        consentWrap.appendChild(consentCard);
        main.appendChild(consentWrap);
        this.append(header, main);
        return;
      }

      const identityBar = document.createElement("p");
      identityBar.className = "prood-identity-bar";
      identityBar.textContent = t("auth.signedInAs", {
        name: this.sessionProfile.user.displayName,
        email: this.sessionProfile.user.email,
      });

      const wsSection = document.createElement("section");
      wsSection.className = "prood-workspaces";
      wsSection.setAttribute("aria-label", t("aria.workspaces"));

      const wsHeading = document.createElement("h2");
      wsHeading.className = "prood-section-heading";
      wsHeading.textContent = t("auth.workspacesHeading");
      wsSection.appendChild(wsHeading);

      if (this.sessionProfile.memberships.length === 0) {
        const noWs = document.createElement("p");
        noWs.className = "prood-count";
        noWs.textContent = t("auth.noWorkspaces");
        wsSection.appendChild(noWs);
      } else {
        const list = document.createElement("ul");
        list.className = "prood-workspace-list";
        for (const membership of this.sessionProfile.memberships) {
          const li = document.createElement("li");
          li.textContent = t("auth.workspaceItem", {
            name: membership.workspaceName,
            slug: membership.workspaceSlug,
            role: t(ROLE_LABEL_KEYS[membership.role]),
          });
          const automation = document.createElement("a");
          automation.href =
            "/automation?workspace=" + encodeURIComponent(membership.workspaceId);
          automation.textContent = "Automation";
          li.append(" · ", automation);
          list.appendChild(li);
        }
        wsSection.appendChild(list);
      }

      main.append(identityBar, wsSection);
    }

    main.setAttribute("aria-label", t("aria.taskList"));

    const countEl = document.createElement("p");
    countEl.className = "prood-count";
    countEl.textContent = formatTaskCount(0);

    const emptyEl = document.createElement("section");
    emptyEl.className = "prood-empty";

    const emptyTitle = document.createElement("h1");
    emptyTitle.textContent = t("empty.tasks.title");

    const emptyDesc = document.createElement("p");
    emptyDesc.textContent = t("empty.tasks.description");

    emptyEl.append(emptyTitle, emptyDesc);
    main.append(countEl, emptyEl);

    this.append(header, main);
  }
}

export function registerProodShell(): void {
  if (typeof customElements !== "undefined" && !customElements.get("prood-shell")) {
    customElements.define("prood-shell", ProodShellElement);
  }
}
