import type { DocumentDiffLine, FileDiff } from "../../src/application/api.js";
import type { ComparisonView } from "./types.js";
import { errorMessage } from "./types.js";
import { el, icon } from "./dom.js";
import { timelineLabel } from "./timeline.js";

export function openDiffDialog(title: string) {
  const dialog = el("dialog", "contract-diff-dialog");
  dialog.setAttribute("aria-label", title);
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", title), close);
  dialog.append(heading);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function diffBox(panel: HTMLElement, file: string, view: ComparisonView, added: number, removed: number) {
  const heading = el("div", "diff-heading");
  heading.append(icon("file"), el("strong", "", file), el("span", "diff-added-count", "+" + added),
    el("span", "diff-removed-count", "−" + removed));
  const labels = el("div", "diff-labels");
  labels.append(el("span", "", "Было"), el("span", "", "Стало"),
    el("span", "", view.before.label + " → " + (view.published ? view.target.label : timelineLabel(view.target))));
  const rows = el("div", "diff-lines");
  const box = el("div", "diff-box");
  box.append(heading, labels, rows);
  panel.append(box);
  return rows;
}

export function diffLine({kind, beforeLine, afterLine, text}: DocumentDiffLine) {
  const line = el("div", "diff-line " + kind);
  line.append(el("span", "line-number", beforeLine ?? ""), el("span", "line-number", afterLine ?? ""),
    el("span", "line-sign", kind === "added" ? "+" : kind === "removed" ? "−" : " "),
    el("code", "line-content", text || " "));
  return line;
}

function* fileRows({ hunks, unchangedText }: FileDiff) {
  if (unchangedText !== undefined) {
    const lines = unchangedText.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (!lines.length) yield el("p", "diff-status", "Пустой файл.");
    for (const [index, text] of lines.entries()) {
      yield diffLine({ kind: "same", beforeLine: index + 1, afterLine: index + 1, text });
    }
    return;
  }
  for (const hunk of hunks) {
    let before = hunk.oldStart, after = hunk.newStart;
    yield el("div", "diff-hunk", "@@ -" + (hunk.oldLines ? before : before - 1) + "," + hunk.oldLines +
      " +" + (hunk.newLines ? after : after - 1) + "," + hunk.newLines + " @@");
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) { yield el("div", "diff-note", "Нет перевода строки в конце файла"); continue; }
      const kind = line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "same";
      yield diffLine({ kind, beforeLine: kind === "added" ? null : before++,
        afterLine: kind === "removed" ? null : after++, text: line.slice(1) });
    }
  }
}

export async function openFileDiff(file: string, view: ComparisonView, load: () => Promise<FileDiff>) {
  const dialog = openDiffDialog("Просмотр файла");
  dialog.classList.add("file-diff-dialog");
  const status = el("p", "diff-status", "Загрузка…");
  status.setAttribute("role", "status");
  dialog.append(status);
  let result: FileDiff;
  try { result = await load(); }
  catch (error) { status.textContent = file + " — " + errorMessage(error); return; }
  if (!dialog.open) return;
  let added = 0, removed = 0;
  for (const hunk of result.hunks) for (const line of hunk.lines) {
    if (line[0] === "+") added++;
    if (line[0] === "-") removed++;
  }
  const rows = diffBox(dialog, file, view, added, removed);
  if (result.message) rows.append(el("p", "diff-status", result.message));
  status.remove();
  const iterator = fileRows(result);
  let next = iterator.next();
  const more = el("button", "button button-quiet diff-more", "Показать ещё");
  function appendPage() {
    for (let i = 0; i < 500 && !next.done; i++, next = iterator.next()) rows.insertBefore(next.value, more);
    if (next.done) more.remove();
  }
  more.onclick = appendPage;
  rows.append(more);
  appendPage();
}
