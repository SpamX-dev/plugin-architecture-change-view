import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containingWorktree } from "../analyse/project/workspace.js";
import { digest } from "../framework/serialization/digest.js";
import { within } from "../storage/paths.js";
import { readReviewConfiguration } from "../web/web-backend/project-review-settings.js";
import { createArchiViewSession } from "../web/web-backend/session.js";
import { reviewAssignmentPrefix } from "../web/web-backend/analysis-service/analysis.js";
import { harnessInstanceId, type HarnessKind } from "../web/web-backend/host-bridge/channel.js";
import { cliArguments, packageUrl } from "../web/web-backend/runtime/package-paths.js";

interface HookEvent { hook_event_name: string; cwd: string; session_id: string; turn_id: string; prompt?: string }

async function configuration(root: string, host: HarnessKind) {
  const config = await readReviewConfiguration(root);
  if (config.enabled !== true) return;
  const instanceId = config[host];
  if (instanceId !== undefined && (typeof instanceId !== "string" || !new RegExp("^" + host + "-[a-f0-9]{24}$").test(instanceId)))
    throw new Error("Некорректный ID моста " + host + " в agent-review.json");
  const pipe = host === "codex" && process.env.CODEX_APP_TOOLS_PIPE_PATH;
  return {kind:host, instanceId:instanceId ?? (pipe ? harnessInstanceId(host, pipe) : undefined)};
}

/** Both Codex and the DSH hooks-codex adapter supply this turn-scoped protocol. */
export async function turnHook(kind: string, event: HookEvent, requestedRoot?: string, stateDirectory?: string) {
  if (kind !== "codex" && kind !== "dsh") throw new Error("--turn-hook принимает codex или dsh");
  if (!["UserPromptSubmit", "Stop"].includes(event.hook_event_name)) return {};
  if (!path.isAbsolute(event.cwd) || !event.session_id || !event.turn_id) throw new Error("В событии нет каталога, session_id или turn_id");
  const cwd = path.resolve(event.cwd);
  const root = await containingWorktree(requestedRoot ? path.resolve(requestedRoot) : cwd);
  if (!root || !(within(root, cwd) || within(cwd, root))) return {};
  const host = await configuration(root, kind);
  if (!host) return {};
  const id = digest(["turn", kind, event.session_id, event.turn_id]).slice(7);
  const workspaceRoot = within(cwd, root) ? cwd : root;
  const app = await createArchiViewSession({root, workspaceRoot, stateDirectory});
  try {
    const reviewAssignment = event.hook_event_name === "UserPromptSubmit" && event.prompt?.startsWith(reviewAssignmentPrefix) === true;
    if (await app.turns.isReviewSession(digest([kind, event.session_id]).slice(7), reviewAssignment)) return {};
    const argv = [...cliArguments(), "--root", workspaceRoot,
      "--repository", path.relative(workspaceRoot, root).split(path.sep).join("/") || ".",
      ...(stateDirectory ? ["--state-dir", app.store.directory] : [])];
    if (event.hook_event_name === "UserPromptSubmit") {
      await app.turns.begin(id, host);
      const command = [process.execPath, ...argv, "--review-turn", id, "--wait", "60"];
      const skill = fileURLToPath(new URL("skills/module-boundaries/SKILL.md", packageUrl));
      return {hookSpecificOutput:{hookEventName:event.hook_event_name,
        additionalContext:"ArchiView. Перед финальным ответом выполни команду с аргументами " + JSON.stringify(command) +
          ". Прочитай раздел «Перед завершением изменения» в " + JSON.stringify(skill) +
          ". Дождись отчётов, исправь подтверждённые расхождения в пределах задачи и перепроверь итоговый код."}};
    }
    const result = await app.turns.review(id, 0, async batch => {
      const worker = spawn(process.execPath, [...argv, "--dispatch-turn", batch], {detached:true, windowsHide:true, stdio:"ignore"});
      await once(worker, "spawn");
      worker.unref();
    });
    if (!result) return {systemMessage:"ArchiView: отсутствует начальный снимок хода. Проверьте обработчик UserPromptSubmit."};
    const problems = result.checks.filter(c => c.status === "unavailable" || c.status === "unconfirmed");
    return problems.length ? {systemMessage: "ArchiView: " + problems.map(c => c.moduleId + "/" + c.type + " — " + c.message).join("\n")} : {};
  } finally { app.close(); }
}
