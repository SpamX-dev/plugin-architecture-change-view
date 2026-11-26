import { openFinding, type FindingDisposition } from "../../../framework/ai-report/types.js";
import { errorMessage, type Finding, type ReviewBundle, type ReviewRenderOptions } from "../view-model/types.js";
import { el } from "./dom.js";

export function findingDecision(bundle: ReviewBundle, finding: Finding, options: ReviewRenderOptions) {
  const current = bundle.dispositions?.[finding.id] ?? {...openFinding, ...(finding.lifecycle === "resolved" ? {status:"resolved" as const} : {})};
  const form = el("form", "finding-decision");
  const label = el("label", "", "Статус");
  const status = el("select");
  status.id = "finding-status-" + crypto.randomUUID();
  label.htmlFor = status.id;
  for (const [value, title] of [["open","Открыто"], ["accepted","Принято"], ["resolved","Закрыто"]]) {
    const option = el("option", "", title);
    option.value = value;
    status.append(option);
  }
  status.value = current.status;
  const decisionLabel = el("label", "", "Решение");
  const decision = el("textarea");
  decision.rows = 2;
  decision.value = current.decision;
  decisionLabel.append(decision);
  form.append(label, status, decisionLabel);
  if (!options.saveDecision) { status.disabled = true; decision.readOnly = true; return form; }
  const save = el("button", "button button-quiet", "Сохранить решение");
  const message = el("span");
  message.setAttribute("role", "status");
  form.append(save, message);
  form.onsubmit = async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      await options.saveDecision!(bundle.report.id, finding.id, {status:status.value as FindingDisposition["status"], decision:decision.value}, current);
      message.textContent = "Сохранено";
    } catch (error) { message.textContent = errorMessage(error); }
    finally { save.disabled = false; }
  };
  return form;
}
