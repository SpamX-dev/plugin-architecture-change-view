/**
 * Передача поручения анализа в чат dsh.
 *
 * Панель не может звать инструменты модели напрямую: она работает в iframe и
 * общается с хостом только явными сообщениями. Хост-половина плагина такой
 * запрос не принимает — поручение отправляет браузерная половина в тот чат,
 * которому принадлежит вкладка, через клиентский сервис сессий.
 *
 * Модуль держит одну операцию: взять сессию на время отправки, передать текст
 * в очередь хода и отпустить ссылку. Навигация панели сюда не попадает, поэтому
 * просмотр по-прежнему не создаёт сообщений модели.
 *
 * @module plugin-architecture-change-view/dsh/client/prompt
 */

/**
 * Создаёт отправителя поручений для одного экземпляра плагина.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст клиента dsh.
 * @returns {(sessionId: string, text: string) => Promise<void>} отправка поручения в чат.
 */
export function createPromptSender(ctx) {
  /**
   * Отправляет текст в очередь хода указанного чата.
   *
   * @param {string} sessionId - идентификатор чата вкладки.
   * @param {string} text - подготовленное панелью поручение.
   * @returns {Promise<void>} завершение после принятия хостом.
   * @throws {Error} если чат неизвестен, поручение пустое или хост его отклонил.
   */
  return async function sendPrompt(sessionId, text) {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("Чат вкладки неизвестен");
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("Пустое поручение анализа");
    }
    const sessions = ctx.get("sessions");
    if (sessions === undefined) throw new Error("Клиентские сессии dsh недоступны");

    // Ссылка держит поколение сессии на время отправки и освобождается в любом
    // исходе: удерживать её после ответа хоста нечего.
    const reference = sessions.retain(sessionId, { source: "archiview" });
    try {
      const binding = await reference.ready;
      const result = await binding.session.prompt([{ type: "text", text }], "queue");
      if (result?.ok !== true) {
        throw new Error(result?.error?.message ?? "Хост отклонил поручение");
      }
    } finally {
      reference.release();
    }
  };
}
