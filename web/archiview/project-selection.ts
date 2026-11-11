import { errorMessage } from "./types.js";
import { byId, el, notice } from "./dom.js";

/** Прямое открытие плагина не содержит пути чата; пользователь выбирает его один раз. */
export function renderProjectSelection({ projectHint, chooseProject, openProject }: {
  projectHint?: string;
  chooseProject?: () => Promise<string | null>;
  openProject: (path: string) => Promise<void>;
}) {
  byId("project-name").textContent = "Выберите проект";
  byId("project-path").textContent = "";
  byId("tree").replaceChildren();
  const box = notice("Папка проекта", projectHint ?? "Укажите абсолютный путь к проекту.");
  const form = el("form", "project-form");
  const input = el("input");
  input.type = "text";
  input.required = true;
  input.setAttribute("aria-label", "Папка проекта");
  input.placeholder = "D:\\projects\\my-project";
  const submit = el("button", "button", "Открыть проект");
  submit.type = "submit";
  const error = el("p");
  error.setAttribute("role", "alert");
  form.append(input);
  if (chooseProject) {
    const browse = el("button", "button button-quiet", "Выбрать папку…");
    browse.type = "button";
    browse.addEventListener("click", async () => {
      browse.disabled = true;
      error.textContent = "";
      try {
        const path = await chooseProject();
        if (path) {
          input.value = path;
          form.requestSubmit();
        }
      } catch (cause) { error.textContent = errorMessage(cause); }
      finally { browse.disabled = false; }
    });
    form.append(browse);
  }
  form.append(submit, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      await openProject(input.value.trim());
    } catch (cause) { error.textContent = errorMessage(cause); }
    finally { submit.disabled = false; }
  });
  box.append(form);
  byId("document-panel").replaceChildren(box);
}
