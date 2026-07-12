param(
  [Parameter(Mandatory=$true)][string]$RootPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $RootPath).Path
# 排除 OutputPath 自身：重新生成 manifest 时旧 manifest 文件会被扫到，导致递归（新 manifest 含旧 manifest 的 sha256，fileCount 虚高 +1）。
# OutputPath 不存在时（首次生成）$excludePath=$null，Where-Object 不过滤。
$excludePath = $null
if (Test-Path $OutputPath) {
  $excludePath = (Resolve-Path $OutputPath).Path
}
$items = Get-ChildItem -Path $root -File -Recurse | Where-Object { $excludePath -eq $null -or $_.FullName -ne $excludePath } | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($root.Length).TrimStart('\','/') -replace '\\','/'
  $hash = Get-FileHash -Path $_.FullName -Algorithm SHA256
  [PSCustomObject]@{
    path = $relative
    sizeBytes = $_.Length
    sha256 = $hash.Hash.ToLowerInvariant()
  }
}
$result = [PSCustomObject]@{
  root = $root
  generatedAt = (Get-Date).ToString('s')
  fileCount = @($items).Count
  totalBytes = (@($items) | Measure-Object -Property sizeBytes -Sum).Sum
  files = @($items)
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Resolve-Path (Split-Path $OutputPath -Parent)).Path + [System.IO.Path]::DirectorySeparatorChar + (Split-Path $OutputPath -Leaf), ($result | ConvertTo-Json -Depth 8), $utf8NoBom)
