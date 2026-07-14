# claude-peers [-id <name>] [...extra claude args]
#
# Launcher for Claude Code wired into the claude-peers MCP channel network.
#
# What it does:
#   1. Resolves the peer id:
#        - `-id <name>` that matches peer_roles.json  → use it (fast path)
#        - `-id <name>` that does NOT match           → warn + show picker
#        - no `-id`                                    → show picker
#      The picker reads roles from peer_roles.json so it always reflects the
#      current registry (no typos possible when you pick from the list).
#   2. Sets $env:CLAUDE_PEERS_PEER_ID = <resolved name> for the launched process
#      so server.ts registers the peer under that ID.
#   3. Launches `claude` with the channel wiring; passes extra args through.
#
# Examples:
#   claude-peers                    # pick from menu
#   claude-peers -id 小天才          # explicit (must be a registered role)
#   claude-peers -id sessionA --resume abc123
#
# Env:
#   CLAUDE_PEERS_DRYRUN=1  → resolve the id and print it, but do NOT launch claude
#                            (for testing the picker without spawning a session)

[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Id,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ExtraArgs
)

$rolesPath = Join-Path $env:USERPROFILE '.claude\tasks\peer_roles.json'

# Load registered roles (id -> title). Empty if the registry is unreadable.
$roles = [ordered]@{}
if (Test-Path $rolesPath) {
    try {
        $json = Get-Content $rolesPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $json.roles.PSObject.Properties) {
            $roles[$p.Name] = $p.Value.title
        }
    } catch {
        Write-Host "讀 peer_roles.json 失敗：$($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Show-Picker {
    param([string]$BadId)

    if ($BadId) {
        Write-Host "id「$BadId」不在角色登記表。" -ForegroundColor Yellow
    }
    Write-Host "選擇要啟動的 peer：" -ForegroundColor Cyan

    $names = @($roles.Keys)
    for ($i = 0; $i -lt $names.Count; $i++) {
        Write-Host ("  {0}) {1}  —  {2}" -f ($i + 1), $names[$i], $roles[$names[$i]])
    }
    $customIdx = $names.Count + 1
    Write-Host ("  {0}) 其他（自訂新角色，記得之後在 peer_roles.json 補登記）" -f $customIdx)

    $choice = Read-Host "請選擇 [1-$customIdx]"
    $n = 0
    if ([int]::TryParse($choice, [ref]$n)) {
        if ($n -ge 1 -and $n -le $names.Count) { return $names[$n - 1] }
        if ($n -eq $customIdx) {
            $custom = (Read-Host "輸入新角色名字").Trim()
            if ($custom) { return $custom }
        }
    }
    Write-Host "無效選擇，取消啟動。" -ForegroundColor Red
    exit 1
}

# --- Resolve the peer id ---
$peerId = $null
if ($Id) {
    if ($roles.Count -eq 0 -or $roles.Contains($Id)) {
        # matches a registered role, or registry unreadable → trust the caller
        $peerId = $Id
    } else {
        $peerId = Show-Picker -BadId $Id
    }
} elseif ($roles.Count -gt 0) {
    $peerId = Show-Picker
} else {
    Write-Host "找不到 peer_roles.json，請改用 claude-peers -id <名字>" -ForegroundColor Red
    exit 1
}

if (-not $peerId) { Write-Host "未選擇 peer，取消。" -ForegroundColor Red; exit 1 }

$env:CLAUDE_PEERS_PEER_ID = $peerId
Write-Host "啟動 peer：$peerId" -ForegroundColor Green

# Dry-run escape hatch (testing): resolve + report, don't spawn claude.
if ($env:CLAUDE_PEERS_DRYRUN) {
    Write-Host "DRYRUN peerId=$peerId"
    exit 0
}

$claudeArgs = @(
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', 'server:claude-peers'
)
if ($ExtraArgs) { $claudeArgs += $ExtraArgs }

& claude @claudeArgs
exit $LASTEXITCODE
