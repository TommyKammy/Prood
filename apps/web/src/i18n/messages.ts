import { DEFAULT_LOCALE, type LocaleCode } from "@prood/domain";
import {
  enMessages,
  type MessageKey,
  type PartialMessageCatalog,
} from "./en.js";

export { enMessages, type MessageCatalog, type MessageKey, type PartialMessageCatalog } from "./en.js";

export interface I18nOptions {
  locale?: LocaleCode;
  catalogs?: Record<string, PartialMessageCatalog>;
}

export interface I18nInstance {
  getLocale(): LocaleCode;
  setLocale(locale: LocaleCode): void;
  t(key: MessageKey, params?: Record<string, string | number>): string;
  formatDate(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatTaskCount(count: number): string;
}

function normalizeLocaleTag(locale: string): string {
  const trimmed = locale.trim().replace(/_/g, "-");
  if (!trimmed) {
    return DEFAULT_LOCALE;
  }
  try {
    const canonical = Intl.getCanonicalLocales(trimmed)[0];
    return canonical || DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
    const replacement = params[name];
    return replacement !== undefined ? String(replacement) : match;
  });
}

/**
 * Creates a locale-aware translator and formatter with BCP-47 fallback to English.
 */
export function createI18n(options: I18nOptions = {}): I18nInstance {
  let currentLocale: LocaleCode = normalizeLocaleTag(options.locale ?? DEFAULT_LOCALE);
  const catalogs: Record<string, PartialMessageCatalog> = {
    en: enMessages,
    ...(options.catalogs ?? {}),
  };

  function findCatalog(
    locale: string,
  ): { locale: string; catalog: PartialMessageCatalog } | null {
    const exact = catalogs[locale];
    if (exact) {
      return { locale, catalog: exact };
    }
    const dashIdx = locale.indexOf("-");
    if (dashIdx > 0) {
      const baseLang = locale.slice(0, dashIdx);
      const baseCatalog = catalogs[baseLang];
      if (baseCatalog) {
        return { locale: baseLang, catalog: baseCatalog };
      }
    }
    return null;
  }

  function resolveTemplate(key: MessageKey): string {
    const matched = findCatalog(currentLocale);
    const localized = matched?.catalog[key];
    if (localized !== undefined) {
      return localized;
    }
    return enMessages[key];
  }

  return {
    getLocale(): LocaleCode {
      return currentLocale;
    },

    setLocale(locale: LocaleCode): void {
      currentLocale = normalizeLocaleTag(locale);
    },

    t(key: MessageKey, params?: Record<string, string | number>): string {
      return interpolate(resolveTemplate(key), params);
    },

    formatDate(
      value: Date | number | string,
      formatOptions?: Intl.DateTimeFormatOptions,
    ): string {
      const date = value instanceof Date ? value : new Date(value);
      return new Intl.DateTimeFormat(currentLocale, formatOptions).format(date);
    },

    formatNumber(
      value: number,
      formatOptions?: Intl.NumberFormatOptions,
    ): string {
      return new Intl.NumberFormat(currentLocale, formatOptions).format(value);
    },

    formatTaskCount(count: number): string {
      const matched = findCatalog(currentLocale);
      if (matched) {
        const activeRule = new Intl.PluralRules(currentLocale).select(count);
        const activeKey: MessageKey =
          activeRule === "one" ? "task.count.one" : "task.count.other";
        const localizedTemplate = matched.catalog[activeKey];
        if (localizedTemplate !== undefined) {
          return interpolate(localizedTemplate, {
            count: new Intl.NumberFormat(currentLocale).format(count),
          });
        }
      }

      const fallbackRule = new Intl.PluralRules(DEFAULT_LOCALE).select(count);
      const fallbackKey: MessageKey =
        fallbackRule === "one" ? "task.count.one" : "task.count.other";
      return interpolate(enMessages[fallbackKey], {
        count: new Intl.NumberFormat(DEFAULT_LOCALE).format(count),
      });
    },
  };
}
