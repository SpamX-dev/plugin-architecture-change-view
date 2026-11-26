import type { ReviewSetting, ReviewSettings } from "../../../module-operations/api.js";
import type { ArchiViewClient, ComparisonView } from "../types.js";
import { errorMessage } from "../types.js";
import { el } from "../views/dom.js";

export function openReviewSettings(client: ArchiViewClient, view: ComparisonView) {
  const repository = view.workspace?.repository;
  const dialog = el("dialog", "project-settings");
  const title = el("h2", "", "Настройки проекта");
  title.id = "project-settings-heading";
  dialog.setAttribute("aria-labelledby", title.id);
  const project = el("p", "settings-project", view.root);
  const fields = el("fieldset");
  const status = el("div", "settings-status", "Читаем настройки…");
  status.setAttribute("role", "status");
  const hookStatus = el("div", "settings-hint");
  const close = el("button", "button button-quiet", "Закрыть");
  close.type = "button";
  close.onclick = () => dialog.close();
  const actions = el("div", "clause-dialog-actions");
  actions.append(close);

  function option(setting: ReviewSetting, label: string, hint: string) {
    const row = el("label", "settings-option");
    const input = el("input");
    input.type = "checkbox";
    const copy = el("span");
    const name = el("strong", "", label);
    name.id = "setting-" + setting;
    input.setAttribute("aria-labelledby", name.id);
    copy.append(name, el("span", "settings-hint", hint));
    row.append(input, copy);
    fields.append(row);
    input.onchange = () => { void loadOrSave(setting, input.checked); };
    return input;
  }
  const auto = option("autoAnalysis", "Автоанализ изменений", "Перед ответом подагенты обновляют нужные анализы и разбирают замечания. При завершении ArchiView проверяет, что ещё осталось.");
  const codex = option("codexHooks", "Подключить хуки Codex", "Добавляет UserPromptSubmit и Stop в .codex/hooks.json этого репозитория.");
  const trustText = {
    trusted: "Codex подтвердил доверие к обоим хукам.",
    needsTrust: "Требуется подтверждение. Откройте /hooks в Codex и подтвердите оба хука ArchiView.",
    disabled: "Хуки отключены в Codex. Проверьте их в /hooks.",
    unknown: "Статус Codex недоступен. Проверить хуки можно в /hooks.",
  };
  let saved: ReviewSettings | undefined;
  function render(value: ReviewSettings) {
    auto.checked = value.autoAnalysis;
    codex.checked = value.codexHooks === "on";
    codex.indeterminate = value.codexHooks === "partial";
    hookStatus.textContent = value.codexHooks === "partial" ? "Настройка неполная. Включите хуки, чтобы восстановить подключение."
      : value.codexStatus ? trustText[value.codexStatus] : "";
  }
  async function loadOrSave(setting?: ReviewSetting, enabled = false) {
    fields.disabled = true;
    if (setting) status.textContent = "Сохраняем…";
    try {
      saved = setting ? await client.setReviewSetting({repository, setting, enabled}) : await client.getReviewSettings({repository});
      render(saved);
      status.textContent = setting ? "Сохранено" : "";
    } catch (error) {
      if (saved) render(saved);
      status.textContent = errorMessage(error);
    } finally { fields.disabled = !saved; }
  }
  dialog.append(title, project, fields, hookStatus, status, actions);
  dialog.addEventListener("close", () => dialog.remove(), { once:true });
  document.body.append(dialog);
  dialog.showModal();
  void loadOrSave();
}
