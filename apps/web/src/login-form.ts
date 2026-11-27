import { createI18n, type I18nInstance } from "./i18n/messages.js";

const BaseElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as typeof HTMLElement);

export function extractSignedOAuthQuery(search: string): string | undefined {
  const trimmed = search.replace(/^\?/, "");
  if (!trimmed) {
    return undefined;
  }
  const params = new URLSearchParams(trimmed);
  return params.has("sig") && params.has("client_id") ? trimmed : undefined;
}

export class ProodLoginFormElement extends BaseElement {
  private i18n: I18nInstance = createI18n();
  private email = "";
  private password = "";
  private errorMessage = "";
  private busy = false;
  private inFlight = false;
  private searchOverride?: string;
  private redirectHandler?: (url: string) => void;

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

  setOAuthContext(context: {
    search?: string;
    onRedirect?: (url: string) => void;
  }): void {
    this.searchOverride = context.search;
    this.redirectHandler = context.onRedirect;
  }

  private render(): void {
    if (typeof document === "undefined") {
      return;
    }
    const { t } = this.i18n;
    this.innerHTML = "";

    const wrapper = document.createElement("div");
    wrapper.className = "prood-login-wrap";

    const form = document.createElement("form");
    form.className = "prood-login-form";
    form.setAttribute("data-login-form", "");
    form.setAttribute("aria-label", t("aria.signInForm"));
    form.setAttribute("aria-busy", String(this.busy));

    const headingGroup = document.createElement("div");
    const title = document.createElement("h1");
    title.className = "prood-login-title";
    title.textContent = t("auth.signInTitle");

    const subtitle = document.createElement("p");
    subtitle.className = "prood-login-subtitle";
    subtitle.textContent = t("auth.signInSubtitle");
    headingGroup.append(title, subtitle);

    const emailGroup = document.createElement("div");
    emailGroup.className = "prood-field";
    const emailLabel = document.createElement("label");
    emailLabel.htmlFor = "prood-login-email";
    emailLabel.className = "prood-label";
    emailLabel.textContent = t("auth.emailLabel");
    const emailInput = document.createElement("input");
    emailInput.id = "prood-login-email";
    emailInput.name = "email";
    emailInput.type = "email";
    emailInput.required = true;
    emailInput.autocomplete = "email";
    emailInput.placeholder = t("auth.emailPlaceholder");
    emailInput.className = "prood-input";
    emailInput.value = this.email;
    emailInput.addEventListener("input", () => {
      this.email = emailInput.value;
    });
    emailGroup.append(emailLabel, emailInput);

    const passwordGroup = document.createElement("div");
    passwordGroup.className = "prood-field";
    const passwordLabel = document.createElement("label");
    passwordLabel.htmlFor = "prood-login-password";
    passwordLabel.className = "prood-label";
    passwordLabel.textContent = t("auth.passwordLabel");
    const passwordInput = document.createElement("input");
    passwordInput.id = "prood-login-password";
    passwordInput.name = "password";
    passwordInput.type = "password";
    passwordInput.required = true;
    passwordInput.autocomplete = "current-password";
    passwordInput.placeholder = t("auth.passwordPlaceholder");
    passwordInput.className = "prood-input";
    passwordInput.value = this.password;
    passwordInput.addEventListener("input", () => {
      this.password = passwordInput.value;
    });
    passwordGroup.append(passwordLabel, passwordInput);

    form.append(headingGroup, emailGroup, passwordGroup);

    if (this.errorMessage) {
      const feedback = document.createElement("p");
      feedback.className = "prood-auth-feedback";
      feedback.setAttribute("role", "alert");
      feedback.setAttribute("data-auth-feedback", "");
      feedback.textContent = this.errorMessage;
      form.appendChild(feedback);
    }

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.disabled = this.busy;
    submitBtn.className = "prood-btn-primary prood-btn-full";
    submitBtn.textContent = this.busy ? t("auth.signingIn") : t("auth.signInButton");
    form.appendChild(submitBtn);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    wrapper.appendChild(form);
    this.appendChild(wrapper);
  }

  async submit(): Promise<void> {
    if (typeof fetch === "undefined" || this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.busy = true;
    this.errorMessage = "";
    this.render();

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

      this.errorMessage = this.i18n.t("auth.invalidCredentials");
    } catch {
      this.errorMessage = this.i18n.t("auth.networkError");
    } finally {
      this.inFlight = false;
      this.busy = false;
      this.render();
    }
  }
}

export function registerProodLoginForm(): void {
  if (typeof customElements !== "undefined" && !customElements.get("prood-login-form")) {
    customElements.define("prood-login-form", ProodLoginFormElement);
  }
}
