import { bindHarnessMenu } from "./harness-menu.js";
import { findingFixPrompt } from "../../../module-operations/finding-fix.js";
export { findingFixPrompt };
import { clauseEntries } from "../../../framework/contracts/types.js";
import type { ReviewBundle, Finding, ClauseReference, Contract, FixRecord, ReviewRenderOptions } from "../view-model/types.js";
import { errorMessage } from "../view-model/types.js";
import { el } from "./dom.js";

/** Дата обозначает выполнение анализа; время сохранения исходников не выдумывается. */
export function reviewDate(bundle: ReviewBundle) {
  return new Date(bundle.report.analysis.created_at).toLocaleString("ru-RU");
}

/**
 * Ошибка показывается один раз; неполный старый отчёт не скрывает общий вывод.
 * Исторический contract_change не является замечанием: его диф принадлежит контракту.
 */
export function reviewFindingItems(bundle: ReviewBundle): Finding[] {
  const findings = bundle.report.findings.filter((finding) => finding.kind !== "contract_change");
  if (findings.length) return findings;
  const current = bundle.report.assessment.current;
  return current.verdict === "violation" ? [{ id: "assessment-summary", summary: current.summary,
    assessmentOnly: true, severity: "error", clauses: [], evidence: [] }] : [];
}

/**
 * Замечания связаны с устойчивым пунктом отдельно от изменения его текста.
 * Каждый результат ведёт в конкретную попытку анализа и конкретное замечание;
 * исходные статусы, текст и доказательства отчёта остаются неизменными.
 */
export function clauseFindingTargets(bundle: ReviewBundle | null | undefined, contract: Pick<Contract, "id"> & Partial<Contract>, section: ClauseReference["section"], id: string) {
  if (!bundle || bundle.report.module.id !== contract.id) return [];
  const side = bundle.report.module.current_path === null ? "baseline" : "current";
  const matches = (ref: ClauseReference) => ref.snapshot === side && ref.module_id === contract.id && ref.section === section && ref.id === id;
  const saved = bundle.contracts[side].find((item) => matches(item.reference));
  if (!saved) return [];
  const findings = reviewFindingItems(bundle).filter((finding) => (bundle.dispositions?.[finding.id]?.status ?? (finding.lifecycle === "resolved" ? "resolved" : "open")) === "open" &&
    (finding.assessmentOnly ? bundle.report.checks.some((check) => check.subject === side &&
      check.verdict === "violation" && matches(check.contract)) : finding.clauses.some(matches)));
  return findings.map((finding) => ({ reviewId: bundle.report.id, findingId: finding.id,
    severity: finding.severity, summary: finding.summary,
    label: finding.summary + " · анализ от " + reviewDate(bundle) +
      (saved.text !== clauseEntries(contract, section)[id] ? " · текст пункта изменён после анализа" : "") +
      (bundle.freshness?.current?.status !== "fresh" ? " · нужна перепроверка" : "") }));
}

export { findingBug } from "./dom.js";

/** Keep the action status on its original finding when the review is redrawn. */
export function findingFixAction(bundle: ReviewBundle, finding: Finding, options: ReviewRenderOptions) {
  const prompt = findingFixPrompt(options.projectRoot, bundle, finding);
  if (!prompt || !options.copyFixPrompt) return null;
  const copyPrompt = options.copyFixPrompt;
  const key = JSON.stringify([options.projectRoot, bundle.report.id, finding.id]);
  const record: FixRecord = options.fixStates?.get(key) ?? { status: "idle", message: "" };
  options.fixStates?.set(key, record);
  const actions = el("div", "finding-actions");
  const picker = el("div", "analysis-picker finding-picker");
  const button = el("button", "button button-primary finding-fix");
  button.type = "button";
  const menu = el("div", "analysis-menu");
  menu.id = "fix-menu-" + crypto.randomUUID();
  menu.hidden = true;
  const hosts = el("div");
  const copy = el("button", "copy-fix-prompt", "Копировать промпт");
  copy.type = "button";
  button.setAttribute("aria-controls", menu.id);
  button.setAttribute("aria-expanded", "false");
  menu.append(hosts, copy);
  picker.append(button, menu);
  const status = el("span", "finding-fix-status");
  status.setAttribute("role", "status");
  const update = () => {
    const pending = record.status === "pending";
    button.disabled = pending;
    button.textContent = pending ? "Подождите…" : "Исправить";
    button.title = "Выбрать harness для исправления замечания";
    status.textContent = record.message;
    status.hidden = !record.message;
    status.classList.toggle("error", record.status === "error");
  };
  const run = async (harnessId?: string) => {
    if (record.status === "pending") return;
    record.status = "pending";
    record.message = "";
    update();
    try {
      if (harnessId && options.deliverFix) {
        // Keep the attempt ID if the HTTP acknowledgement was lost.
        const attempt = record.attempt?.harnessId === harnessId ? record.attempt : { id: crypto.randomUUID(), harnessId };
        record.attempt = attempt;
        const receipt = await options.deliverFix({ ...attempt, reviewId: bundle.report.id, findingId: finding.id });
        record.status = receipt.state === "sent" ? "sent" : "error";
        if (receipt.state !== "pending") record.attempt = undefined;
        if (receipt.state === "sent") {
          record.message = "Поручение отправлено в новый чат " + receipt.name + ".";
        } else {
          record.message = "Доставка в " + receipt.name + " пока не подтверждена. Проверьте чат." + (receipt.message ? " " + receipt.message : "");
        }
      } else {
        await copyPrompt(prompt);
        record.status = "copied";
        record.message = "Промпт скопирован. Вставьте его в чат с агентом.";
      }
    } catch (error) {
      record.status = "error";
      record.message = (harnessId ? "Не удалось подтвердить доставку: " : "Не удалось скопировать промпт: ") + errorMessage(error);
    }
    update();
    if (!actions.isConnected) options.fixChanged?.(bundle.report.id);
  };
  bindHarnessMenu(button, menu, hosts, copy, () => ({
    list: options.listFixHarnesses ?? (async () => ({ harnesses: [] })),
    current: () => actions.isConnected && record.status !== "pending",
    choose: id => void run(id), copy: () => void run(),
  }));
  update();
  actions.append(picker, status);
  return actions;
}
