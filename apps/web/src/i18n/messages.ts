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
 * Creates a locale-aware translator and formatter with automatic fallback to English.
 */
export function createI18n(options: I18nOptions = {}): I18nInstance {
  let currentLocale: LocaleCode = options.locale ?? DEFAULT_LOCALE;
  const catalogs: Record<string, PartialMessageCatalog> = {
    en: enMessages,
    ...(options.catalogs ?? {}),
  };

  function resolveTemplate(key: MessageKey): string {
    const activeCatalog = catalogs[currentLocale];
    const localized = activeCatalog?.[key];
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
      currentLocale = locale;
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
      const rule = new Intl.PluralRules(currentLocale).select(count);
      const key: MessageKey = rule === "one" ? "task.count.one" : "task.count.other";
      return interpolate(resolveTemplate(key), {
        count: new Intl.NumberFormat(currentLocale).format(count),
      });
    },
  };
}
