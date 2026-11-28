const form = document.querySelector<HTMLFormElement>("#rule-form")!;
const panel = document.getElementById("confirmation")!;
const feedback = document.getElementById("feedback")!;
const publish = document.querySelector<HTMLButtonElement>("#publish")!;
let pending: { url: string; body: Record<string, unknown> } | undefined;
let generation = 0;
function clear() {
  generation++;
  pending = undefined;
  panel.hidden = true;
}
form.oninput = clear;
async function submit(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw Error(
      response.status === 409
        ? "Rule changed. Check the revision and preview again."
        : "Check access, rule definition and project values.",
    );
  return response.json();
}
form.onsubmit = async (e) => {
  e.preventDefault();
  clear();
  const current = generation;
  try {
    const fields = new FormData(form);
    const url =
      "/api/v1/projects/" +
      encodeURIComponent(String(fields.get("project"))) +
      "/automation/" +
      encodeURIComponent(String(fields.get("rule")));
    const me = await fetch("/api/v1/me");
    if (!me.ok) throw Error("Sign in to Prood first.");
    const body = {
      definition: JSON.parse(String(fields.get("definition"))),
      revision: Number(fields.get("revision")),
      delegate: (await me.json()).user.id,
    };
    const result = await submit(url, { ...body, op: "preview" });
    if (current !== generation) return;
    const summary = document.getElementById("summary")!;
    summary.replaceChildren();
    const fieldNames: Record<string, string> = { assigneeId: "assignee", statusId: "status" };
    const triggerNames: Record<string, string> = {
      "task.created": "Task is created",
      "status.changed": "Status changes",
      "assignee.changed": "Assignee changes",
      manual: "Started manually for a task",
    };
    const show = (value: unknown) =>
      value === null
        ? "None"
        : typeof value === "string"
          ? (result.labels[value] ?? value)
          : undefined;
    const setting = result.definition.action.value;
    for (const [label, value] of Object.entries({
      When: triggerNames[result.definition.when],
      From: show(result.definition.from),
      To: show(result.definition.to),
      Condition: result.definition.ifUnassigned ? "Task has no assignee" : "Always",
      Action: "Set " + fieldNames[result.definition.action.field],
      Value:
        setting && typeof setting === "object"
          ? "Event " + fieldNames[setting.event]
          : show(setting),
      Project: result.projectName,
      "Run as": result.delegateName + " (" + result.delegate + ")",
    })) {
      if (value === undefined) continue;
      const term = document.createElement("dt"),
        description = document.createElement("dd");
      term.textContent = label;
      description.textContent = String(value);
      summary.append(term, description);
    }
    pending = { url, body };
    panel.hidden = false;
    publish.focus();
    feedback.textContent = "Review the rule before publishing. Actions are prepared only.";
  } catch (error) {
    if (current === generation)
      feedback.textContent = error instanceof Error ? error.message : "Preview failed.";
  }
};
publish.onclick = async () => {
  const request = pending;
  if (!request) return;
  clear();
  const current = generation;
  try {
    const result = await submit(request.url, { ...request.body, op: "publish" });
    if (current === generation)
      feedback.textContent = "Published revision " + result.revision + ".";
  } catch (error) {
    if (current === generation)
      feedback.textContent = error instanceof Error ? error.message : "Publication failed.";
  }
};
