import path from "node:path";
import { fileURLToPath } from "node:url";
import { containingWorktree } from "../analyse/project/workspace.js";
import { digest } from "../framework/serialization/digest.js";
import { within } from "../storage/paths.js";
import { readReviewConfiguration } from "../web/web-backend/project-review-settings.js";
import { createArchiViewSession } from "../web/web-backend/session.js";
import { findingFixAssignmentPrefix, reviewAssignmentPrefix } from "../web/web-backend/analysis-service/analysis.js";
import { cliArguments, packageUrl } from "../web/web-backend/runtime/package-paths.js";

interface HookEvent {
  hook_event_name: string;
  cwd: string;
  session_id: string;
  turn_id: string;
  prompt?: string;
  stop_hook_active?: boolean;
}

/** Both Codex and the DSH hooks-codex adapter supply this turn-scoped protocol. */
export async function turnHook(kind: string, event: HookEvent, requestedRoot?: string, stateDirectory?: string) {
  if (kind !== "codex" && kind !== "dsh") throw new Error("--turn-hook принимает codex или dsh");
  if (!["UserPromptSubmit", "Stop"].includes(event.hook_event_name)) return {};
  if (!path.isAbsolute(event.cwd) || !event.session_id || !event.turn_id) throw new Error("В событии нет каталога, session_id или turn_id");
  const cwd = path.resolve(event.cwd);
  const root = await containingWorktree(requestedRoot ? path.resolve(requestedRoot) : cwd);
  if (!root || !(within(root, cwd) || within(cwd, root))) return {};
  if ((await readReviewConfiguration(root)).enabled !== true) return {};
  const workspaceRoot = within(cwd, root) ? cwd : root;
  const app = await createArchiViewSession({root, workspaceRoot, stateDirectory});
  try {
    const reviewAssignment = event.hook_event_name === "UserPromptSubmit" &&
      [reviewAssignmentPrefix, findingFixAssignmentPrefix].some(prefix => event.prompt?.startsWith(prefix));
    if (await app.turns.isReviewSession(digest([kind, event.session_id]).slice(7), reviewAssignment)) return {};
    const command = [process.execPath, ...cliArguments(), "--root", workspaceRoot,
      "--repository", path.relative(workspaceRoot, root).split(path.sep).join("/") || ".",
      ...(stateDirectory ? ["--state-dir", app.store.directory] : []), "--review-current"];
    const skill = fileURLToPath(new URL("skills/module-boundaries/SKILL.md", packageUrl));
    const instruction = "Прочитай раздел «Перед завершением изменения» в " + JSON.stringify(skill) +
      ". После правок и тестов получи список проверок командой с аргументами " + JSON.stringify(command) +
      ". Проверь связи проекта, выполни анализ и исправления подагентами в этом чате и перепроверь результат. Соблюдай ограничения текущего запроса на правки.";
    if (event.hook_event_name === "UserPromptSubmit") {
      return {hookSpecificOutput:{hookEventName:event.hook_event_name,
        additionalContext:"ArchiView. Перед финальным ответом следуй скиллу module-boundaries. " + instruction}};
    }

    const {checks, relations} = await app.turns.current();
    const remaining = checks.some(check => check.status === "pending" || check.status === "reviewed");
    let relationProblem: string | undefined;
    if (relations.status === "unindexed") relationProblem = "Требуется построить актуальный граф связей.";
    if (relations.status === "pending") relationProblem = "Требуется разобрать актуальный граф связей.";
    if (relations.status === "reviewed" && relations.report.findings.length) relationProblem = "Остались открытые замечания по связям.";
    if ((remaining || relationProblem) && !event.stop_hook_active) {
      return {decision:"block", reason:"ArchiView обнаружил незавершённые проверки. " +
        (relationProblem ? relationProblem + " " : "") + instruction};
    }
    if (!checks.length && !relationProblem) return {};

    const statuses = {pending:"требуется анализ", reviewed:"остались открытые замечания", unavailable:"проверка недоступна"};
    const warnings = checks.map(check => check.moduleId + "/" + check.type + " — " + (check.message ?? statuses[check.status]));
    if (relationProblem) warnings.push(relationProblem);
    return {systemMessage:"ArchiView. Остались проверки:\n" + warnings.join("\n")};
  } finally { app.close(); }
}
