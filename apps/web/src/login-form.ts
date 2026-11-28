import { alertBanner, el, fieldGroup } from "./dom.js";
import { createI18n, type I18nInstance } from "./i18n/messages.js";

const BaseElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as typeof HTMLElement);

let nextLoginFormId = 0;

export function extractSignedOAuthQuery(search: string): string | undefined {
  const trimmed = search.replace(/^\?/, "");
  if (!trimmed) return undefined;
  const params = new URLSearchParams(trimmed);
  return params.has("sig") && params.has("client_id") ? trimmed : undefined;
}

export function isSafeRedirectUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export class ProodLoginFormElement extends BaseElement {
  private readonly instanceId = ++nextLoginFormId;
  private i18n: I18nInstance = createI18n();
  private email = "";
  private password = "";
  private errorMessage = "";
  private busy = false;
  private inFlight = false;
  private searchOverride?: string;
  private redirectHandler?: (url: string) => void;
  private emailInputEl: HTMLInputElement | null = null;
  private passwordInputEl: HTMLInputElement | null = null;

  connectedCallback(): void {
    this.render();
  }

  setI18n(i18n: I18nInstance): void {
    this.i18n = i18n;
    this.render();
  }

  setCredentials(email: string, password: string): void {
    this.email = email;
    this.password = password;
  }

  getErrorMessage(): string {
    return this.errorMessage;
  }

  setOAuthContext(context: {
    search?: string;
    onRedirect?: (url: string) => void;
  }): void {
    this.searchOverride = context.search;
    this.redirectHandler = context.onRedirect;
  }

  private render(): void {
    if (typeof document === "undefined") return;
    const { t } = this.i18n;
    this.innerHTML = "";

    const emailId = `prood-login-email-${this.instanceId}`;
    const emailInput = el("input", {
      id: emailId,
      type: "email",
      required: true,
      cls: "prood-input",
      placeholder: t("auth.emailPlaceholder"),
      val: this.email,
      attrs: { name: "email", autocomplete: "email" },
      on: { input: () => (this.email = emailInput.value) },
    });
    this.emailInputEl = emailInput;

    const passwordId = `prood-login-password-${this.instanceId}`;
    const passwordInput = el("input", {
      id: passwordId,
      type: "password",
      required: true,
      cls: "prood-input",
      placeholder: t("auth.passwordPlaceholder"),
      val: this.password,
      attrs: { name: "password", autocomplete: "current-password" },
      on: { input: () => (this.password = passwordInput.value) },
    });
    this.passwordInputEl = passwordInput;

    const feedback = alertBanner(this.errorMessage);
    if (feedback) feedback.setAttribute("data-auth-feedback", "");

    const form = el(
      "form",
      {
        cls: "prood-login-form",
        attrs: {
          "data-login-form": true,
          "aria-label": t("aria.signInForm"),
          "aria-busy": String(this.busy),
        },
        on: {
          submit: (event) => {
            event.preventDefault();
            if (this.emailInputEl) this.email = this.emailInputEl.value;
            if (this.passwordInputEl) this.password = this.passwordInputEl.value;
            void this.submit();
          },
        },
      },
      el(
        "div",
        {},
        el("h1", { cls: "prood-login-title", text: t("auth.signInTitle") }),
        el("p", { cls: "prood-login-subtitle", text: t("auth.signInSubtitle") }),
      ),
      fieldGroup(emailId, t("auth.emailLabel"), emailInput),
      fieldGroup(passwordId, t("auth.passwordLabel"), passwordInput),
      feedback,
      el("button", {
        type: "submit",
        disabled: this.busy,
        cls: "prood-btn-primary prood-btn-full",
        text: this.busy ? t("auth.signingIn") : t("auth.signInButton"),
      }),
    );

    this.appendChild(el("div", { cls: "prood-login-wrap" }, form));
  }

  async submit(): Promise<void> {
    if (typeof fetch === "undefined" || this.inFlight) return;
    this.inFlight = true;
    this.busy = true;
    this.errorMessage = "";
    this.render();

    let redirecting = false;
    try {
      const search =
        this.searchOverride ??
        (typeof window !== "undefined" ? window.location.search : "");
      const oauthQuery = extractSignedOAuthQuery(search);

      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: this.email,
          password: this.password,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        }),
      });

      if (res.ok) {
        this.password = "";
        const data = (await res.json().catch(() => null)) as {
          redirect?: boolean;
          url?: string;
        } | null;
        if (data?.redirect === true && typeof data.url === "string") {
          if (!isSafeRedirectUrl(data.url)) {
            this.errorMessage = this.i18n.t("error.generic");
            return;
          }
          redirecting = true;
          if (this.redirectHandler) {
            this.redirectHandler(data.url);
          } else if (typeof window !== "undefined") {
            window.location.assign(data.url);
          }
          return;
        }
        if (
          typeof this.dispatchEvent === "function" &&
          typeof CustomEvent !== "undefined"
        ) {
          this.dispatchEvent(new CustomEvent("prood-authenticated", { bubbles: true }));
        }
        return;
      }

      const errData = (await res.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;
      if (
        res.status === 400 &&
        (errData?.error === "invalid_signature" || errData?.code === "invalid_signature")
      ) {
        this.errorMessage = this.i18n.t("auth.oauthQueryExpired");
      } else if (res.status >= 500) {
        this.errorMessage = this.i18n.t("auth.serverError");
      } else {
        this.errorMessage = this.i18n.t("auth.invalidCredentials");
      }
    } catch {
      this.errorMessage = this.i18n.t("auth.networkError");
    } finally {
      this.inFlight = false;
      if (!redirecting) this.busy = false;
      this.render();
    }
  }
}

export function registerProodLoginForm(): void {
  if (typeof customElements !== "undefined" && !customElements.get("prood-login-form")) {
    customElements.define("prood-login-form", ProodLoginFormElement);
  }
}
