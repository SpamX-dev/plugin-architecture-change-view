/**
 * TLS локальной панели. Читает явно настроенный PFX либо существующий доверенный
 * сертификат разработки localhost в Windows. Не создаёт сертификаты, не меняет
 * доверие системы и не сохраняет закрытый ключ в пакет или проект.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

/** Возвращает настройки HTTPS; отсутствие доверенного сертификата — явная ошибка запуска. */
export async function loadPanelTls() {
  if (process.env.ARCHIVIEW_TLS_PFX) return {
    pfx: await readFile(process.env.ARCHIVIEW_TLS_PFX),
    passphrase: process.env.ARCHIVIEW_TLS_PASSWORD ?? "",
  };
  if (process.platform !== "win32") throw new Error("Для HTTPS панели задайте ARCHIVIEW_TLS_PFX и ARCHIVIEW_TLS_PASSWORD.");
  const passphrase = randomBytes(32).toString("hex");
  const script = `
$ErrorActionPreference = 'Stop'
$now = Get-Date
$personal = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
$trusted = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
$personal.Open('ReadOnly')
$trusted.Open('ReadOnly')
$cert = $personal.Certificates | Where-Object {
  $_.HasPrivateKey -and $_.NotBefore -le $now -and $_.NotAfter -gt $now -and
  $_.Subject -eq 'CN=localhost' -and
  ($_.Extensions.Oid.Value -contains '1.3.6.1.4.1.311.84.1.1') -and
  ($trusted.Certificates.Thumbprint -contains $_.Thumbprint)
} | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) { throw 'Trusted localhost development certificate is unavailable' }
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $env:ARCHIVIEW_CERT_PASSWORD))
$personal.Close()
$trusted.Close()
`;
  try {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ARCHIVIEW_CERT_PASSWORD: passphrase },
    });
    return { pfx: Buffer.from(stdout.trim(), "base64"), passphrase };
  } catch {
    // Ошибки дочернего процесса не раскрывают PFX или пароль в MCP/журнале.
    throw new Error("Не найден доступный доверенный сертификат разработки localhost. Настройте ARCHIVIEW_TLS_PFX и ARCHIVIEW_TLS_PASSWORD.");
  }
}
