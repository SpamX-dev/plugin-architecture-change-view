/** Нативный выбор папки Windows вызывается только явной кнопкой панели, без модели и HTTP. */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ApplicationError } from "../application/errors.mjs";

/** Скрипт постоянный: пользовательский путь не подставляется в исполняемый код. */
const PICK_DIRECTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Выберите папку проекта ArchiView'
$dialog.ShowNewFolderButton = $false
try {
  $selected = $null
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $selected = $dialog.SelectedPath }
  @{ projectRoot = $selected } | ConvertTo-Json -Compress
} finally { $dialog.Dispose() }
`;

/**
 * Скрывает консоль вспомогательного процесса, оставляя видимым только диалог.
 * Отмена возвращает null и не меняет проект. Ограничение времени закрывает
 * забытый диалог до стандартного таймаута MCP-вызова; ручной ввод остаётся доступен.
 */
export async function chooseProjectDirectory({ platform = process.platform, run = promisify(execFile) } = {}) {
  if (platform !== "win32") throw new ApplicationError("DIRECTORY_PICKER_UNAVAILABLE", "Укажите путь к папке вручную: диалог выбора доступен в Windows.");
  try {
    const { stdout } = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      Buffer.from(PICK_DIRECTORY_SCRIPT, "utf16le").toString("base64")], { windowsHide: true, timeout: 45000, maxBuffer: 65536, encoding: "utf8" });
    const result = JSON.parse(stdout.trim());
    if (result.projectRoot !== null && (typeof result.projectRoot !== "string" || !path.win32.isAbsolute(result.projectRoot))) throw new Error("Invalid directory selection");
    return { projectRoot: result.projectRoot };
  } catch {
    throw new ApplicationError("DIRECTORY_PICKER_UNAVAILABLE", "Не удалось выбрать папку. Повторите попытку или введите путь вручную.");
  }
}
