import type { ReviewBundle, EvidenceReference, Fact, Side } from "./types.js";
import { el } from "./dom.js";

/** Показывает зафиксированный текст доказательства с происхождением и координатами. */
function showEvidence(bundle: ReviewBundle, reference: EvidenceReference) {
  const fact = bundle.facts[reference.snapshot].find((entry) => entry.id === reference.fact_id);
  const dialog = el("dialog", "evidence-dialog");
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.type = "button";
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", "Доказательство · " + (reference.snapshot === "baseline" ? "версия для сравнения" : "проверенная версия")), close);
  dialog.append(heading, el("p", "evidence-origin", fact ? fact.path + (fact.start_line ? " · строки " + fact.start_line + "–" + fact.end_line : " · структура модуля") : "Факт недоступен"));
  const code = el("pre", "evidence-code", fact?.text ?? reference.fact_id);
  dialog.append(code);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Короткая ссылка сохраняет полное происхождение в доступном имени и подсказке. */
export function evidenceLabel(reference: Pick<EvidenceReference, "snapshot">, fact?: Pick<Fact, "path">) {
  const path = fact?.path ?? "Факт недоступен";
  return { name: path.split(/[\\/]/).at(-1),
    title: (reference.snapshot === "baseline" ? "Для сравнения" : "Проверенная версия") + " · " + path };
}

/** Нейтральные значки различают доказательства двух версий, не обещая успешной проверки. */
function evidenceIcon(side: Side) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("evidence-icon");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", side === "baseline" ? "M3 5a5 5 0 1 1-1 4M1 2v4h4M8 4v4l2 1" :
    "M4 1h5l3 3v11H4zM9 1v4h3M6 8h4M6 11h4");
  svg.append(shape);
  return svg;
}

/** Кнопки открывают только известные факты выбранного неизменяемого отчёта. */
export function evidenceLinks(bundle: ReviewBundle, references: EvidenceReference[]) {
  const links = el("div", "evidence-links");
  for (const ref of references) {
    const fact = bundle.facts[ref.snapshot].find((f) => f.id === ref.fact_id);
    const label = evidenceLabel(ref, fact);
    const button = el("button", "evidence-link");
    button.append(evidenceIcon(ref.snapshot), el("span", "", label.name));
    button.title = label.title;
    button.setAttribute("aria-label", label.title);
    button.type = "button";
    button.onclick = () => showEvidence(bundle, ref);
    links.append(button);
  }
  return links;
}
