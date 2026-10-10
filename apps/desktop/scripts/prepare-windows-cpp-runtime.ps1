<# Validate Microsoft x64 redistributables before copying them beside the Office native helper. #>
[CmdletBinding()]
param([string]$OutputDirectory, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$crtDirectory = $env:DSH_DESKTOP_WINDOWS_CRT_DIR
if (-not $crtDirectory) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'Windows C++ runtime: Visual Studio C++ Build Tools are missing.' }
    $redistRoot = Join-Path $installation 'VC/Redist/MSVC'
    $candidates = @(Get-ChildItem -LiteralPath $redistRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)
    foreach ($candidate in $candidates) {
        $architecture = Join-Path $candidate.FullName 'x64'
        if (-not (Test-Path -LiteralPath $architecture)) { continue }
        $complete = @(Get-ChildItem -LiteralPath $architecture -Directory -Filter 'Microsoft.VC*.CRT' | Where-Object {
            (Test-Path -LiteralPath (Join-Path $_.FullName 'msvcp140.dll')) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'vcruntime140.dll'))
        })
        if ($complete.Count -gt 0) { $crtDirectory = $complete[0].FullName; break }
    }
}
if (-not $crtDirectory -or -not (Test-Path -LiteralPath $crtDirectory -PathType Container)) {
    throw 'Windows C++ runtime: install the Visual Studio C++ x64 redistributable files or configure DSH_DESKTOP_WINDOWS_CRT_DIR.'
}
$crtDirectory = [IO.Path]::GetFullPath($crtDirectory)
foreach ($required in @('msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $crtDirectory $required) -PathType Leaf)) { throw "Windows C++ runtime: missing $required" }
}
$files = @(Get-ChildItem -LiteralPath $crtDirectory -File -Filter '*.dll' | Sort-Object Name)
$records = @()
foreach ($file in $files) {
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -lt 64 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw "Windows C++ runtime: invalid PE file $($file.Name)" }
    $pe = [BitConverter]::ToInt32($bytes, 0x3c)
    if ($pe -lt 64 -or $pe + 6 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes, $pe) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes, $pe + 4) -ne 0x8664) {
        throw "Windows C++ runtime: expected an x64 PE DLL for $($file.Name)"
    }
    $versionInfo = $file.VersionInfo
    $version = [version]::new($versionInfo.FileMajorPart, $versionInfo.FileMinorPart, $versionInfo.FileBuildPart, $versionInfo.FilePrivatePart)
    if ($file.Name -eq 'msvcp140.dll' -and $version -lt [version]'14.42.34438.0') { throw 'Windows C++ runtime: msvcp140.dll must be 14.42.34438.0 or newer.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
        throw "Windows C++ runtime: invalid Microsoft signature for $($file.Name)"
    }
    $records += [ordered]@{ name = $file.Name; version = $version.ToString(); sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
}
if (-not $CheckOnly) {
    if (-not $OutputDirectory) { throw 'Windows C++ runtime: OutputDirectory is required.' }
    # 验证全部文件后再复制；DLL 留在应用目录，由桌面更新维护，避免修改系统运行库。
    $output = [IO.Path]::GetFullPath($OutputDirectory)
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    foreach ($file in $files) { Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $output $file.Name) }
    $notice = "Microsoft Visual C++ Runtime (x64). Copyright Microsoft Corporation.`nRedistributed from Visual Studio C++ Build Tools; serviced by Desktop releases.`nhttps://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files`n"
    [IO.File]::WriteAllText((Join-Path $output 'MSVC-NOTICE.txt'), $notice, [Text.UTF8Encoding]::new($false))
    $metadata = [ordered]@{ schemaVersion = 1; architecture = 'x64'; files = $records }
    [IO.File]::WriteAllText((Join-Path $output 'msvc-runtime.json'), (($metadata | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
}
Write-Output "Windows C++ runtime: verified $($files.Count) Microsoft x64 DLLs ($($records[0].version))."
