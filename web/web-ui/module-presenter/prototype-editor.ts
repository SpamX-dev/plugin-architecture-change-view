import type { PrototypeChange } from "../../../module-operations/api.js";
import type { ArchiViewClient, ComparisonView, ModuleDetail } from "../types.js";
import { errorMessage } from "../types.js";
import { el } from "../views/dom.js";
import { prototypeLocation } from "../workspace-presenter/prototype-location.js";

type Mode = "create" | "edit" | "delete";
const headings: Record<Mode, string> = {
  create: "Новый прототип", edit: "Редактировать контракт", delete: "Удалить прототип",
};

export function prototypeDialog(mode: Mode, client: ArchiViewClient, view: ComparisonView,
  detail: ModuleDetail | null, saved: (directory: string) => Promise<void>) {
  const dialog = el("dialog", "clause-dialog prototype-dialog");
  const title = el("h2", "", headings[mode]);
  title.id = "prototype-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const form = el("form");
  const fields = el("fieldset");
  function field(labelText: string, multiline = false, value = "") {
    const label = el("label", "", labelText);
    const input = multiline ? el("textarea") : el("input");
    input.required = true;
    input.value = value;
    label.append(input);
    fields.append(label);
    return input;
  }
  const selection = { repository: view.workspace?.repository, view: view.id, path: detail?.key ?? "." };
  let change: () => PrototypeChange;
  if (mode === "create") {
    const location = prototypeLocation(dialog, view.modules);
    fields.append(location.element);
    const name = field("Название");
    const purpose = field("Назначение", true);
    change = () => ({ ...selection, action: "create", path: location.directory, moduleId: location.moduleId,
      title: name.value.trim(), purpose: purpose.value.trim() });
  } else if (mode === "edit") {
    const yaml = field("Контракт YAML", true, detail?.contractYaml ?? detail?.after?.document.text ?? "");
    yaml.classList.add("prototype-yaml");
    yaml.spellcheck = false;
    change = () => ({ ...selection, action: "edit", text: yaml.value });
  } else {
    fields.append(el("p", "", "Удалить контракт «" + detail?.title + "» и его запись в карте? Исходники и вложенные модули сохранятся."));
    change = () => ({ ...selection, action: "delete" });
  }
  const error = el("div", "clause-edit-error");
  error.setAttribute("role", "alert");
  const actions = el("div", "clause-dialog-actions");
  const cancel = el("button", "button button-quiet", "Отмена");
  cancel.type = "button";
  cancel.onclick = () => dialog.close();
  const submit = el("button", mode === "delete" ? "button prototype-remove" : "button button-primary",
    { create: "Создать", edit: "Сохранить", delete: "Удалить" }[mode]);
  submit.type = "submit";
  actions.append(cancel, submit);
  fields.append(error, actions);
  form.append(fields);
  form.onsubmit = async event => {
    event.preventDefault();
    if (fields.disabled) return;
    fields.disabled = true;
    try {
      const result = await client.changePrototype(change());
      dialog.close();
      await saved(result.directory);
    } catch (cause) {
      fields.disabled = false;
      error.textContent = errorMessage(cause);
    }
  };
  dialog.oncancel = event => { if (fields.disabled) event.preventDefault(); };
  dialog.onclose = () => dialog.remove();
  dialog.append(title, form);
  document.body.append(dialog);
  dialog.showModal();
}
