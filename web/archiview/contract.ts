import { clauseEntries, type StoredContract } from "../../src/contracts/types.js";
import type { Section, Contract, ClauseReference, ReviewBundle, ContractDocument, ContractRenderOptions } from "./types.js";
import { el, icon } from "./dom.js";
import { ROLE_EXTENSION } from "../../src/contracts/roles.js";
import { roleBadge } from "./role-badge.js";
import { clauseFindingTargets, findingBug } from "./findings.js";

const sections = { boundaries: "Границы", invariants: "Инварианты" } as const;
type FieldChange = ContractRenderOptions["contractDiff"]["fields"][number];

/** Диф выбранного поля показывает обе сохранённые версии без чтения рабочих файлов. */
function showContractChange(change: FieldChange, label: string) {
  const dialog = el("dialog", "contract-diff-dialog");
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", label + " · диф"), close);
  const columns = el("div", "contract-diff-columns");
  for (const [key, title, kind] of [["before", "Было", "removed"], ["after", "Стало", "added"]]) {
    const column = el("section", "contract-diff-side " + kind);
    const value = change[key as "before" | "after"];
    column.append(el("h3", "", title), el("pre", "", value === undefined ? "Отсутствует" :
      typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    columns.append(column);
  }
  dialog.append(heading, columns);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Выделенное поле открывает диф одинаково в заголовке и в пунктах контракта. */
function decorateContractChange(node: HTMLElement, change: FieldChange | undefined, label: string) {
    node.classList.remove("contract-change", "change-added", "change-removed", "change-modified");
    node.querySelector(":scope > .contract-change-action")?.remove();
    node.removeAttribute("title");
    node.onclick = null;
    if (!change || change.status === "unchanged") return node;
    node.classList.add("contract-change", "change-" + change.status);
    const button = el("button", "contract-change-action",
      { added: "+", removed: "−", modified: "~" }[change.status]);
    button.type = "button";
    button.title = label + " · " + { added: "добавлено", removed: "удалено", modified: "изменено" }[change.status] + " · показать диф";
    button.setAttribute("aria-label", button.title);
    button.onclick = () => showContractChange(change, label);
    node.append(button);
    node.title = button.title;
    node.onclick = (event) => { if (event.target instanceof Element && !event.target.closest("button, a") && event.target.closest(".contract-change") === node) showContractChange(change, label); };
    return node;
}

function clauseRow(contract: StoredContract, section: Section, id: string, title: string,
  change: FieldChange, options: ContractRenderOptions) {
  const controls = options.clauseControls;
  const row = el("div", "clause-row");
  row.dataset.contractClause = "";
  row.dataset.clauseSection = section;
  row.dataset.clauseId = id;
  row.dataset.changeStatus = change.status;
  if (section !== "purpose") row.append(el("code", "clause-id", id));
  row.append(el("p", "", section === "purpose" ? contract.purpose ?? "Назначение не задано" : change.after ?? change.before));
  decorateContractChange(row, change, section === "purpose" ? title : id);
  if (change.status === "unchanged") row.title = "Пункт не изменялся";
  const findings = clauseFindingTargets(options.review, contract, section, id);
  const editable = controls && (section === "purpose" || Object.hasOwn(contract[section], id));
  if (findings.length || editable) {
    const issues = el("div", "clause-issues");
    if (editable) {
      const edit = el("button", "clause-edit-action");
      edit.type = "button";
      edit.title = "Редактировать " + (section === "purpose" ? "назначение" : id);
      edit.setAttribute("aria-label", edit.title);
      edit.append(icon("edit"));
      edit.onclick = () => controls.open(section, title, id);
      issues.append(edit);
    }
    for (const finding of findings) {
      const button = el("button", "clause-issue " + finding.severity);
      button.type = "button";
      button.title = finding.label;
      button.setAttribute("aria-label", "Открыть замечание: " + finding.summary);
      button.dataset.findingId = finding.findingId;
      button.append(findingBug());
      button.onclick = () => options.openFinding?.(finding);
      button.disabled = !options.openFinding;
      issues.append(button);
    }
    row.append(issues);
  }
  return row;
}

/** Единый заголовок модуля содержит метаданные контракта без повторного названия. */
export function renderContractHeading(panel: HTMLElement, document: ContractDocument, options: ContractRenderOptions) {
  const contract = document.contract;
  if (!contract) return;
  const header = el("div", "contract-header");
  const title = options.titleElement ?? el("h2", "", contract.title);
  title.textContent = contract.title;
  title.className = "";
  title.removeAttribute("title");
  title.onclick = null;
  header.append(el("span", "contract-kind", contract.kind === "group" ? "ГРУППА МОДУЛЕЙ" : "КОНТРАКТ МОДУЛЯ"),
    el("code", "contract-id", contract.id));
  if (!options.titleElement) header.append(title);
  const purpose = options.contractDiff.fields.find(item => item.key === "purpose") ??
    { key: "purpose", before: undefined, after: contract.purpose, status: "unchanged" };
  const row = clauseRow(contract, "purpose", "purpose", "Назначение", purpose, options);
  row.classList.add("contract-purpose");
  header.append(row);
  panel.append(header);
  decorateContractChange(options.groupElement ?? header,
    options.contractDiff.heading, "Описание модуля");
}

/** Роли сохраняют собственную окраску, даже если другие дополнения контракта менялись. */
export function renderContractRoles(panel: HTMLElement, diff: ContractRenderOptions["contractDiff"], extensions?: Contract["extensions"]) {
  if (!diff.roles.length) return;
  const block = el("section", "clause-section contract-role-section");
  block.append(el("h3", "", "Роли по контракту"));
  const list = el("ul", "contract-roles");
  for (const role of diff.roles) {
    const item = el("li");
    item.append(roleBadge(role));
    list.append(item);
  }
  block.append(list);
  const other = Object.entries(extensions ?? {}).filter(([key]) => key !== ROLE_EXTENSION);
  if (other.length) block.append(el("p", "contract-extra", "Дополнения: " + JSON.stringify(Object.fromEntries(other))));
  panel.append(decorateContractChange(block, diff.fields.find(field => field.key === "extensions"),
    other.length ? "Дополнения" : "Роли по контракту"));
}

/** Контракт выделяет изменённые поля; удалённые пункты остаются в своих разделах. */
export function renderContract(panel: HTMLElement, document: ContractDocument, options: ContractRenderOptions) {
  const contract = document.contract;
  if (!contract) return;
  const changes = options.contractDiff.fields;
  const byKey = new Map(changes.map((item) => [item.key, item]));
  const decorate = (node: HTMLElement, key: string, label: string) => decorateContractChange(node, byKey.get(key), label);
  const paper = el("article", "contract-paper");
  if (!options.hideHeading) renderContractHeading(paper, document, options);
  renderContractRoles(paper, options.contractDiff, contract.extensions);
  for (const [section, title] of (Object.entries(sections) as [Section, string][])) {
    const block = el("section", "clause-section");
    const heading = el("div", "clause-section-heading");
    heading.append(el("h3", "", title));
    block.append(heading);
    const controls = options.clauseControls;
    if (controls) {
      const add = el("button", "text-button", "+ Добавить пункт");
      add.type = "button";
      add.setAttribute("aria-label", "Добавить пункт · " + title);
      add.onclick = () => controls.open(section, title);
      heading.append(add);
      const undo = controls.undo;
      if (undo?.section === section) {
        const bar = el("div", "clause-undo");
        const restore = el("button", "text-button", "Восстановить " + undo.id);
        restore.onclick = async () => {
          restore.disabled = true;
          try { await undo.restore(); } finally { restore.disabled = false; }
        };
        bar.append(el("span", "", "Пункт " + undo.id + " удалён"), restore);
        block.append(bar);
      }
    }
    const entries = changes.filter((item) => item.key.startsWith(section + "."));
    if (!entries.length) block.append(el("p", "empty-clauses", "Пункты не заданы"));
    for (const change of entries) {
      const id = change.key.slice(section.length + 1);
      block.append(clauseRow(contract, section, id, title, change, options));
    }
    paper.append(block);
  }
  for (const [key, label] of [["rationale", "Обоснование"], ["owners", "Владельцы"], ["tags", "Метки"], ["extensions", "Дополнения"]]) {
    if (key === "extensions" && options.contractDiff.roles.length) continue;
    const change = byKey.get(key);
    if (!change) continue;
    const value = change.after ?? change.before;
    const text = Array.isArray(value) ? value.join(" · ") : typeof value === "string" ? value : JSON.stringify(value);
    paper.append(decorate(el("p", "contract-extra", label + ": " + text), key, label));
  }
  const references = el("div", "");
  for (const reference of contract.references ?? options.previousReferences ?? []) {
    const row = el("p", "contract-extra");
    if (/^https?:\/\//i.test(reference.uri)) {
      const link = el("a", "", reference.title);
      link.href = reference.uri; link.target = "_blank"; link.rel = "noopener noreferrer";
      row.append(link);
    } else row.textContent = reference.title + " · " + reference.uri;
    references.append(row);
  }
  if (byKey.has("references")) {
    if (!references.childNodes.length) references.append(el("p", "contract-extra", "Ссылки: не заданы"));
    paper.append(decorate(references, "references", "Ссылки"));
  }
  const raw = el("details", "raw-document");
  raw.append(el("summary", "", "YAML контракта"));
  if (options.rawChanged && options.showRawDiff) {
    const diff = el("button", "button button-quiet", "Диф YAML");
    diff.onclick = options.showRawDiff;
    raw.append(diff);
  }
  raw.append(el("pre", "", document.text));
  paper.append(raw);
  panel.append(paper);
}

/**
 * Пункт разрешается по сохранённому контракту выбранной попытки и указанной в
 * ссылке стороне снимка. Активное сравнение могло уже не содержать этот пункт,
 * поэтому сохранённый текст остаётся доступен отдельно от текущего документа.
 */
export function savedClauseText(bundle: ReviewBundle | null | undefined, ref: ClauseReference) {
  if (!ref?.snapshot) return null;
  for (const items of [bundle?.contracts?.[ref.snapshot], bundle?.referencedContracts?.[ref.snapshot]]) {
    if (!Array.isArray(items)) continue;
    const saved = items.find((item) => item.reference?.module_id === ref.module_id &&
      item.reference?.section === ref.section && item.reference?.id === ref.id);
    if (typeof saved?.text === "string" && saved.text.trim()) return saved.text;
  }
  return null;
}

/** Navigation may highlight a live clause only when it still has the saved meaning. */
export function savedClauseMatchesContract(bundle: ReviewBundle, ref: ClauseReference, contract: StoredContract | null | undefined): boolean {
  const saved = savedClauseText(bundle, ref);
  return saved !== null && contract?.id === ref.module_id && clauseEntries(contract, ref.section)[ref.id] === saved;
}

/** Подпись раздела нужна переходам и историческим карточкам, а не только дифу. */
export function clauseSectionLabel(section: string) {
  if (section === "purpose") return "Назначение";
  if (section === "responsibilities") return "Ответственность";
  return sections[section as keyof typeof sections] ?? section;
}
