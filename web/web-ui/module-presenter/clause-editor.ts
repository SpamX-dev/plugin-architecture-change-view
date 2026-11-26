import type { ClauseChange, DeletedClause } from "../../../module-operations/api.js";
import type { ArchiViewClient, ClauseControls, ClauseItem, ComparisonView, ModuleDetail, Section } from "../view-model/types.js";
import { errorMessage } from "../view-model/types.js";
import { el } from "../views/dom.js";

function clauseDialog(title: string, section: Section, item: ClauseItem | undefined, deleted: DeletedClause[],
  save: (change: ClauseChange) => Promise<void>) {
  const id = item?.id;
  const removed = item?.change.status === "removed";
  const name = section === "purpose" ? "назначение" : id;
  const dialog = el("dialog", "clause-dialog");
  const heading = el("h2", "", id === undefined ? "Новый пункт" : (removed ? "Восстановить " : "Редактировать ") + name);
  heading.id = "clause-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const form = el("form");
  const fields = el("fieldset");
  fields.append(el("legend", "", title));
  const label = el("label", "", "Текст пункта");
  const input = el("textarea");
  const deletion = deleted.find(clause => clause.clauseId === id);
  input.value = String((removed ? deletion?.text ?? item?.change.before : item?.change.after) ?? "");
  input.readOnly = removed;
  input.required = true;
  input.rows = 5;
  label.append(input);
  fields.append(label);
  if (!item && deleted.length) {
    const recover = el("div", "clause-dialog-actions");
    for (const clause of deleted) {
      const restore = el("button", "text-button", "Восстановить " + clause.clauseId);
      restore.type = "button";
      restore.title = clause.text;
      restore.onclick = () => commit({ action: "restore", section, clauseId: clause.clauseId, undoToken: clause.undoToken });
      recover.append(restore);
    }
    fields.append(recover);
  }
  const error = el("div", "clause-edit-error");
  error.setAttribute("role", "alert");
  const actions = el("div", "clause-dialog-actions");
  const cancel = el("button", "button button-quiet", "Отмена");
  cancel.type = "button";
  cancel.onclick = () => dialog.close();
  const submit = el("button", "button button-primary", removed ? "Восстановить" : id === undefined ? "Добавить" : "Сохранить");
  submit.type = "submit";
  if (id !== undefined && section !== "purpose" && !removed) {
    const remove = el("button", "button clause-delete", "Удалить");
    remove.type = "button";
    remove.onclick = () => commit({ action: "delete", section, clauseId: id });
    actions.append(remove);
  }
  if (item?.change.status === "modified") {
    const revert = el("button", "button button-quiet", "Откатить");
    revert.type = "button";
    revert.title = "Вернуть текст из базы сравнения";
    revert.onclick = () => commit({ action: "revert", section, clauseId: item.id });
    actions.append(revert);
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
    if (removed && id !== undefined) {
      void commit(deletion ? { action: "restore", section, clauseId: id, undoToken: deletion.undoToken } : { action: "revert", section, clauseId: id });
      return;
    }
    if (!input.value.trim()) { error.textContent = "Введите текст пункта"; return; }
    if (id !== undefined) void commit({ action: "edit", section, clauseId: id, text: input.value });
    else if (section !== "purpose") void commit({ action: "add", section, text: input.value });
  };
  dialog.oncancel = event => { if (fields.disabled) event.preventDefault(); };
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  (removed ? submit : input).focus();
}

export function createClauseEditor(client: ArchiViewClient, saved: (view: ComparisonView, key: string, clause: { section: Section; clauseId: string }) => Promise<void>) {
  return (view: ComparisonView, detail: ModuleDetail): ClauseControls | undefined => {
    const contract = detail.after?.document.contract;
    if (!contract || view.published || view.target.id !== "current") return;
    async function save(change: ClauseChange) {
      const { clauseId } = await client.changeClause({ view: view.id, repository: view.workspace?.repository, path: detail.key, ...change });
      await saved(view, detail.key, { section: change.section, clauseId });
    }
    return {
      open(section, title, item) {
        const deleted = (detail.deletedClauses ?? []).filter(clause => clause.section === section &&
          (item ? clause.clauseId === item.id : !detail.contractDiff.fields.some(field => field.key === section + "." + clause.clauseId)));
        clauseDialog(title, section, item, deleted, save);
      },
    };
  };
}
