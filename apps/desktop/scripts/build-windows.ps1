<#
.SYNOPSIS
一键构建 Windows x64 无签名桌面安装包，完成内置检查后输出安装包位置。
.PARAMETER BuildVersion
可选的完整 SemVer 构建版本；省略时由项目版本和 UTC 时间生成。
.PARAMETER CheckOnly
只执行打包预检，不构建安装包。
.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\apps\desktop\scripts\build-windows.ps1
#>
[CmdletBinding()]
param(
    [string]$BuildVersion = '',
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# 原生命令由退出码统一判定，兼容 Windows PowerShell 5.1 和 PowerShell 7。
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Invoke-DesktopPnpm {
    param([string[]]$Arguments)
    & $script:desktopPnpm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm 执行失败，退出码 $LASTEXITCODE。请保留终端输出和 packaging-runs 日志。"
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw '本脚本需要 Windows x64 构建主机。' }
    $desktopRepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).ProviderPath
    $script:desktopPnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
    $desktopNode = (Get-Command node.exe -ErrorAction Stop).Source
    $desktopArch = & $desktopNode -p 'process.arch'
    if ($LASTEXITCODE -ne 0 -or $desktopArch -ne 'x64') { throw '请使用 x64 Node.js。' }
    Push-Location -LiteralPath $desktopRepoRoot
    try {
        $desktopManifest = Get-Content -LiteralPath 'apps/desktop/package.json' -Encoding UTF8 -Raw | ConvertFrom-Json
        $desktopBuildVersion = $BuildVersion
        if ([string]::IsNullOrWhiteSpace($desktopBuildVersion)) {
            $desktopStamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmss')
            $desktopBaseVersion = [string]$desktopManifest.version
            if ($desktopBaseVersion.Contains('-')) { $desktopBuildVersion = "$desktopBaseVersion.$desktopStamp" }
            else { $desktopBuildVersion = "$desktopBaseVersion-test.$desktopStamp" }
        }
        if (-not (Test-Path -LiteralPath 'apps/desktop/.env.windows')) {
            Copy-Item -LiteralPath 'apps/desktop/.env.github.windows.example' -Destination 'apps/desktop/.env.windows'
            Write-Host '已创建 apps/desktop/.env.windows；仓库和更新地址由该文件配置。'
        }
        if (-not (Test-Path -LiteralPath 'node_modules/.modules.yaml')) {
            Invoke-DesktopPnpm -Arguments @('install', '--frozen-lockfile')
        }
        Write-Host "Windows x64 无签名构建版本：$desktopBuildVersion"
        Invoke-DesktopPnpm -Arguments @('--dir', 'apps/desktop', 'run', 'check:package', '--unsigned', '--build-version', $desktopBuildVersion)
        if ($CheckOnly) { Write-Host '预检成功，未执行构建。'; return }
        Invoke-DesktopPnpm -Arguments @('--dir', 'apps/desktop', 'run', 'package:win:x64:unsigned', '--build-version', $desktopBuildVersion)
        $desktopOutput = Join-Path $desktopRepoRoot 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts'
        $desktopInstaller = Join-Path $desktopOutput "deepseek-harness-$desktopBuildVersion-win-x64-unsigned.exe"
        $desktopInstallerInfo = Get-Item -LiteralPath $desktopInstaller -ErrorAction Stop
        if ($desktopInstallerInfo.Length -le 0) { throw '安装包为空，不能报告构建成功。' }
        $desktopDigest = (Get-FileHash -LiteralPath $desktopInstaller -Algorithm SHA256).Hash
        Write-Host ''
        Write-Host '构建与打包后运行时检查成功。此脚本不会自动发布到 GitHub。'
        Write-Host "安装包大小：$($desktopInstallerInfo.Length) 字节"
        Write-Host "SHA-256：$desktopDigest"
        Write-Host '安装包位置：'
        Write-Output $desktopInstallerInfo.FullName
    }
    finally { Pop-Location }
}
catch {
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
    exit 1
}
