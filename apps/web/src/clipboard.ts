export interface CopyLabels {
  copied: string;
  failed: string;
}

const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let lastAnnouncement = "";
let registeredDoc: Document | null = null;
let currentGetLabels: (() => CopyLabels) | null = null;

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) {
    return false;
  }
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "prood-sr-copy-field";
  document.body.append(field);
  field.select();
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}

function showCopyFeedback(
  button: HTMLElement,
  ok: boolean,
  labels: CopyLabels,
): void {
  const tip = button.nextElementSibling;
  const prevTimer = copyTimers.get(button);
  if (prevTimer !== undefined) {
    clearTimeout(prevTimer);
  }

  button.removeAttribute("data-copied");
  button.removeAttribute("data-failed");

  let message = ok ? labels.copied : labels.failed;
  // Append NBSP when repeating the same announcement so screen readers re-announce it.
  if (message === lastAnnouncement) {
    message += "\u00A0";
  }
  lastAnnouncement = message;

  if (tip) {
    tip.textContent = "";
  }
  void button.offsetWidth;
  button.setAttribute(ok ? "data-copied" : "data-failed", "");

  const applyMessage = () => {
    if (tip) {
      tip.textContent = message;
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(applyMessage);
  } else {
    applyMessage();
  }

  const timer = setTimeout(() => {
    copyTimers.delete(button);
    button.removeAttribute("data-copied");
    button.removeAttribute("data-failed");
    if (tip) {
      tip.textContent = "";
    }
  }, 2000);
  if (typeof timer === "object" && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  copyTimers.set(button, timer);
}

/**
 * Copies text from a target element referenced by `commandfor` to the clipboard
 * and updates accessible status feedback without disabling the copy trigger.
 */
export async function copyFromTarget(
  button: HTMLElement,
  target: Element,
  labels: CopyLabels,
): Promise<boolean> {
  const raw =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.value
      : (target.textContent ?? "");
  const text = raw.trim();
  if (!text) {
    return false;
  }

  let succeeded = false;
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      succeeded = true;
    } else {
      succeeded = legacyCopy(text);
    }
  } catch {
    succeeded = legacyCopy(text);
  }

  showCopyFeedback(button, succeeded, labels);
  return succeeded;
}

/**
 * Registers a single document-level Invoker Command (`--copy`) handler, or a
 * click fallback where `CommandEvent` is not supported, so clicks never fire twice.
 */
export function ensureCopyCommandListener(getLabels: () => CopyLabels): void {
  currentGetLabels = getLabels;
  if (typeof document === "undefined" || registeredDoc === document) {
    return;
  }
  registeredDoc = document;

  const resolveLabels = (): CopyLabels =>
    currentGetLabels?.() ?? { copied: "Copied", failed: "Copy failed" };

  if (typeof window !== "undefined" && "CommandEvent" in window) {
    document.addEventListener(
      "command",
      (rawEvent) => {
        const event = rawEvent as Event & {
          command?: string;
          source?: Element | null;
          target?: EventTarget | null;
        };
        if (event.command !== "--copy") {
          return;
        }
        if (
          event.source instanceof HTMLElement &&
          event.target instanceof Element
        ) {
          void copyFromTarget(event.source, event.target, resolveLabels());
        }
      },
      true,
    );
    return;
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest('button[command="--copy"]');
    if (!(button instanceof HTMLElement)) {
      return;
    }
    const targetId = button.getAttribute("commandfor");
    const target = targetId ? document.getElementById(targetId) : null;
    if (target) {
      void copyFromTarget(button, target, resolveLabels());
    }
  });
}

/**
 * Builds a declarative copy control with an adjacent outside-the-button live status region.
 */
export function createCopyControl(input: {
  targetId: string;
  buttonText: string;
  screenReaderSuffix: string;
  copyKind: "id" | "key";
}): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "prood-copy";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "prood-copy-btn";
  btn.setAttribute("command", "--copy");
  btn.setAttribute("commandfor", input.targetId);
  btn.setAttribute("data-copy-kind", input.copyKind);

  const visibleLabel = document.createElement("span");
  visibleLabel.textContent = input.buttonText;

  const srSuffix = document.createElement("span");
  srSuffix.className = "prood-sr-only";
  srSuffix.textContent = ` ${input.screenReaderSuffix}`;

  const tip = document.createElement("span");
  tip.className = "prood-copy-tip";
  tip.setAttribute("role", "status");

  btn.append(visibleLabel, srSuffix);
  wrap.append(btn, tip);
  return wrap;
}
