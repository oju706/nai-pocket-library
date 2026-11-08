param(
    [string]$ToolCache = (Join-Path (Split-Path -Parent $PSScriptRoot) '.android-tools'),
    [ValidateLength(0, 4000)] [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$apk = Get-Item -LiteralPath (Join-Path $project 'release\NAI-Pocket-Library.apk')
$aapt = Join-Path $ToolCache 'build-tools\android-15\aapt2.exe'
$badging = & $aapt 'dump' 'badging' $apk.FullName
if ($LASTEXITCODE -ne 0) { throw '无法读取安装包版本。' }
$package = $badging | Where-Object { $_ -like 'package:*' } | Select-Object -First 1
if ($package -notmatch "^package: name='app\.nai\.pocketlibrary' versionCode='(?<code>[1-9][0-9]{0,9})' versionName='(?<version>[vV]?[0-9]{1,9}(?:\.[0-9]{1,9}){0,3})'") {
    throw '安装包名称或版本信息无效。'
}
$versionCode = [long]$Matches['code']
$versionName = $Matches['version']
if ($versionCode -gt [int]::MaxValue -or $apk.Length -lt 1 -or $apk.Length -gt 128MB) {
    throw '版本序号或安装包大小超出更新清单支持的范围。'
}
$manifest = [ordered]@{
    versionCode = $versionCode
    versionName = $versionName
    file = $apk.Name
    bytes = $apk.Length
    sha256 = (Get-FileHash -LiteralPath $apk.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    notes = $Notes
}
$destination = Join-Path $apk.DirectoryName 'update.json'
$temporary = Join-Path $apk.DirectoryName ('update-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    [IO.File]::WriteAllText($temporary, (($manifest | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $destination -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Get-Item -LiteralPath $destination
