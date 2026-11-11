/**
 * Установка распакованной локальной поставки: регистрирует её marketplace,
 * затем вызывает общий установщик. Пути берутся из положения пакета на целевой
 * машине; сетевой marketplace, npm и исходный репозиторий не используются.
 */
import { fileURLToPath } from "node:url";
import { installCodexPlugin, runCodex } from "./install-plugin.js";

const root = fileURLToPath(new URL("../", import.meta.url));
await runCodex(["plugin", "marketplace", "add", root], { cwd: root });
const installed = await installCodexPlugin({ cwd: root });
process.stdout.write(JSON.stringify(installed, null, 2) + "\nПерезапустите Codex и откройте ArchiView в чате проекта.\n");
