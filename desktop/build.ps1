param(
    [string]$Go = 'go',
    [string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release/windows')
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$destinationPath = [IO.Path]::GetFullPath($Destination)
$buildPath = Join-Path $destinationPath ('build-' + [Guid]::NewGuid().ToString('N'))
$contents = Join-Path $buildPath 'NAI-Pocket-Library'
$web = Join-Path $contents 'web'
$exeName = 'NAI-Pocket-Library.exe'
$zipName = 'NAI-Pocket-Library-Windows-x64.zip'
New-Item -ItemType Directory -Path $web -Force | Out-Null

$previousGoos = $env:GOOS
$previousGoarch = $env:GOARCH
$previousCgo = $env:CGO_ENABLED
Push-Location $PSScriptRoot
try {
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    & $Go build -buildvcs=false -trimpath -ldflags '-s -w' -o (Join-Path $contents $exeName) .
    if ($LASTEXITCODE) { throw 'Windows 程序编译失败。' }
} finally {
    $env:GOOS = $previousGoos
    $env:GOARCH = $previousGoarch
    $env:CGO_ENABLED = $previousCgo
    Pop-Location
}

$assets = @('index.html', 'sources.js', 'core-state.js', 'chain-workbench.js', 'image-parser.js', 'app.js',
    'gallery.js', 'tag-gallery.js', 'online-pack.js', 'style.css', 'gallery.css', 'tag-gallery.css', 'online-pack.css',
    'korean-index.json', 'korean-33000-index.json', 'korean-55000-index.json', 'community-style-models.json')
foreach ($file in $assets) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $project 'web') $file) -Destination $web
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $contents
$zipPath = Join-Path $buildPath $zipName
Compress-Archive -LiteralPath $contents -DestinationPath $zipPath -CompressionLevel Optimal
$output = Join-Path $destinationPath $zipName
Move-Item -LiteralPath $zipPath -Destination $output -Force
Get-Item -LiteralPath $output
