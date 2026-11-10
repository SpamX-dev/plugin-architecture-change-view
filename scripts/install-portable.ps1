# Точка входа распакованного Windows-пакета; сборщик помещает её в корень архива.
# Встроенный Node запускает общий установщик, даже если Node и npm отсутствуют в PATH.
$ErrorActionPreference = 'Stop'
$taskNodePath = Join-Path $PSScriptRoot 'plugin\runtime\node.exe'
$taskInstallerPath = Join-Path $PSScriptRoot 'scripts\install-portable.mjs'
& $taskNodePath $taskInstallerPath
exit $LASTEXITCODE
