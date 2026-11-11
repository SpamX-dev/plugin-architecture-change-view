/**
 * Разрешение корня проекта по чату вкладки.
 *
 * Вкладка правой панели принадлежит конкретному чату dsh, а прикладной сервис
 * ArchiView работает с одним корнем проекта. Мост между ними — рабочий каталог
 * сессии: он неизменен в заголовке сессии, поэтому панель, инструменты модели
 * и экспорт анализа видят один и тот же проект.
 *
 * Источников два, в порядке точности:
 *
 * 1. живая сессия в `ctx.sessions` — быстрый путь для открытого чата;
 * 2. сохранённый заголовок через `sessionController.inspect` — путь для
 *    восстановленной вкладки, когда агент ещё не присоединился.
 *
 * Модуль не знает ни HTTP, ни cordis: оба сервиса передаются как зависимости,
 * поэтому правило проверяется обычным `node --test`.
 *
 * @module plugin-architecture-change-view/dsh/chat-root
 */

/**
 * Проверяет, что значение пригодно как рабочий каталог.
 *
 * @param {unknown} value - проверяемое значение.
 * @returns {string | null} непустой путь либо `null`.
 */
function asDirectory(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Возвращает рабочий каталог чата.
 *
 * @param {object} options - параметры разрешения.
 * @param {unknown} options.sessionId - идентификатор чата из вкладки.
 * @param {{ get?: (id: string) => { header?: { cwd?: string } } | undefined } | undefined} [options.sessions]
 *   живое хранилище сессий dsh.
 * @param {{ inspect?: (id: string, signal?: AbortSignal) => Promise<{ meta?: { cwd?: string } }> } | undefined} [options.sessionController]
 *   контроллер сессий для чтения сохранённого заголовка.
 * @param {AbortSignal} [options.signal] - отмена чтения сохранённого заголовка.
 * @returns {Promise<string | null>} рабочий каталог или `null`, если чат не найден.
 * @throws {Error} если чтение сохранённого заголовка завершилось ошибкой хранилища.
 */
export async function resolveChatRoot({ sessionId, sessions, sessionController, signal }: ChatRootOptions) {
  if (typeof sessionId !== "string" || sessionId === "") return null;

  const live = sessions?.get?.(sessionId);
  const liveCwd = asDirectory(live?.header?.cwd);
  if (liveCwd !== null) return liveCwd;

  if (typeof sessionController?.inspect !== "function") return null;
  const inspection = await sessionController.inspect(sessionId, signal);
  return asDirectory(inspection?.meta?.cwd);
}

export interface ChatRootOptions {
 sessionId: unknown;
 sessions?: { get?(id: string): { header?: { cwd?: string } } | undefined };
 sessionController?: { inspect?(id: string, signal?: AbortSignal): Promise<{ meta?: { cwd?: string } }> };
 signal?: AbortSignal;
}
