param(
    [string]$ToolCache = (Join-Path $PSScriptRoot '.android-tools'),
    [string]$SigningDirectory = (Join-Path $ToolCache 'signing')
)

$ErrorActionPreference = 'Stop'
$project = $PSScriptRoot
$jdk = Get-ChildItem -LiteralPath (Join-Path $ToolCache 'jdk') -Directory | Select-Object -First 1
$platform = Join-Path $ToolCache 'platform\android-35\android.jar'
$buildTools = Join-Path $ToolCache 'build-tools\android-15'
$java = Join-Path $jdk.FullName 'bin\java.exe'
$javac = Join-Path $jdk.FullName 'bin\javac.exe'
$keytool = Join-Path $jdk.FullName 'bin\keytool.exe'
$aapt = Join-Path $buildTools 'aapt2.exe'
$align = Join-Path $buildTools 'zipalign.exe'
$signer = Join-Path $buildTools 'lib\apksigner.jar'
$d8 = Join-Path $buildTools 'lib\d8.jar'

function Invoke-Step {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "构建步骤失败 $Executable" }
}

$scratch = Join-Path $ToolCache ("builds\" + [Guid]::NewGuid().ToString('N'))
$classes = Join-Path $scratch 'classes'
$dex = Join-Path $scratch 'dex'
$null = New-Item -ItemType Directory -Path $classes,$dex,$SigningDirectory -Force
$resources = Join-Path $scratch 'resources.zip'
$unsigned = Join-Path $scratch 'unsigned.apk'
$aligned = Join-Path $scratch 'aligned.apk'
$signed = Join-Path $scratch 'signed.apk'
$manifest = Join-Path $project 'android\AndroidManifest.xml'
$assets = Join-Path $project 'web'

Invoke-Step $aapt @('compile','--dir',(Join-Path $project 'android\res'),'-o',$resources)
Invoke-Step $aapt @('link','-o',$unsigned,'--manifest',$manifest,'-I',$platform,'-A',$assets,$resources)
$source = @(Get-ChildItem -LiteralPath (Join-Path $project 'android\src') -Recurse -Filter '*.java' -File | Select-Object -ExpandProperty FullName)
Invoke-Step $javac (@('--release','8','-encoding','UTF-8','-classpath',$platform,'-d',$classes) + $source)
$bytecode = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' -File | Select-Object -ExpandProperty FullName)
Invoke-Step $java (@('-cp',$d8,'com.android.tools.r8.D8','--lib',$platform,'--min-api','28','--output',$dex) + $bytecode)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$apk = [System.IO.Compression.ZipFile]::Open($unsigned,[System.IO.Compression.ZipArchiveMode]::Update)
try {
    $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($apk,(Join-Path $dex 'classes.dex'),'classes.dex')
} finally { $apk.Dispose() }

$key = Join-Path $SigningDirectory 'nai-pocket-release.p12'
$passwordFile = Join-Path $SigningDirectory 'nai-pocket-release.pass'
if (-not (Test-Path -LiteralPath $passwordFile)) {
    if (Test-Path -LiteralPath $key) { throw '找不到已有发行密钥的密码文件。' }
    ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')) | Set-Content -LiteralPath $passwordFile -NoNewline
}
$env:NAI_POCKET_SIGNING_PASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()
try {
    if (-not (Test-Path -LiteralPath $key)) {
        Invoke-Step $keytool @('-genkeypair','-alias','nai-pocket-release','-keystore',$key,'-storetype','PKCS12',
            '-storepass:env','NAI_POCKET_SIGNING_PASSWORD','-keyalg','RSA','-keysize','3072','-validity','10000',
            '-dname','CN=NAI Pocket Library Release, O=Local Release','-noprompt')
    }
    Invoke-Step $align @('-f','-p','4',$unsigned,$aligned)
    Invoke-Step $java @('-jar',$signer,'sign','--ks',$key,'--ks-key-alias','nai-pocket-release',
        '--ks-pass','env:NAI_POCKET_SIGNING_PASSWORD','--v2-signing-enabled','true',
        '--v4-signing-enabled','false','--out',$signed,$aligned)
    Invoke-Step $java @('-jar',$signer,'verify','--verbose','--print-certs',$signed)
} finally { Remove-Item Env:NAI_POCKET_SIGNING_PASSWORD -ErrorAction SilentlyContinue }

$output = Join-Path $project 'release'
$null = New-Item -ItemType Directory -Path $output -Force
$destination = Join-Path $output 'NAI-Pocket-Library.apk'
Copy-Item -LiteralPath $signed -Destination $destination -Force
Invoke-Step $align @('-c','-p','4',$destination)
Invoke-Step $aapt @('dump','badging',$destination)
Get-Item -LiteralPath $destination | Select-Object FullName,Length
