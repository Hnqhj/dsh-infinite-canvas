# 把工作区的插件同步进**每一个会用它的 profile**。
#
# 插件是以真实目录装的（`file:` 规格），所以只改工作区源码对已安装的 profile
# 没有任何影响 —— 这就是"改完源码之后的那一条命令"：
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/sync-all.ps1
#
# 提醒：宿主半（`lib/*.js`）改了要重启对应的应用；浏览器半（`client.js`、
# `lib/embed/*`）改了刷新窗口即可。
param(
    [string[]]$Profiles = @('desktop'),
    [string]$DshHome = 'C:\Users\Administrator\.dsh',
    [string]$DevHome = 'C:\Users\Administrator\.dsh-dev',
    [string]$DevProfile = ''
)

$ErrorActionPreference = 'Continue'
$script = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\dev-install.ps1'

foreach ($name in $Profiles) {
    $dir = Join-Path $DshHome "profiles\$name"
    if (-not (Test-Path -LiteralPath $dir)) {
        Write-Output "跳过：profile 不存在 $dir"
        continue
    }
    Write-Output "== $DshHome / $name =="
    # 桌面端由应用托管 profile，自带安装本体的包，不需要 projection。
    # CLI 创建的 dev profile 则需要，所以那条分支不传 -SkipProjection。
    & powershell -NoProfile -ExecutionPolicy Bypass -File $script -DshHome $DshHome -Profile $name -SkipProjection
}

if ($DevProfile -ne '') {
    $dir = Join-Path $DevHome "profiles\$DevProfile"
    if (Test-Path -LiteralPath $dir) {
        Write-Output "== $DevHome / $DevProfile（CLI profile）=="
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script -DshHome $DevHome -Profile $DevProfile
    }
    else {
        Write-Output "跳过：dev profile 不存在 $dir"
    }
}
