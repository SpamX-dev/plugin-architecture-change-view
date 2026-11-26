import { isSource } from "../git-changes/module-layout.js";
import { excludedProjectPath } from "../../framework/project/paths.js";
import type { SnapshotModule } from "../../framework/snapshots/types.js";

export const instructions = "Проверь соответствие собственного исходного кода модуля его назначению, границам и инвариантам. Укажи фактические обязанности и подтверди выводы сохранёнными фактами исходных файлов. Для отсутствующей реализации оцени, что требует контракт. Композиция детей и контракты предков в эту проверку не входят.";

export function sourceFiles(module: SnapshotModule) {
  return module.files.filter(file => isSource(file.path) || file.path.split("/").at(-1) === "SKILL.md" && !excludedProjectPath(file.path));
}
