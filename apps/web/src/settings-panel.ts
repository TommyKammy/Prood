import type {
  ProjectDevSettingsResponse,
  ProjectDto,
  WorkspaceSettingsDto,
} from "@prood/contracts";
import type { StatusId, WorkspaceRole } from "@prood/domain";
import { alertBanner, el, fieldGroup } from "./dom.js";
import type { I18nInstance } from "./i18n/messages.js";

export interface SettingsPanelOptions {
  workspaceRole: WorkspaceRole | null;
  workspaceSettings: WorkspaceSettingsDto | null;
  project: ProjectDto | null;
  devSettings: ProjectDevSettingsResponse | null;
  i18n: I18nInstance;
  savingWorkspace: boolean;
  savingProject: boolean;
  workspaceNotice: string;
  workspaceError: string;
  projectNotice: string;
  projectError: string;
  prefixDraft: string;
  startStatusDraft: StatusId | "";
  onPrefixDraftChange: (prefix: string) => void;
  onStartStatusDraftChange: (statusId: StatusId | "") => void;
  onSaveWorkspaceSettings: (devProjectsEnabled: boolean) => void;
  onEnableDevProject: (prefix: string, startStatusId: StatusId | null) => void;
  onUpdateDevProjectSettings: (
    prefix: string,
    startStatusId: StatusId | null,
  ) => void;
}

export function renderSettingsPanel(opts: SettingsPanelOptions): HTMLElement {
  const { t } = opts.i18n;
  const isWsAdmin = opts.workspaceRole === "admin";

  const wsToggle = el("input", {
    type: "checkbox",
    checked: opts.workspaceSettings?.devProjectsEnabled ?? false,
    disabled: !isWsAdmin || opts.savingWorkspace,
    attrs: { "data-ws-dev-toggle": true },
  });

  const wsSection = el(
    "section",
    { cls: "prood-panel" },
    el("h1", { cls: "prood-view-title", text: t("settings.workspaceTitle") }),
    el(
      "form",
      {
        cls: "prood-settings-form",
        attrs: { "data-workspace-settings-form": true },
        on: {
          submit: (e) => {
            e.preventDefault();
            if (isWsAdmin) opts.onSaveWorkspaceSettings(wsToggle.checked);
          },
        },
      },
      el(
        "label",
        { cls: "prood-checkbox-row" },
        wsToggle,
        el("span", { text: t("settings.devFeatureLabel") }),
      ),
      el("p", { cls: "prood-count", text: t("settings.devFeatureHelp") }),
      el("button", {
        type: "submit",
        cls: "prood-btn-primary",
        disabled: !isWsAdmin || opts.savingWorkspace,
        attrs: { "data-ws-dev-save": true },
        text: opts.savingWorkspace ? t("settings.saving") : t("action.save"),
      }),
    ),
    !isWsAdmin
      ? el("p", {
          cls: "prood-notice",
          attrs: { "data-ws-admin-notice": true },
          text: t("settings.adminOnlyNotice"),
        })
      : null,
    alertBanner(opts.workspaceError, opts.workspaceNotice),
  );

  const projSection = el(
    "section",
    { cls: "prood-panel" },
    el("h2", { cls: "prood-view-subtitle", text: t("settings.projectTitle") }),
  );

  if (!opts.project || !opts.devSettings) {
    projSection.appendChild(
      el("p", {
        cls: "prood-count",
        text: opts.project ? t("auth.loading") : t("settings.projectSelectPrompt"),
      }),
    );
    return el(
      "section",
      { cls: "prood-settings-stack", attrs: { "aria-label": t("nav.settings") } },
      wsSection,
      projSection,
    );
  }

  const devInfo = opts.devSettings;
  const canManage =
    devInfo.canManage ??
    (opts.workspaceRole === "admin" || opts.project.myRole === "admin");
  const editable = devInfo.allowed && canManage && !opts.savingProject;

  if (!devInfo.allowed) {
    projSection.appendChild(
      el("p", {
        cls: "prood-notice",
        attrs: { "data-proj-dev-disabled-notice": true },
        text: t("settings.disabledByWorkspace"),
      }),
    );
  } else if (!canManage) {
    projSection.appendChild(
      el("p", {
        cls: "prood-notice",
        attrs: { "data-proj-manage-notice": true },
        text: t("settings.manageOnlyNotice"),
      }),
    );
  }

  if (devInfo.dev) {
    projSection.appendChild(
      el(
        "dl",
        { cls: "prood-meta-list" },
        el("dt", { text: t("settings.branchPrefixLabel") }),
        el(
          "dd",
          {},
          el("code", {
            cls: "prood-mono",
            attrs: { "data-branch-prefix": devInfo.dev.branchPrefix },
            text: devInfo.dev.branchPrefix,
          }),
        ),
        el("dt", { text: t("settings.oldPrefixesLabel") }),
        el("dd", {
          attrs: { "data-old-prefixes": true },
          text:
            devInfo.dev.oldPrefixes.length > 0
              ? devInfo.dev.oldPrefixes.join(", ")
              : t("settings.oldPrefixesNone"),
        }),
      ),
    );
  }

  const prefixInput = el("input", {
    id: "prood-dev-prefix-input",
    type: "text",
    required: true,
    cls: "prood-input prood-mono",
    placeholder: t("settings.prefixPlaceholder"),
    disabled: !editable,
    val: opts.prefixDraft,
    attrs: { minlength: 2, maxlength: 10, "data-proj-prefix-input": true },
    on: {
      input: () => opts.onPrefixDraftChange(prefixInput.value),
    },
  });

  const startSelect = el(
    "select",
    {
      id: "prood-dev-start-status",
      cls: "prood-select",
      disabled: !editable,
      attrs: { "data-proj-start-status-select": true },
    },
    el("option", {
      val: "",
      text: t("settings.startStatusNone"),
      selected: !opts.startStatusDraft,
    }),
    ...devInfo.statuses.map((st) =>
      el("option", {
        val: st.id,
        text: st.name,
        selected: opts.startStatusDraft === st.id,
      }),
    ),
  );
  startSelect.addEventListener("change", () =>
    opts.onStartStatusDraftChange((startSelect.value as StatusId | "") || ""),
  );

  const submitText = devInfo.dev
    ? opts.savingProject
      ? t("settings.saving")
      : t("action.save")
    : opts.savingProject
      ? t("settings.enabling")
      : t("settings.enableDevButton");

  projSection.append(
    el(
      "form",
      {
        cls: "prood-settings-form",
        attrs: { "data-project-dev-settings-form": true },
        on: {
          submit: (e) => {
            e.preventDefault();
            if (!editable) return;
            const statusId = (startSelect.value || null) as StatusId | null;
            if (devInfo.dev) {
              opts.onUpdateDevProjectSettings(prefixInput.value, statusId);
            } else {
              opts.onEnableDevProject(prefixInput.value, statusId);
            }
          },
        },
      },
      fieldGroup(
        "prood-dev-prefix-input",
        t("settings.prefixLabel"),
        prefixInput,
        "prood-field",
        el("span", { cls: "prood-count", text: t("settings.prefixHelp") }),
      ),
      fieldGroup(
        "prood-dev-start-status",
        t("settings.startStatusLabel"),
        startSelect,
      ),
      el("button", {
        type: "submit",
        cls: "prood-btn-primary",
        disabled: !editable,
        attrs: {
          [devInfo.dev ? "data-proj-dev-save" : "data-proj-dev-enable"]: true,
        },
        text: submitText,
      }),
    ),
  );
  const projBanner = alertBanner(opts.projectError, opts.projectNotice);
  if (projBanner) projSection.appendChild(projBanner);

  return el(
    "section",
    { cls: "prood-settings-stack", attrs: { "aria-label": t("nav.settings") } },
    wsSection,
    projSection,
  );
}
