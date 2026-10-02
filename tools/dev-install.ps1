# 把这个插件同步进某个 dsh profile 的 node_modules —— 以**真实目录**的形式。
#
# ## 为什么是复制，不是软链接
#
# Node 解析裸模块名时会先 realpath。插件如果是指向工作区的 junction，真实路径就落在
# profile 之外，于是随 dsh 安装本体发布的包（例如 `@deepseek-ai/schemastery`）解析不到：
# dsh 的链路是 `<profile>/node_modules` → `<DSH_HOME>/profiles/node_modules`
# （安装作用域的投影）。从 npm 装的官方插件都是真实目录，所以它们能工作。
#
# ## 为什么改完源码必须手动跑一次
#
# pnpm 对 `file:` 目录依赖按**路径**而非内容哈希判定，`install` 会回 "Already up to date"
# —— 它不会发现你在工作区里改了文件。所以这个脚本就是"改完源码后的那一步"。
#
# 用法：
#   powershell -File tools/dev-install.ps1
#   powershell -File tools/dev-install.ps1 -DshHome C:\Users\Administrator\.dsh -Profile desktop -SkipProjection
#
# 生效范围：
#   - **宿主半**（`index.js` / `lib/*.js`）改了要**重启 dsh 进程**；
#   - **浏览器半**（`client.js` / `lib/embed/*`）改了**刷新窗口**就够。
param(
    [string]$DshHome = 'C:\Users\Administrator\.dsh',
    [string]$Profile = 'desktop',
    [string]$ProjectionDonor = 'C:\Users\Administrator\.dsh\profiles\node_modules',
    [switch]$SkipProjection
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$target = Join-Path $profileDir 'node_modules\dsh-infinite-canvas'

if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile 不存在：$profileDir`n（用 dsh --profile $Profile --from-default-profile web --help 可以创建）"
}

# 只删链接本身，绝不递归进 junction —— 那会把工作区源码一起删掉。
function Remove-LinkOrDirectory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        & cmd.exe /c rmdir "$Path" | Out-Null
    }
    else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

# 桌面应用在 <DSH_HOME>\profiles\node_modules 维护一份安装本体的包投影。
# 由 CLI 创建的 profile 没有，需要从已有的 home 链一份进来；而**由应用托管的
# profile**（比如 Electron 桌面端用的 desktop）自带这些包，所以要传 -SkipProjection。
$projection = Join-Path $DshHome 'profiles\node_modules'
if ($SkipProjection) {
    Write-Output "跳过 projection（应用托管的 profile 自带安装本体的包）"
}
elseif (-not (Test-Path -LiteralPath $projection)) {
    if (-not (Test-Path -LiteralPath $ProjectionDonor)) { throw "projection 来源不存在：$ProjectionDonor" }
    New-Item -ItemType Junction -Path $projection -Target $ProjectionDonor | Out-Null
    Write-Output "已建立 projection：$projection -> $ProjectionDonor"
}

Remove-LinkOrDirectory $target
New-Item -ItemType Directory -Path $target -Force | Out-Null

# 顶层文件：存在才拷（README / LICENSE 可以没有）。
foreach ($file in @('index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'CHANGELOG.md', 'LICENSE')) {
    $from = Join-Path $source $file
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $target $file) -Force }
}

# 目录：`lib` 里同时住着宿主半和 embed 那一包画布文件，两者都要。
foreach ($dir in @('lib', 'locale')) {
    $from = Join-Path $source $dir
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $target $dir) -Recurse -Force }
}

$count = (Get-ChildItem -LiteralPath $target -Recurse -File | Measure-Object).Count
Write-Output "已同步 $count 个文件 -> $target"
