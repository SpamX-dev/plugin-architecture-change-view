/**
 * Модельные инструменты ArchiView для плагина dsh.
 *
 * Слой не зависит от cordis и SDK инструментов: он объявляет статические
 * описания (имя, описание, параметры) и чистые операции чтения контрактов.
 * Хост-половина (`host.ts`) превращает описания в определения `defineTool`,
 * поэтому этот модуль можно проверять обычным `node --test`.
 *
 * Инструменты только читают: анализ и запись карты и контрактов выполняет агент своими
 * файловыми средствами по каноническому скиллу module-boundaries.
 *
 * @module plugin-architecture-change-view/dsh/tools
 */

import { moduleContext, moduleInventory, SOURCE_EXTENSIONS } from "../contracts/inventory.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { within } from "../project/paths.js";

/** Описание параметра `projectRoot`, общего для обоих инструментов. */
const PROJECT_ROOT_PARAMETER = {
  type: "string" as const,
  description: "Абсолютная рабочая папка, которая может содержать несколько Git-репозиториев. По умолчанию берётся настроенный root или папка чата.",
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
    description: "List repositories, source directories and mapped contracts in the workspace, including " +
      "missing or invalid entries in .archiview/modules.tree and contract files. " +
      "Presence is not a semantic compliance verdict. Use the module-boundaries skill.",
    parameters: Object.freeze({ projectRoot: PROJECT_ROOT_PARAMETER }),
  }),
  Object.freeze({
    name: "archiview_context",
    description: "Find the repository owning a source file or directory and read its contract chain, root first. " +
      "Use before editing source code. Reports missing documents explicitly.",
    parameters: Object.freeze({
      projectRoot: PROJECT_ROOT_PARAMETER,
      path: Object.freeze({
        type: "string" as const,
        description: "Путь к файлу или каталогу относительно рабочей папки, например backend/src/main.ts.",
      }),
      directory: Object.freeze({
        type: "string" as const,
        description: "Альтернативное имя аргумента path для прежних вызовов.",
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
 * Настройка хоста ограничивает область каждого модельного вызова.
 * Без настройки адаптер передаёт явно выбранный проект или рабочую папку чата.
 *
 * @param {object} options - параметры выбора.
 * @param {unknown} options.projectRoot - значение аргумента инструмента.
 * @param {string} [options.configuredRoot] - корень из конфигурации плагина.
 * @returns {Promise<string>} путь к разрешённому проекту.
 * @throws {Error} если корень не задан ни одним способом.
 */
export async function resolveRoot({ projectRoot, configuredRoot }: { projectRoot?: unknown; configuredRoot?: string }) {
  const selected = typeof projectRoot === "string" ? projectRoot.trim() : "";
  if (configuredRoot) {
    const boundary = await realpath(configuredRoot);
    const candidate = path.resolve(configuredRoot, selected);
    if (within(configuredRoot, candidate) || within(boundary, candidate)) {
      const physical = await realpath(candidate);
      if (within(boundary, physical)) return physical;
    }
    throw new Error("projectRoot находится вне настроенного корня ArchiView");
  }
  if (selected) return realpath(selected);
  throw new Error("Передайте projectRoot или задайте root в конфигурации плагина ArchiView");
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
 * Читает контракты предков файла или каталога в его репозитории.
 *
 * @param {object} options - параметры чтения.
 * @param {string} options.root - рабочая папка.
 * @param {string} [options.path] - файл или каталог относительно рабочей папки.
 * @param {string} [options.directory] - прежнее имя аргумента для каталога.
 * @returns {Promise<object>} результат `moduleContext` без изменений формы.
 */
export async function readContext({ root, path: sourcePath, directory }: { root: string; path?: unknown; directory?: unknown }) {
  if (sourcePath !== undefined && directory !== undefined) throw new Error("Передайте только один путь: path или directory");
  const target = sourcePath ?? directory ?? ".";
  if (typeof target !== "string") throw new Error("Путь к исходникам должен быть строкой");
  return moduleContext(root, target);
}
