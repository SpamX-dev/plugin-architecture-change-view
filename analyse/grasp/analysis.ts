import path from "node:path";
import { graspParticipants, type ReviewReport } from "../../framework/ai-report/types.js";
import type { SnapshotModule } from "../../framework/snapshots/types.js";

export const instructions = "Проверь композицию по собственному контракту и контрактам непосредственных детей. Разбери детей по их роли относительно обещания родителя. Для непосредственных исполнителей проверь совместимость их контрактов между собой и способность вместе выполнить обещание родителя. Для утилит (Pure Fabrication) укажи потребителя и задачу, проверь достаточность и границы обязанностей. Для листа объясни неприменимость композиции. Выводы и замечания обоснуй сохранёнными контрактами. Заполни report.extensions[\"archiview.grasp\"] для каждого непосредственного ребёнка из экспорта: moduleId, role (executor или utility), task (задача), assessment (результат сравнения). Для утилиты добавь consumers со списком потребителей; если по контрактам потребитель не установлен, укажи это в assessment и оставь пустой список. Для листа используй пустой массив. Код, контракты предков и более глубоких потомков в эту проверку не входят.";

export function validateComposition(report: ReviewReport, children: string[]) {
  const participants = graspParticipants(report);
  const pending = new Set(children);
  const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  for (const item of participants) {
    if (!item || !pending.delete(item.moduleId) || !["executor", "utility"].includes(item.role) ||
        !text(item.task) || !text(item.assessment) ||
        (item.role === "utility" && !Array.isArray(item.consumers)) ||
        (item.consumers !== undefined && (!Array.isArray(item.consumers) || !item.consumers.every(text))))
      throw new Error("GRASP: некорректная оценка участника композиции.");
  }
  if (pending.size || !Array.isArray(report.extensions?.["archiview.grasp"]))
    throw new Error("GRASP: требуется оценка каждого непосредственного ребёнка: " + [...pending].join(", "));
}

/** The closest mapped ancestor owns each child in the composition. */
export function compositionChildren(modules: SnapshotModule[]) {
  const directories = new Set(modules.map(module => module.directory));
  const children = new Map<string, SnapshotModule[]>();
  for (const module of modules) {
    if (module.directory === ".") continue;
    let parent = path.posix.dirname(module.directory);
    while (parent !== "." && !directories.has(parent)) parent = path.posix.dirname(parent);
    if (!directories.has(parent)) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(module);
    else children.set(parent, [module]);
  }
  return children;
}
