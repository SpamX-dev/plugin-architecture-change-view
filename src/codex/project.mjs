/** Привязка процесса к проекту: каталог установки плагина не является рабочим проектом. */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Позволяет один раз выбрать существующую абсолютную папку, затем запрещает смену корня. */
export async function createProjectBinding(initialRoot) {
  let root;
  async function select(requested) {
    if (requested !== undefined) {
      if (typeof requested !== "string" || !path.isAbsolute(requested)) {
        throw new Error("projectRoot должен быть абсолютным путём к папке проекта");
      }
      const candidate = await realpath(requested);
      if (!(await stat(candidate)).isDirectory()) throw new Error("projectRoot должен указывать на папку");
      if (root && candidate !== root) throw new Error("Процесс уже привязан к другому проекту: " + root);
      root = candidate;
    }
    if (!root) throw new Error("Укажите projectRoot — абсолютный путь к проекту текущего чата");
    return root;
  }
  if (initialRoot !== undefined) await select(path.resolve(initialRoot));
  return { select, get root() { return root; } };
}
