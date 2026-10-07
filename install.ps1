#Requires -Version 5.1
<#
.SYNOPSIS
    把 dsh-image-count-guard 装进 DSH profile（幂等，可反复运行）。

.DESCRIPTION
    手工改 profile 的三处声明并复制 node_modules 副本，**不跑 pnpm install**
    （pnpm install 会顺带升级其它 ^ 范围依赖）：
      1. <profile>\package.json 的 dependencies 加 file: 依赖；
      2. 同文件 dsh.profile.bundles 加插件名；
      3. <profile>\pnpm-lock.yaml 补 importers / packages / snapshots 三处；
      4. 复制插件文件到 <profile>\node_modules\dsh-image-count-guard。
    装完必须重启 DSH 才生效（插件在启动时装载）。

    插入位置全部使用**结构锚点**（`"dependencies": {`、`"bundles": [`、lock 的
    `packages:` / `snapshots:` 段头），不依赖任何其它插件是否存在，也不依赖本机路径。

.PARAMETER Uninstall
    反向操作：移除依赖行、bundle 行、lock 三处条目与 node_modules 副本。

.PARAMETER Profile
    目标 profile 名，默认 desktop。DSH 家目录取 $env:DSH_HOME，未设置时用 ~\.dsh。

.EXAMPLE
    pwsh -File .\install.ps1
.EXAMPLE
    pwsh -File .\install.ps1 -Profile web
.EXAMPLE
    pwsh -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch] $Uninstall,
    [string] $Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$Plugin     = 'dsh-image-count-guard'
$PluginDir  = $PSScriptRoot
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PkgPath    = Join-Path $ProfileDir 'package.json'
$LockPath   = Join-Path $ProfileDir 'pnpm-lock.yaml'
$AbsDir     = $PluginDir -replace '\\', '/'
$Spec       = "file:$AbsDir"
$Dest       = Join-Path $ProfileDir "node_modules\$Plugin"
$BackupRoot = Join-Path $PluginDir '.backup'
$CopyItems  = @('src', 'package.json', 'cordis.patch.yml', 'README.md')

function Step([string]$m) { Write-Host "[install] $m" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "[install] $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "[install] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "[install] $m" -ForegroundColor Red; exit 1 }
function Save-Text([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not (Test-Path -LiteralPath $PkgPath))  { Fail "找不到 $PkgPath" }
if (-not (Test-Path -LiteralPath $LockPath)) { Fail "找不到 $LockPath" }
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'src\index.js'))) { Fail "插件目录不完整：$PluginDir" }

# ------------------------------------------------------------------ 备份
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak   = Join-Path $BackupRoot $stamp
New-Item -ItemType Directory -Force -Path $bak | Out-Null
Copy-Item -LiteralPath $PkgPath  -Destination (Join-Path $bak 'package.json')  -Force
Copy-Item -LiteralPath $LockPath -Destination (Join-Path $bak 'pnpm-lock.yaml') -Force
Step "已备份 -> $bak"

# 备份目录只留最近 5 份
Get-ChildItem -LiteralPath $BackupRoot -Directory | Sort-Object Name -Descending |
    Select-Object -Skip 5 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }

$pkg  = [System.IO.File]::ReadAllText($PkgPath)
$lock = [System.IO.File]::ReadAllText($LockPath)

# 结构性锚点：不依赖任何具体插件的存在
$depLine      = "    `"$Plugin`": `"$Spec`",`n"
$bundleLine   = "        `"$Plugin`",`n"
$depsAnchor   = "  `"dependencies`": {`n"
$bundAnchor   = "      `"bundles`": [`n"
$impEntry     = "      $Plugin`:`n        specifier: $Spec`n        version: $Spec`n"
$impAnchor    = "  .:`n    dependencies:`n"
$pkgEntry     = "  $Plugin@$Spec`:`n    resolution: {directory: $AbsDir, type: directory}`n`n"
$pkgAnchor    = "packages:`n`n"
$snapEntry    = "  $Plugin@$Spec`: {}`n`n"
$snapAnchor   = "snapshots:`n`n"

if ($Uninstall) {
    # -------------------------------------------------------------- 卸载
    Step '卸载：移除依赖行、bundle 行、lock 条目与 node_modules 副本'

    if ($pkg.Contains($depLine))    { $pkg  = $pkg.Replace($depLine, '') }
    if ($pkg.Contains($bundleLine)) { $pkg  = $pkg.Replace($bundleLine, '') }
    Save-Text $PkgPath $pkg

    if ($lock.Contains($impEntry))  { $lock = $lock.Replace($impEntry, '') }
    if ($lock.Contains($pkgEntry))  { $lock = $lock.Replace($pkgEntry, '') }
    if ($lock.Contains($snapEntry)) { $lock = $lock.Replace($snapEntry, '') }
    Save-Text $LockPath $lock

    if (Test-Path -LiteralPath $Dest) {
        if ((Get-Item -LiteralPath $Dest -Force).LinkType) { Fail "$Dest 是链接，拒绝递归删除" }
        Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    Ok '卸载完成，重启 DSH 后生效'
} else {
    # -------------------------------------------------------------- 安装
    if ($pkg.Contains("`"$Plugin`": `"$Spec`"")) {
        Step 'package.json：已存在，跳过'
    } else {
        if (-not $pkg.Contains($depsAnchor)) { Fail "package.json 里找不到锚点：$($depsAnchor.Trim())" }
        if (-not $pkg.Contains($bundAnchor)) { Fail "package.json 里找不到锚点：$($bundAnchor.Trim())" }
        $pkg = $pkg.Replace($depsAnchor, $depsAnchor + $depLine)
        $pkg = $pkg.Replace($bundAnchor, $bundAnchor + $bundleLine)
        Save-Text $PkgPath $pkg
        Ok 'package.json：已加入依赖行与 bundle 行'
    }

    if ($lock.Contains("      $Plugin`:")) {
        Step 'pnpm-lock.yaml：已存在，跳过'
    } else {
        if (-not $lock.Contains($impAnchor))  { Fail 'pnpm-lock.yaml 里找不到 importers 锚点（  .: / dependencies:）' }
        if (-not $lock.Contains($pkgAnchor))  { Fail 'pnpm-lock.yaml 里找不到 packages: 段头' }
        if (-not $lock.Contains($snapAnchor)) { Fail 'pnpm-lock.yaml 里找不到 snapshots: 段头' }
        $lock = $lock.Replace($impAnchor,  $impAnchor + $impEntry)
        $lock = $lock.Replace($pkgAnchor,  $pkgAnchor + $pkgEntry)
        $lock = $lock.Replace($snapAnchor, $snapAnchor + $snapEntry)
        Save-Text $LockPath $lock
        Ok 'pnpm-lock.yaml：已补 importers / packages / snapshots 三处'
    }

    if (Test-Path -LiteralPath $Dest) {
        Step "node_modules\$Plugin 已存在，按 pnpm 语义删除重建"
        if ((Get-Item -LiteralPath $Dest -Force).LinkType) { Fail "$Dest 是链接，拒绝递归删除" }
        Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    foreach ($item in $CopyItems) {
        $src = Join-Path $PluginDir $item
        if (-not (Test-Path -LiteralPath $src)) { continue }
        if ((Get-Item -LiteralPath $src) -is [System.IO.DirectoryInfo]) {
            Copy-Item -LiteralPath $src -Destination $Dest -Recurse -Force
        } else {
            Copy-Item -LiteralPath $src -Destination $Dest -Force
        }
    }
    $copied = (Get-ChildItem -LiteralPath $Dest -Recurse -File | Measure-Object).Count
    Ok "node_modules\$Plugin：已复制 $copied 个文件"

    # 副本一致性（edit/write 改源文件后必须重跑本脚本同步）
    $srcHash = (Get-FileHash -LiteralPath (Join-Path $PluginDir 'src\index.js') -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath (Join-Path $Dest 'src\index.js') -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { Fail '副本与源不一致，请重跑本脚本' }
    Ok '副本 src/index.js 与源文件一致'
}

# ------------------------------------------------------------------ 校验
Write-Host ''
Write-Host '=== 校验 ===' -ForegroundColor Cyan
$json = [System.IO.File]::ReadAllText($PkgPath) | ConvertFrom-Json
"profile            : $Profile ($ProfileDir)"
"插件目录           : $PluginDir"
"file: specifier    : $Spec"
"deps 含插件        : $([bool]($json.dependencies.PSObject.Properties.Name -contains $Plugin))"
"bundles 含插件     : $([bool](@($json.dsh.profile.bundles) -contains $Plugin))"
"node_modules 副本  : $(Test-Path -LiteralPath $Dest)"
"lock 含插件        : $([bool]([System.IO.File]::ReadAllText($LockPath).Contains($Plugin)))"
"备份               : $bak"
Write-Host ''
if (-not $Uninstall) {
    Ok '配置完成。下一步：重启 DSH，然后在卡住的会话里发一句「继续」验证恢复。'
    Warn '若之后用 edit/write 改过插件源文件，必须重跑本脚本同步副本（否则 DSH 加载的还是旧代码）。'
}
