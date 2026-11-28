import { automationMessages } from "./i18n/automation.js";

type Choice = { id: string; name: string };
type Rule = { rule: string; revision: number; enabled: boolean };
type Options = {
  operatorConsole?: string;
  project: string;
  manage: boolean;
  members: Choice[];
  statuses: Choice[];
  tasks: Choice[];
  rules: Rule[];
};
type Entry = {
  at: string;
  channel: string;
  event: string;
  task: string | null;
  actor: string | null;
  origin: string | null;
  rule: string | null;
  revision: number | null;
  run: string | null;
  reason: string | null;
  decision: string | null;
  actions: ("keep" | "undo")[];
};
const lang = navigator.language.startsWith("ja") ? "ja" : "en";
const words: Record<string, string> = automationMessages[lang];
document.documentElement.lang = lang;
document
  .querySelectorAll<HTMLElement>("[data-label]")
  .forEach((el) => (el.textContent = words[el.dataset.label!]!));
function node<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
const select = (id: string) => node<HTMLSelectElement>(id);
const button = (id: string) => node<HTMLButtonElement>(id);
const project = select("project"),
  rule = node<HTMLInputElement>("rule"),
  template = select("template"),
  task = select("task");
let generation = 0,
  historyGeneration = 0,
  options: Options | undefined,
  me: { id: string; displayName: string };
let pending: { definition: object; revision: number; delegate: string } | undefined;
const feedback = node("feedback");
function clear() {
  generation++;
  historyGeneration++;
  pending = undefined;
  node("preview").hidden = true;
  node("entries").replaceChildren();
  feedback.textContent = "";
}
function choices(el: HTMLSelectElement, list: Choice[]) {
  el.replaceChildren(...list.map((x) => new Option(x.name, x.id)));
}
function currentRevision() {
  return options?.rules.find((x) => x.rule === rule.value)?.revision ?? 0;
}
function name(id: string | null) {
  return id
    ? ([...options!.members, ...options!.statuses].find((x) => x.id === id)?.name ?? id)
    : words.none;
}
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw Error(String(res.status));
  return res.json();
}
function call<T>(body: object, ruleId = rule.value || "default") {
  return json<T>(
    "/api/v1/projects/" +
      encodeURIComponent(project.value) +
      "/automation/" +
      encodeURIComponent(ruleId),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}
function run(action: () => Promise<void>) {
  void action().catch(() => {
    feedback.textContent = words.failed!;
  });
}
function controls() {
  const when = select("when").value;
  node("status-trigger").hidden = when !== "status.changed";
  node("assignee-trigger").hidden = when !== "assignee.changed";
  node("previous").hidden = !when.endsWith(".changed");
  node("assignment").hidden = select("action").value !== "assigneeId";
  node("status-action").hidden = select("action").value !== "statusId";
  button("stop").disabled =
    !options?.manage || !options.rules.some((x) => x.rule === rule.value && x.enabled);
  button("simulate").disabled = !options?.manage || !task.value;
}
async function load() {
  clear();
  options = undefined;
  node<HTMLFieldSetElement>("settings").disabled = true;
  controls();
  const gen = generation;
  const data = await call<Options>({ op: "options" });
  if (gen !== generation) return;
  options = data;
  const operator = node<HTMLAnchorElement>("operator");
  operator.hidden = !data.operatorConsole;
  if (data.operatorConsole) operator.href = data.operatorConsole;
  choices(select("state"), data.statuses);
  const optional = [
    { id: "@event", name: words.eventValue! },
    { id: "", name: words.none! },
  ];
  choices(select("member"), [...data.members, ...optional]);
  choices(select("to-state"), [...data.statuses, ...optional]);
  choices(select("to-member"), [
    { id: "@any", name: words.any! },
    { id: "", name: words.none! },
    ...data.members,
  ]);
  choosePrevious();
  choices(task, data.tasks);
  node("rules").replaceChildren(...data.rules.map((r) => new Option(r.rule, r.rule)));
  const query = new URLSearchParams(location.search);
  if (data.tasks.some((t) => t.id === query.get("task"))) task.value = query.get("task")!;
  node<HTMLFieldSetElement>("settings").disabled = !data.manage;
  controls();
}
function choosePrevious() {
  if (!options) return;
  choices(select("from"), [
    { id: "@any", name: words.any! },
    { id: "", name: words.none! },
    ...(select("when").value === "status.changed" ? options.statuses : options.members),
  ]);
}
select("when").onchange = choosePrevious;
template.onchange = () => {
  const manual = template.value === "manual";
  select("when").value = manual ? "manual" : "status.changed";
  select("condition").value = manual ? "always" : "empty";
  select("action").value = manual ? "statusId" : "assigneeId";
  choosePrevious();
  controls();
};
function definition() {
  const when = select("when").value,
    field = select("action").value;
  const raw = select(field === "assigneeId" ? "member" : "to-state").value;
  const to = select(when === "status.changed" ? "state" : "to-member").value;
  const from = select("from").value;
  return {
    apply: true,
    reversible: node<HTMLInputElement>("reversible").checked,
    when,
    ifUnassigned: select("condition").value === "empty",
    ...(when.endsWith(".changed") && from !== "@any" && { from: from || null }),
    ...(when.endsWith(".changed") && to !== "@any" && { to: to || null }),
    action: { field, value: raw === "@event" ? { event: field } : raw || null },
  };
}
node("editor").oninput = () => {
  clear();
  controls();
};
project.onchange = () => {
  window.history.replaceState(
    null,
    "",
    "/projects/" + encodeURIComponent(project.value) + "/automation",
  );
  rule.value = "";
  run(load);
};
node<HTMLFormElement>("editor").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    clear();
    const gen = generation,
      body = { revision: currentRevision(), delegate: me.id, definition: definition() };
    await call({ ...body, op: "preview" });
    if (gen !== generation) return;
    const result = await call<{
      task: string;
      field?: string;
      before?: string | null;
      after?: string | null;
      reason: string;
    }>({ op: "simulate", task: task.value, definition: body.definition });
    if (gen !== generation) return;
    node("summary").textContent = [
      select("when").selectedOptions[0]?.text,
      select("when").value.endsWith(".changed")
        ? select("from").selectedOptions[0]?.text +
          " → " +
          select(select("when").value === "status.changed" ? "state" : "to-member")
            .selectedOptions[0]?.text
        : "",
      select("condition").selectedOptions[0]?.text,
      select("action").selectedOptions[0]?.text +
        " · " +
        select(select("action").value === "assigneeId" ? "member" : "to-state").selectedOptions[0]
          ?.text,
      result.task,
      result.field ? name(result.before ?? null) + " → " + name(result.after ?? null) : "",
      words[result.reason] ?? result.reason,
      words.who + " " + me.displayName,
    ]
      .filter(Boolean)
      .join(" · ");
    pending = body;
    node("preview").hidden = false;
    button("publish").focus();
  });
};
button("publish").onclick = () =>
  run(async () => {
    if (!pending) return;
    const body = pending;
    clear();
    const gen = generation;
    await call({ ...body, op: "publish" });
    if (gen === generation) {
      await load();
      feedback.textContent = words.ok!;
    }
  });
button("stop").onclick = () =>
  run(async () => {
    const revision = currentRevision();
    clear();
    const gen = generation;
    await call({ op: "stop", revision });
    if (gen === generation) {
      await load();
      feedback.textContent = words.ok!;
    }
  });
async function history(byTask: boolean) {
  const gen = ++historyGeneration;
  const data = await call<{ entries: Entry[] }>({
    op: "history",
    ...(byTask ? { task: task.value } : {}),
  });
  if (gen !== historyGeneration) return;
  const list = node("entries");
  list.replaceChildren();
  for (const e of data.entries) {
    const li = document.createElement("li");
    li.textContent = [
      e.at,
      words[e.channel] ?? e.channel,
      words[e.event] ?? e.event,
      e.rule,
      e.revision ? words.revision + " " + e.revision : "",
      e.actor ? name(e.actor) : "",
      e.origin ? words.origin + " " + name(e.origin) : "",
      words[e.reason ?? ""] ?? e.reason,
      e.decision ? words[e.decision] : "",
      e.event === "automation.review" ? e.run : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (e.task) {
      const target = options!.tasks.find((t) => t.id === e.task);
      if (target) {
        const link = document.createElement("a");
        link.href =
          "/projects/" +
          encodeURIComponent(project.value) +
          "/automation?task=" +
          encodeURIComponent(target.id);
        link.textContent = target.name;
        li.append(" ", link);
      }
    }
    for (const op of e.actions) {
      const b = document.createElement("button");
      b.textContent = words[op]!;
      b.onclick = () =>
        run(async () => {
          b.disabled = true;
          try {
            await call({ op, run: e.run }, e.rule!);
          } finally {
            if (gen === historyGeneration) await history(byTask);
          }
        });
      li.append(" ", b);
    }
    list.append(li);
  }
  feedback.textContent = data.entries.length ? "" : words.empty!;
}
button("by-task").onclick = () => run(() => history(true));
button("by-rule").onclick = () => run(() => history(false));
run(async () => {
  const session = await json<{ user: typeof me; memberships: { workspaceId: string }[] }>(
    "/api/v1/me",
  );
  me = session.user;
  const workspace = new URLSearchParams(location.search).get("workspace");
  const groups = await Promise.all(
    session.memberships
      .filter((m) => !workspace || m.workspaceId === workspace)
      .map((m) =>
        json<{ projects: Choice[] }>(
          "/api/v1/workspaces/" + encodeURIComponent(m.workspaceId) + "/projects",
        ),
      ),
  );
  choices(
    project,
    groups.flatMap((g) => g.projects),
  );
  const id = location.pathname.match(/^\/projects\/([^/]+)\/automation$/)?.[1];
  if (id) project.value = id;
  if (project.value) {
    await load();
    const query = new URLSearchParams(location.search);
    if (query.has("task") && task.value === query.get("task")) await history(true);
    else if (query.get("rule")) {
      rule.value = query.get("rule")!;
      controls();
      await history(false);
    }
  } else {
    controls();
    node<HTMLFieldSetElement>("settings").disabled = true;
  }
});
