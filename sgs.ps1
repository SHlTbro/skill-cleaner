param([Parameter(ValueFromRemainingArguments=$true)][string[]]$SgsArguments)
$ErrorActionPreference='Stop'
$taskNode = if ($env:SGS_NODE) { $env:SGS_NODE } else { (Get-Command node -CommandType Application -ErrorAction Stop).Source }
& $taskNode (Join-Path $PSScriptRoot 'src/sgs.mjs') @SgsArguments
exit $LASTEXITCODE
