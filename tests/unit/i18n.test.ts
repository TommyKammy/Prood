import { describe, expect, it } from "vitest";
import { createI18n } from "@prood/web/i18n";

describe("@prood/web i18n", () => {
  it("uses English as default locale and interpolates parameters", () => {
    const i18n = createI18n();
    expect(i18n.getLocale()).toBe("en");
    expect(i18n.t("app.name")).toBe("Prood");
    expect(i18n.t("action.createTask")).toBe("Create task");
    expect(i18n.t("aria.copyPublicId", { id: "tsk_01jf8x9z2k3m4n5p6q7r8s9t0v" })).toBe(
      "Copy public task ID tsk_01jf8x9z2k3m4n5p6q7r8s9t0v",
    );
  });

  it("falls back to English for missing keys in a partial Japanese catalog", () => {
    const i18n = createI18n({
      locale: "ja",
      catalogs: {
        ja: {
          "action.createTask": "タスクを作成",
          "task.count.other": "{count}件のタスク",
        },
      },
    });

    expect(i18n.t("action.createTask")).toBe("タスクを作成");
    expect(i18n.t("empty.tasks.title")).toBe("No tasks yet");
    expect(i18n.formatTaskCount(1)).toBe("1件のタスク");
    expect(i18n.formatTaskCount(3)).toBe("3件のタスク");
  });

  it("applies English plural rules when count keys are missing or locale is unregistered", () => {
    const jaWithoutCatalog = createI18n({ locale: "ja" });
    expect(jaWithoutCatalog.formatTaskCount(0)).toBe("0 tasks");
    expect(jaWithoutCatalog.formatTaskCount(1)).toBe("1 task");
    expect(jaWithoutCatalog.formatTaskCount(2)).toBe("2 tasks");

    const jaPartialWithoutCounts = createI18n({
      locale: "ja",
      catalogs: {
        ja: {
          "action.createTask": "タスクを作成",
        },
      },
    });
    expect(jaPartialWithoutCounts.formatTaskCount(1)).toBe("1 task");

    const frUnregistered = createI18n({ locale: "fr" });
    expect(frUnregistered.formatTaskCount(0)).toBe("0 tasks");
    expect(frUnregistered.formatTaskCount(1)).toBe("1 task");
  });

  it("falls back to English when switched to an unregistered locale", () => {
    const i18n = createI18n();
    i18n.setLocale("fr");
    expect(i18n.getLocale()).toBe("fr");
    expect(i18n.t("nav.board")).toBe("Board");
  });

  it("formats dates, numbers, and plural counts according to locale", () => {
    const i18n = createI18n({ locale: "en" });
    const sampleDate = new Date("2026-11-27T00:00:00.000Z");

    expect(i18n.formatTaskCount(1)).toBe("1 task");
    expect(i18n.formatTaskCount(2)).toBe("2 tasks");
    expect(i18n.formatNumber(1234)).toBe("1,234");
    expect(
      i18n.formatDate(sampleDate, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }),
    ).toContain("2026");

    i18n.setLocale("ja");
    expect(
      i18n.formatDate(sampleDate, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }),
    ).toContain("2026");
  });
});
