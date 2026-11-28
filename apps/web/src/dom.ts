export interface ElOptions {
  cls?: string;
  id?: string;
  text?: string;
  type?: string;
  val?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean;
  required?: boolean;
  selected?: boolean;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, (e: Event) => void>;
}

/**
 * Compact DOM builder for browser Web Components without runtime dependencies.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: ElOptions,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (tag === "button") {
    (node as HTMLButtonElement).type = (opts?.type as HTMLButtonElement["type"]) ?? "button";
  }
  if (opts) {
    if (opts.cls) node.className = opts.cls;
    if (opts.id) node.id = opts.id;
    if (opts.text !== undefined) node.textContent = opts.text;
    const anyNode = node as unknown as Record<string, unknown>;
    if (opts.type !== undefined && tag !== "button") anyNode.type = opts.type;
    if (opts.placeholder !== undefined) anyNode.placeholder = opts.placeholder;
    if (opts.required !== undefined) anyNode.required = opts.required;
    if (opts.disabled !== undefined) anyNode.disabled = opts.disabled;
    if (opts.checked !== undefined) anyNode.checked = opts.checked;
    if (opts.selected !== undefined) anyNode.selected = opts.selected;
    if (opts.val !== undefined) anyNode.value = opts.val;
    if (opts.attrs) {
      for (const [k, v] of Object.entries(opts.attrs)) {
        if (v !== false && v !== null && v !== undefined) {
          node.setAttribute(k, v === true ? "" : String(v));
        }
      }
    }
    if (opts.on) {
      for (const [ev, fn] of Object.entries(opts.on)) {
        node.addEventListener(ev, fn);
      }
    }
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) {
      node.append(c);
    }
  }
  return node;
}

export function fieldGroup(
  labelFor: string,
  labelText: string,
  control: HTMLElement,
  cls = "prood-field",
  help?: HTMLElement | null,
): HTMLDivElement {
  return el(
    "div",
    { cls },
    el("label", { cls: "prood-label", attrs: { for: labelFor }, text: labelText }),
    control,
    help ?? null,
  );
}

export function alertBanner(
  errText: string,
  okText?: string,
): HTMLParagraphElement | null {
  if (errText) {
    return el("p", {
      cls: "prood-auth-feedback",
      attrs: { role: "alert" },
      text: errText,
    });
  }
  if (okText) {
    return el("p", {
      cls: "prood-status-banner",
      attrs: { role: "status" },
      text: okText,
    });
  }
  return null;
}
