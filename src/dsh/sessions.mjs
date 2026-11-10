/**
 * Реестр прикладных сессий ArchiView для плагина dsh.
 *
 * Один процесс dsh обслуживает несколько чатов и проектов, а прикладной сервис
 * (`src/application/session.mjs`) рассчитан на один корень проекта. Реестр
 * сопоставляет корень и лениво созданную сессию и повторяет одну и ту же
 * сессию всем запросам этого корня: панель, инструменты модели и экспорт
 * анализа видят одно состояние сравнения.
 *
 * Ответственность модуля ограничена жизненным циклом: он не читает проект,
 * не кэширует документы и не решает, какой корень считать текущим.
 *
 * @module plugin-architecture-change-view/dsh/sessions
 */

import { createArchiViewSession } from "../application/session.mjs";

/**
 * Создаёт реестр сессий, разделённый по корню проекта.
 *
 * Инициализация сессии ленивая: первый запрос к корню создаёт её, остальные
 * ожидают то же обещание. Неудачная инициализация удаляется из реестра, чтобы
 * следующий запрос мог повторить попытку, а не унаследовать отклонённое
 * обещание навсегда.
 *
 * @param {object} [options] - параметры реестра.
 * @param {(options: { root: string, stateDirectory?: string }) => object | Promise<object>} [options.createSession]
 *   фабрика прикладной сессии; по умолчанию используется штатная.
 * @param {string} [options.stateDirectory] - явный каталог состояния вместо `.archiview`.
 * @returns {{
 *   get: (root: string) => Promise<object>,
 *   has: (root: string) => boolean,
 *   size: () => number,
 *   dispose: () => Promise<void>
 * }} реестр с ленивыми сессиями.
 */
export function createSessionRegistry({ createSession = createArchiViewSession, stateDirectory } = {}) {
  /** @type {Map<string, Promise<object>>} */
  const entries = new Map();
  let closed = false;

  /**
   * Возвращает сессию корня, создавая её при первом обращении.
   *
   * @param {string} root - абсолютный корень проекта.
   * @returns {Promise<object>} прикладная сессия ArchiView.
   * @throws {Error} если реестр закрыт или корень не задан.
   */
  function get(root) {
    if (closed) throw new Error("Реестр сессий ArchiView закрыт");
    if (typeof root !== "string" || root.trim() === "") {
      throw new Error("Не задан корень проекта ArchiView");
    }
    let entry = entries.get(root);
    if (entry === undefined) {
      // Обещание нормализует и синхронный throw фабрики, и отказ асинхронной.
      entry = Promise.resolve().then(() => createSession({ root, stateDirectory }));
      entries.set(root, entry);
      entry.catch(() => {
        if (entries.get(root) === entry) entries.delete(root);
      });
    }
    return entry;
  }

  /**
   * Проверяет, создавалась ли сессия корня.
   *
   * @param {string} root - абсолютный корень проекта.
   * @returns {boolean} признак существующей записи.
   */
  function has(root) {
    return entries.has(root);
  }

  /**
   * Возвращает число известных корней.
   *
   * @returns {number} размер реестра.
   */
  function size() {
    return entries.size;
  }

  /**
   * Закрывает реестр и дожидается уже начатых инициализаций.
   *
   * Новые запросы после закрытия отклоняются, уже выданные сессии остаются
   * рабочими до выгрузки процесса: прикладной сервис не держит сокетов и
   * фоновых задач, поэтому отдельного закрытия ему не требуется.
   *
   * @returns {Promise<void>} завершение после расчёта всех обещаний.
   */
  async function dispose() {
    closed = true;
    const pending = [...entries.values()];
    entries.clear();
    await Promise.allSettled(pending);
  }

  return { get, has, size, dispose };
}
