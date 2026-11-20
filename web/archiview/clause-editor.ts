import { clauseEntries } from "../../src/contracts/types.js";
import type { ClauseChange } from "../../src/application/api.js";
import type { ArchiViewClient, ComparisonView, ModuleDetail, Section } from "./types.js";
import { errorMessage } from "./types.js";
import { el } from "./dom.js";

export interface ClauseControls {
  open(section: Section, title: string, id?: string): void;
  undo?: { section: Section; id: string; restore(): Promise<void> };
}

function clauseDialog(title: string, section: Section, clauses: Record<string, string>, id: string | undefined,
  save: (change: ClauseChange) => Promise<void>) {
  const dialog = el("dialog", "clause-dialog");
  const heading = el("h2", "", id === undefined ? "Новый пункт" : "Редактировать " + (section === "purpose" ? "назначение" : id));
  heading.id = "clause-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const form = el("form");
  const fields = el("fieldset");
  fields.append(el("legend", "", title));
  const key = el("input");
  if (id === undefined) {
    const label = el("label", "", "ID нового пункта");
    key.placeholder = { purpose: "", boundaries: "B…", invariants: "I…" }[section];
    key.required = true;
    key.autocomplete = "off";
    label.append(key);
    fields.append(label);
  }
  const label = el("label", "", "Текст пункта");
  const input = el("textarea");
  input.value = id === undefined ? "" : clauses[id] ?? "";
  input.required = true;
  input.rows = 5;
  label.append(input);
  fields.append(label);
  const error = el("div", "clause-edit-error");
  error.setAttribute("role", "alert");
  const actions = el("div", "clause-dialog-actions");
  const cancel = el("button", "button button-quiet", "Отмена");
  cancel.type = "button";
  cancel.onclick = () => dialog.close();
  const submit = el("button", "button button-primary", id === undefined ? "Добавить" : "Сохранить");
  submit.type = "submit";
  if (id !== undefined && section !== "purpose") {
    const remove = el("button", "button clause-delete", "Удалить");
    remove.type = "button";
    remove.onclick = () => commit({ action: "delete", section, clauseId: id });
    actions.append(remove);
  }
  actions.append(cancel, submit);
  fields.append(error, actions);
  form.append(fields);
  dialog.append(heading, form);
  async function commit(change: ClauseChange) {
    if (fields.disabled) return;
    fields.disabled = true;
    error.textContent = "";
    try {
      await save(change);
      dialog.close();
    } catch (cause) {
      fields.disabled = false;
      error.textContent = errorMessage(cause);
    }
  }
  form.onsubmit = event => {
    event.preventDefault();
    const clauseId = id ?? key.value.trim();
    if (!clauseId || !input.value.trim()) { error.textContent = "Заполните ID и текст пункта"; return; }
    void commit({ action: id === undefined ? "add" : "edit", section, clauseId, text: input.value });
  };
  dialog.oncancel = event => { if (fields.disabled) event.preventDefault(); };
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  (id === undefined ? key : input).focus();
}

export function createClauseEditor(client: ArchiViewClient, saved: (view: ComparisonView, key: string, change: ClauseChange) => Promise<void>,
  showError: (message: string) => void) {
  return (view: ComparisonView, detail: ModuleDetail): ClauseControls | undefined => {
    const contract = detail.after?.document.contract;
    if (!contract || view.published || view.target.id !== "current") return;
    const deleted = detail.deletedClause;
    async function save(change: ClauseChange) {
      await client.changeClause({ view: view.id, repository: view.workspace?.repository, path: detail.key, ...change });
      await saved(view, detail.key, change);
    }
    return {
      open: (section, title, id) => clauseDialog(title, section, clauseEntries(contract, section), id, save),
      undo: deleted
        ? { section: deleted.section, id: deleted.clauseId, async restore() {
          try { await save({ action: "restore", section: deleted.section, clauseId: deleted.clauseId, undoToken: deleted.undoToken }); }
          catch (cause) { showError(errorMessage(cause)); }
        } } : undefined,
    };
  };
}
