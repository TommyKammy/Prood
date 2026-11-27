import { createI18n, type I18nInstance } from "./i18n/messages.js";

const BaseElement =
  typeof HTMLElement !== "undefined" ? HTMLElement : (class {} as typeof HTMLElement);

export class ProodShellElement extends BaseElement {
  private i18n: I18nInstance = createI18n();

  connectedCallback(): void {
    this.render();
  }

  setI18n(i18n: I18nInstance): void {
    this.i18n = i18n;
    this.render();
  }

  private render(): void {
    if (typeof document === "undefined") {
      return;
    }
    const { t, formatTaskCount } = this.i18n;

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

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "prood-btn-primary";
    createBtn.textContent = t("action.createTask");
    actions.appendChild(createBtn);

    header.append(brand, nav, actions);

    const main = document.createElement("main");
    main.className = "prood-main";
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
