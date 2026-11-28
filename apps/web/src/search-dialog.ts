import type { ProjectDto, TaskSearchItemDto } from "@prood/contracts";
import type { ProjectId, WorkspaceId } from "@prood/domain";
import { searchTasks } from "./api.js";
import { createCopyControl } from "./clipboard.js";
import { el } from "./dom.js";
import { translateApiError, type I18nInstance } from "./i18n/messages.js";

export interface SearchPaletteCallbacks {
  getContext: () => {
    workspaceId: WorkspaceId | null;
    activeProjectId: ProjectId | null;
    projects: ProjectDto[];
    i18n: I18nInstance;
  };
  onSelectItem: (item: TaskSearchItemDto) => void;
}

/**
 * Native modal search palette triggered via button click or Cmd/Ctrl+K.
 * Keeps results DOM isolated from parent re-renders so focus stays in the search box.
 */
export class SearchPaletteController {
  readonly element: HTMLDialogElement;
  private titleEl: HTMLHeadingElement;
  private closeBtn: HTMLButtonElement;
  private searchInput: HTMLInputElement;
  private scopeLabel: HTMLSpanElement;
  private scopeCheckbox: HTMLInputElement;
  private statusEl: HTMLParagraphElement;
  private resultsList: HTMLUListElement;
  private items: TaskSearchItemDto[] = [];
  private activeIndex = -1;
  private searchSeq = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: SearchPaletteCallbacks;

  constructor(callbacks: SearchPaletteCallbacks) {
    this.callbacks = callbacks;
    this.titleEl = el("h1", {
      id: "prood-search-dialog-title",
      cls: "prood-view-subtitle",
    });
    this.closeBtn = el("button", {
      cls: "prood-btn-secondary",
      attrs: { "data-search-close": true },
      on: { click: () => this.close() },
    });

    this.searchInput = el("input", {
      type: "search",
      cls: "prood-input",
      attrs: { autofocus: true, "data-search-input": true },
      on: {
        input: () => this.scheduleSearch(),
        keydown: (raw) => {
          const event = raw as KeyboardEvent;
          if (event.key === "ArrowDown" && this.items.length > 0) {
            event.preventDefault();
            this.activeIndex = (this.activeIndex + 1) % this.items.length;
            this.renderResults();
          } else if (event.key === "ArrowUp" && this.items.length > 0) {
            event.preventDefault();
            this.activeIndex =
              this.activeIndex <= 0
                ? this.items.length - 1
                : this.activeIndex - 1;
            this.renderResults();
          } else if (
            event.key === "Enter" &&
            this.items.length > 0 &&
            this.activeIndex >= 0
          ) {
            event.preventDefault();
            const chosen = this.items[this.activeIndex];
            if (chosen) this.selectItem(chosen);
          }
        },
      },
    });

    this.scopeCheckbox = el("input", {
      type: "checkbox",
      attrs: { "data-search-scope-project": true },
      on: { change: () => void this.executeSearch() },
    });
    this.scopeLabel = el("span");
    this.statusEl = el("p", { cls: "prood-count", attrs: { role: "status" } });
    this.resultsList = el("ul", {
      cls: "prood-search-results",
      attrs: { "data-search-results": true },
    });

    const dialog = el(
      "dialog",
      {
        cls: "prood-search-dialog",
        attrs: {
          closedby: "any",
          "aria-labelledby": "prood-search-dialog-title",
          "data-search-dialog": true,
        },
        on: {
          close: () => {
            dialog.returnValue = "";
            this.clearDebounce();
          },
        },
      },
      el("div", { cls: "prood-dialog-head" }, this.titleEl, this.closeBtn),
      el(
        "form",
        {
          cls: "prood-search-controls",
          on: {
            submit: (e) => {
              e.preventDefault();
              const chosen =
                this.activeIndex >= 0 ? this.items[this.activeIndex] : undefined;
              if (chosen) {
                this.selectItem(chosen);
              } else {
                void this.executeSearch();
              }
            },
          },
        },
        this.searchInput,
        el("label", { cls: "prood-checkbox-row" }, this.scopeCheckbox, this.scopeLabel),
      ),
      this.statusEl,
      this.resultsList,
    );

    if (
      typeof HTMLDialogElement !== "undefined" &&
      !("closedBy" in HTMLDialogElement.prototype)
    ) {
      let pressedOutside = false;
      const isOutside = (e: MouseEvent) => {
        const r = dialog.getBoundingClientRect();
        return (
          r.width > 0 &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom)
        );
      };
      dialog.addEventListener("pointerdown", (e) => {
        pressedOutside = isOutside(e);
      });
      dialog.addEventListener("pointerup", (e) => {
        if (pressedOutside && isOutside(e)) this.close();
        pressedOutside = false;
      });
    }

    this.element = dialog;
    this.syncLabels();
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  syncLabels(): void {
    const { activeProjectId, i18n } = this.callbacks.getContext();
    const { t } = i18n;
    this.titleEl.textContent = t("search.title");
    this.closeBtn.textContent = t("action.close");
    this.searchInput.placeholder = t("search.placeholder");
    this.searchInput.setAttribute("aria-label", t("aria.searchTasks"));
    this.scopeLabel.textContent = t("search.scopeCurrentProject");
    this.scopeCheckbox.disabled = !activeProjectId;
    if (!activeProjectId) this.scopeCheckbox.checked = false;
    this.resultsList.setAttribute("aria-label", t("aria.searchResults"));
    if (!this.element.open && this.items.length === 0) {
      this.statusEl.textContent = t("search.emptyPrompt");
    }
  }

  open(): void {
    this.syncLabels();
    if (!this.element.open) {
      if (typeof this.element.showModal === "function") {
        this.element.showModal();
      } else {
        this.element.setAttribute("open", "");
      }
    }
    this.searchInput.focus();
    if (this.searchInput.value.trim()) {
      void this.executeSearch();
    } else {
      this.items = [];
      this.activeIndex = -1;
      this.statusEl.textContent =
        this.callbacks.getContext().i18n.t("search.emptyPrompt");
      this.renderResults();
    }
  }

  close(): void {
    this.clearDebounce();
    if (typeof this.element.close === "function") {
      this.element.close();
    } else {
      this.element.removeAttribute("open");
      this.element.returnValue = "";
    }
  }

  destroy(): void {
    this.clearDebounce();
    this.searchSeq += 1;
    if (this.element.open) this.close();
  }

  private scheduleSearch(): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      void this.executeSearch();
    }, 150);
  }

  async executeSearch(): Promise<void> {
    const { workspaceId, activeProjectId, i18n } = this.callbacks.getContext();
    const { t } = i18n;
    const query = this.searchInput.value.trim();
    if (!workspaceId || !query) {
      this.items = [];
      this.activeIndex = -1;
      this.statusEl.textContent = t("search.emptyPrompt");
      this.renderResults();
      return;
    }

    const seq = ++this.searchSeq;
    this.statusEl.textContent = t("search.loading");

    const res = await searchTasks(workspaceId, {
      query,
      ...(this.scopeCheckbox.checked && activeProjectId
        ? { projectId: activeProjectId }
        : {}),
      limit: 20,
    });
    if (seq !== this.searchSeq) return;
    if (!res.ok) {
      this.items = [];
      this.activeIndex = -1;
      this.statusEl.textContent = translateApiError(i18n, res.messageKey);
      this.renderResults();
      return;
    }

    this.items = res.data.items;
    this.activeIndex = this.items.length > 0 ? 0 : -1;
    this.statusEl.textContent =
      this.items.length === 0 ? t("search.noResults") : "";
    this.renderResults();
  }

  private selectItem(item: TaskSearchItemDto): void {
    this.close();
    this.callbacks.onSelectItem(item);
  }

  private renderResults(): void {
    const { projects, i18n } = this.callbacks.getContext();
    const { t } = i18n;
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

    this.resultsList.innerHTML = "";
    this.items.forEach((entry, index) => {
      const projectName = projectNameById.get(entry.task.effectiveProjectId);
      const idCode = el("code", {
        id: `search-id-${entry.task.id}`,
        cls: "prood-mono",
        text: entry.task.id,
      });

      this.resultsList.appendChild(
        el(
          "li",
          {
            cls:
              index === this.activeIndex
                ? "prood-search-item is-active"
                : "prood-search-item",
            attrs: {
              "data-search-result-id": entry.task.id,
              "data-match-kind": entry.matchKind,
            },
          },
          el(
            "div",
            { cls: "prood-search-item-main" },
            el("span", {
              cls: "prood-badge",
              text: t(`search.match.${entry.matchKind}`),
            }),
            entry.task.issueKey
              ? el("code", {
                  id: `search-key-${entry.task.id}`,
                  cls: "prood-key-badge",
                  text: entry.task.issueKey,
                })
              : null,
            el("button", {
              cls: "prood-search-select-btn",
              attrs: { "data-search-select": entry.task.id },
              text: entry.task.title,
              on: { click: () => this.selectItem(entry) },
            }),
            projectName
              ? el("span", { cls: "prood-count", text: projectName })
              : null,
          ),
          el(
            "div",
            { cls: "prood-search-item-meta" },
            entry.task.issueKey
              ? createCopyControl({
                  targetId: `search-key-${entry.task.id}`,
                  buttonText: t("action.copyKey"),
                  screenReaderSuffix: entry.task.issueKey,
                  copyKind: "key",
                })
              : null,
            idCode,
            createCopyControl({
              targetId: idCode.id,
              buttonText: t("action.copyId"),
              screenReaderSuffix: entry.task.id,
              copyKind: "id",
            }),
          ),
        ),
      );
    });
  }
}
