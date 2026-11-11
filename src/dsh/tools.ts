/**
 * Модельные инструменты ArchiView для плагина dsh.
 *
 * Слой не зависит от cordis и SDK инструментов: он объявляет статические
 * описания (имя, описание, параметры) и чистые операции чтения контрактов.
 * Хост-половина (`host.ts`) превращает описания в определения `defineTool`,
 * поэтому этот модуль можно проверять обычным `node --test`.
 *
 * Инструменты только читают: анализ и запись arch.yaml выполняет агент своими
 * файловыми средствами по каноническому скиллу module-boundaries.
 *
 * @module plugin-architecture-change-view/dsh/tools
 */

import { moduleContext, moduleInventory, SOURCE_EXTENSIONS } from "../contracts/inventory.js";

/** Описание параметра `projectRoot`, общего для обоих инструментов. */
const PROJECT_ROOT_PARAMETER = {
  type: "string" as const,
  description: "Абсолютный корень проекта текущего чата. Необязателен, если корень задан " +
    "конфигурацией плагина; каталог установки плагина проектом не считается.",
};

/**
 * Статические определения инструментов модели.
 *
 * Порядок фиксирован: он же порядок регистрации в реестре инструментов dsh.
 * Схемы не содержат `projectRoot` как обязательный параметр, потому что корень
 * может быть закреплён конфигурацией; проверка выполняется в операции.
 *
 * @constant {ReadonlyArray<{ name: string, description: string, parameters: object }>}
 */
export const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "archiview_inventory",
    description: "List every source directory and arch.yaml coverage, including " +
      "missing/empty contracts, source-container directories and planned modules. " +
      "Presence is not a semantic compliance verdict. Read skill://module-boundaries.",
    parameters: Object.freeze({ projectRoot: PROJECT_ROOT_PARAMETER }),
  }),
  Object.freeze({
    name: "archiview_context",
    description: "Read arch.yaml for a target directory and all ancestors, root first. " +
      "Use before editing source code. Reports missing documents explicitly.",
    parameters: Object.freeze({
      projectRoot: PROJECT_ROOT_PARAMETER,
      directory: Object.freeze({
        type: "string" as const,
        description: "Каталог относительно корня проекта; по умолчанию корень.",
      }),
    }),
  }),
]);

/**
 * Собирает набор расширений исходников из настроек плагина.
 *
 * Базовый набор приходит из инвентаризации; конфигурация только добавляет
 * расширения в формате `.ext`. Пустое или некорректное значение — ошибка
 * конфигурации, а не молчаливое игнорирование.
 *
 * @param {readonly string[]} [configured] - дополнительные расширения из конфигурации.
 * @returns {Set<string>} расширения с ведущей точкой в нижнем регистре.
 * @throws {Error} если значение не является расширением.
 */
export function normalizeExtensions(configured: readonly string[] = []) {
  const extensions = new Set(SOURCE_EXTENSIONS);
  for (const value of configured) {
    if (typeof value !== "string" || !/^\.[a-z0-9]+$/i.test(value)) {
      throw new Error("Некорректное расширение исходников: " + String(value));
    }
    extensions.add(value.toLowerCase());
  }
  return extensions;
}

/**
 * Выбирает корень проекта для операции.
 *
 * Приоритет у явного аргумента вызова: агент может работать с проектом,
 * отличным от закреплённого. Корень из URL запроса никогда не принимается —
 * иначе маршрут панели читал бы произвольный каталог.
 *
 * @param {object} options - параметры выбора.
 * @param {unknown} options.projectRoot - значение аргумента инструмента.
 * @param {string} [options.fallback] - корень из конфигурации плагина.
 * @returns {string} абсолютный или относительный корень, переданный сервису.
 * @throws {Error} если корень не задан ни одним способом.
 */
export function resolveRoot({ projectRoot, fallback }: { projectRoot?: unknown; fallback?: string }) {
  const value = typeof projectRoot === "string" && projectRoot.trim() !== ""
    ? projectRoot.trim()
    : fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Передайте projectRoot или задайте root в конфигурации плагина ArchiView");
  }
  return value.trim();
}

/**
 * Читает инвентаризацию каталогов проекта.
 *
 * @param {object} options - параметры чтения.
 * @param {string} options.root - корень проекта.
 * @param {Set<string>} options.extensions - расширения исходников.
 * @param {number} options.maxFiles - предел обхода.
 * @returns {Promise<object>} результат `moduleInventory` без изменений формы.
 */
export async function readInventory({ root, extensions, maxFiles }: { root: string; extensions: Set<string>; maxFiles: number }) {
  return moduleInventory(root, { extensions, maxFiles });
}

/**
 * Читает контракт каталога и всех предков.
 *
 * @param {object} options - параметры чтения.
 * @param {string} options.root - корень проекта.
 * @param {string} [options.directory] - каталог относительно корня.
 * @returns {Promise<object>} результат `moduleContext` без изменений формы.
 */
export async function readContext({ root, directory = "." }: { root: string; directory?: unknown }) {
  if (typeof directory !== "string") throw new Error("directory должен быть строкой");
  return moduleContext(root, directory);
}
