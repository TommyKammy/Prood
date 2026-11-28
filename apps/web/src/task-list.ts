import type { ProjectDto, TaskDto } from "@prood/contracts";
import type { StatusId, TaskPublicId } from "@prood/domain";
import { createCopyControl } from "./clipboard.js";
import { alertBanner, el, fieldGroup } from "./dom.js";
import type { I18nInstance } from "./i18n/messages.js";

export interface TaskListViewOptions {
  project: ProjectDto;
  tasks: TaskDto[];
  i18n: I18nInstance;
  draftTitle: string;
  draftStatusId: StatusId | "";
  creating: boolean;
  createError: string;
  createNotice: string;
  loadError: string;
  highlightedTaskId: TaskPublicId | null;
  onDraftChange: (title: string, statusId: StatusId | "") => void;
  onSubmitCreate: (title: string, statusId: StatusId | null) => void;
}

export function renderTaskListView(opts: TaskListViewOptions): HTMLElement {
  const { project, tasks, i18n } = opts;
  const { t, formatTaskCount } = i18n;

  const titleRow = el(
    "div",
    { cls: "prood-view-title-row" },
    el("h1", { cls: "prood-view-title", text: project.name }),
    el("span", {
      cls: "prood-badge",
      attrs: { "data-project-kind": project.kind },
      text: t(
        project.kind === "development"
          ? "project.kind.development"
          : "project.kind.general",
      ),
    }),
    el("span", {
      cls: "prood-badge",
      text: t(
        project.visibility === "private"
          ? "project.visibility.private"
          : "project.visibility.workspace",
      ),
    }),
    project.devSettings
      ? el("code", {
          cls: "prood-key-badge",
          attrs: { "data-project-prefix": project.devSettings.prefix },
          text: project.devSettings.prefix,
        })
      : null,
  );

  const countEl = opts.loadError
    ? null
    : el("p", {
        cls: "prood-count",
        attrs: { "data-task-count": String(tasks.length) },
        text: formatTaskCount(tasks.length),
      });

  const container = el(
    "section",
    { cls: "prood-panel", attrs: { "aria-label": t("aria.taskList") } },
    el("div", { cls: "prood-view-header" }, titleRow, countEl),
  );

  if (project.myRole !== "viewer") {
    const titleInput = el("input", {
      id: "prood-new-task-title",
      cls: "prood-input",
      type: "text",
      required: true,
      placeholder: t("task.titlePlaceholder"),
      val: opts.draftTitle,
      attrs: { "data-task-title-input": true },
    });
    const statusSelect = el(
      "select",
      {
        id: "prood-new-task-status",
        cls: "prood-select",
        attrs: { "data-task-status-select": true },
      },
      ...project.statuses.map((st) =>
        el("option", {
          val: st.id,
          text: st.name,
          selected: opts.draftStatusId === st.id,
        }),
      ),
    );
    const emitDraft = () =>
      opts.onDraftChange(
        titleInput.value,
        (statusSelect.value as StatusId | "") || "",
      );
    titleInput.addEventListener("input", emitDraft);
    statusSelect.addEventListener("change", emitDraft);

    const form = el(
      "form",
      {
        cls: "prood-inline-form",
        attrs: { "data-create-task-form": true },
        on: {
          submit: (e) => {
            e.preventDefault();
            opts.onSubmitCreate(
              titleInput.value,
              (statusSelect.value || null) as StatusId | null,
            );
          },
        },
      },
      fieldGroup(
        "prood-new-task-title",
        t("task.titleLabel"),
        titleInput,
        "prood-field prood-grow",
      ),
      fieldGroup(
        "prood-new-task-status",
        t("task.statusLabel"),
        statusSelect,
        "prood-field prood-status-col",
      ),
      el("button", {
        type: "submit",
        cls: "prood-btn-primary",
        disabled: opts.creating,
        attrs: { "data-create-task-submit": true },
        text: opts.creating ? t("task.creating") : t("action.createTask"),
      }),
    );
    container.appendChild(form);
  } else {
    container.appendChild(
      el("p", {
        cls: "prood-notice",
        attrs: { "data-readonly-notice": true },
        text: t("task.readOnlyNotice"),
      }),
    );
  }

  const notice = alertBanner(opts.createError, opts.createNotice);
  if (notice) container.appendChild(notice);

  if (opts.loadError) {
    container.appendChild(
      el("p", {
        cls: "prood-auth-feedback",
        attrs: { role: "alert", "data-task-load-error": true },
        text: opts.loadError,
      }),
    );
    return container;
  }

  if (tasks.length === 0) {
    container.appendChild(
      el(
        "section",
        { cls: "prood-empty" },
        el("h2", { text: t("empty.tasks.title") }),
        el("p", { text: t("empty.tasks.description") }),
      ),
    );
    return container;
  }

  const showKeyColumn =
    project.kind === "development" ||
    project.devSettings !== null ||
    tasks.some((item) => item.issueKey !== null);
  const statusById = new Map(project.statuses.map((st) => [st.id, st.name]));
  const columns = showKeyColumn
    ? [
        t("task.col.key"),
        t("task.col.title"),
        t("task.col.status"),
        t("task.col.assignee"),
        t("task.col.publicId"),
      ]
    : [
        t("task.col.title"),
        t("task.col.status"),
        t("task.col.assignee"),
        t("task.col.publicId"),
      ];

  const rows = tasks.map((task) => {
    const keyCell = showKeyColumn
      ? el(
          "td",
          { attrs: { "data-label": t("task.col.key") } },
          task.issueKey
            ? el(
                "div",
                { cls: "prood-id-cell" },
                el("code", {
                  id: `key-${task.id}`,
                  cls: "prood-key-badge",
                  attrs: { "data-task-key": task.issueKey },
                  text: task.issueKey,
                }),
                createCopyControl({
                  targetId: `key-${task.id}`,
                  buttonText: t("action.copyKey"),
                  screenReaderSuffix: task.issueKey,
                  copyKind: "key",
                }),
              )
            : "—",
        )
      : null;

    return el(
      "tr",
      {
        cls: opts.highlightedTaskId === task.id ? "prood-row-highlight" : undefined,
        attrs: { "data-task-row": task.id },
      },
      keyCell,
      el("th", { attrs: { scope: "row" }, text: task.title }),
      el("td", {
        attrs: {
          "data-label": t("task.col.status"),
          "data-task-status": task.statusId ?? "",
        },
        text: (task.statusId && statusById.get(task.statusId)) || "—",
      }),
      el("td", {
        attrs: {
          "data-label": t("task.col.assignee"),
          "data-task-assignee": task.assigneeId ?? "",
        },
        text: task.assigneeDisplayName ?? task.assigneeId ?? "—",
      }),
      el(
        "td",
        { attrs: { "data-label": t("task.col.publicId") } },
        el(
          "div",
          { cls: "prood-id-cell" },
          el("code", {
            id: `id-${task.id}`,
            cls: "prood-mono",
            attrs: { "data-task-public-id": task.id },
            text: task.id,
          }),
          createCopyControl({
            targetId: `id-${task.id}`,
            buttonText: t("action.copyId"),
            screenReaderSuffix: task.id,
            copyKind: "id",
          }),
        ),
      ),
    );
  });

  const table = el(
    "table",
    { cls: "prood-table" },
    el("caption", {
      id: "prood-task-table-caption",
      cls: "prood-sr-only",
      text: t("task.tableCaption"),
    }),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ...columns.map((c) => el("th", { attrs: { scope: "col" }, text: c })),
      ),
    ),
    el("tbody", {}, ...rows),
  );

  container.appendChild(
    el(
      "div",
      {
        cls: "prood-table-wrap",
        attrs: {
          tabindex: 0,
          role: "region",
          "aria-labelledby": "prood-task-table-caption",
        },
      },
      table,
    ),
  );
  return container;
}
