param(
    [Parameter(Mandatory)]
    [ValidatePattern('\A(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}\z')]
    [string]$Version,
    [string]$ZipPath = (Join-Path $PSScriptRoot '../release/NAI-Pocket-Library-Windows-x64.zip'),
    [string]$OutputPath = (Join-Path $PSScriptRoot '../release/desktop-update.json'),
    [ValidateLength(0, 4000)]
    [string]$Notes = ''
)

$ErrorActionPreference = 'Stop'
$package = Get-Item -LiteralPath $ZipPath
if ($package -isnot [IO.FileInfo]) {
    throw '请选择 Windows 便携版 ZIP 文件。'
}
$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if ([StringComparer]::OrdinalIgnoreCase.Equals($package.FullName, $destination) -or
    (Test-Path -LiteralPath $destination -PathType Container)) {
    throw '请选择与 ZIP 分开的清单文件路径。'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$prefix = 'NAI-Pocket-Library/'
$required = @(
    "${prefix}NAI-Pocket-Library.exe"
    "${prefix}web/index.html"
)
$stream = [IO.File]::OpenRead($package.FullName)
try {
    if ($stream.Length -lt 1 -or $stream.Length -gt 128MB) {
        throw 'Windows ZIP 大小超出更新清单支持的范围。'
    }
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $archive.Entries) {
            $path = $entry.FullName
            $components = $path.TrimEnd('/').Split('/')
            if (-not $path.StartsWith($prefix, [StringComparison]::Ordinal) -or
                $path.Contains('\') -or $path.Contains(':') -or
                $components -contains '' -or $components -contains '..' -or $components -contains '.' -or
                -not $paths.Add($path.TrimEnd('/'))) {
                throw "Windows ZIP 有无效或重复的路径：$path"
            }
        }
        foreach ($name in $required) {
            $entry = $archive.GetEntry($name)
            if ($null -eq $entry -or $entry.Length -le 0) {
                throw "Windows ZIP 缺少所需文件：$name"
            }
            $unixType = ($entry.ExternalAttributes -shr 16) -band 0xf000
            $windowsFlags = $entry.ExternalAttributes -band 0x410
            if ($windowsFlags -ne 0 -or ($unixType -ne 0 -and $unixType -ne 0x8000)) {
                throw "Windows ZIP 条目必须是普通文件：$name"
            }
        }
    } finally {
        $archive.Dispose()
    }
    $stream.Position = 0
    $manifest = [ordered]@{
        app = 'nai-pocket-library.desktop'
        version = $Version
        file = 'NAI-Pocket-Library-Windows-x64.zip'
        bytes = $stream.Length
        sha256 = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant()
        notes = $Notes
    }
} finally {
    $stream.Dispose()
}

$parent = [IO.Path]::GetDirectoryName($destination)
$temporary = Join-Path $parent ('desktop-update-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $json = ($manifest | ConvertTo-Json).Replace("`r`n", "`n") + "`n"
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $destination -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}
Get-Item -LiteralPath $destination
