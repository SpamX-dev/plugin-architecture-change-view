/**
 * Публикация канонического скилла module-boundaries в реестре dsh.
 *
 * Скилл остаётся единственным файлом `skills/module-boundaries/SKILL.md`:
 * адаптер Codex экспортирует его как MCP-ресурс, а плагин dsh регистрирует тот
 * же текст как runtime-скилл через `ctx.skills.register`. Копий в
 * пользовательских каталогах не создаётся, поэтому правка файла меняет оба
 * хоста одновременно.
 *
 * Модуль зависит только от файловой системы и YAML: разбор frontmatter
 * повторяет правило MCP-сервера, но не требует SDK.
 *
 * @module plugin-architecture-change-view/dsh/skill
 */

import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { packageUrl } from "../package-paths.mjs";

/** Адрес файла скилла внутри пакета. */
export const SKILL_PATH = new URL("skills/module-boundaries/SKILL.md", packageUrl);

/**
 * Разбирает текст скилла с YAML-frontmatter.
 *
 * Обязательны `name` в kebab-case и непустое `description`: реестр dsh
 * отклоняет runtime-скилл без них. Тело возвращается без frontmatter, потому
 * что реестр вставляет его внутрь блока `<skill_instructions>`.
 *
 * @param {string} text - полный текст файла.
 * @returns {{ name: string, description: string, content: string }} разобранный скилл.
 * @throws {Error} если frontmatter отсутствует или не содержит обязательных полей.
 */
export function parseSkillText(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ""));
  if (!frontmatter) throw new Error("У скилла module-boundaries отсутствует frontmatter");
  const metadata = parse(frontmatter[1]);
  if (typeof metadata?.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name)) {
    throw new Error("У скилла module-boundaries некорректное имя");
  }
  if (typeof metadata.description !== "string" || metadata.description === "") {
    throw new Error("У скилла module-boundaries отсутствует описание");
  }
  return {
    name: metadata.name,
    description: metadata.description,
    content: text.slice(frontmatter[0].length).trimStart(),
  };
}

/**
 * Читает и разбирает встроенный скилл.
 *
 * @param {URL} [file] - адрес файла скилла; по умолчанию штатный в пакете.
 * @param {(file: URL, encoding: "utf8") => Promise<string>} [read] - чтение для тестов.
 * @returns {Promise<{ name: string, description: string, content: string }>} разобранный скилл.
 */
export async function loadSkill(file = SKILL_PATH, read = readFile) {
  return parseSkillText(await read(file, "utf8"));
}
