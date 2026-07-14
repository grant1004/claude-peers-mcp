# SessionStart hook 片段（加進新機的 ~/.claude/settings.json）

作用：全開/清空 session 時自動跑 `peer_bootstrap.js`，讓帶了 `CLAUDE_PEERS_PEER_ID` 的 peer
session 開機就唸出自己的角色卡（無身分＝安靜退出，對非 peer session 無影響）。

## 若新機的 settings.json 還【沒有】hooks.SessionStart
把整段 `"hooks"` 加進去（或把 `SessionStart` 併入既有 `hooks`）：

```json
"hooks": {
  "SessionStart": [
    {
      "matcher": "startup",
      "hooks": [
        { "type": "command", "command": "node \"<家目錄>/.claude/tasks/peer_bootstrap.js\"" }
      ]
    },
    {
      "matcher": "clear",
      "hooks": [
        { "type": "command", "command": "node \"<家目錄>/.claude/tasks/peer_bootstrap.js\"" }
      ]
    }
  ]
}
```

## 若新機【已有】hooks.SessionStart
只要在 `startup`（和 `clear`）那組的 `hooks` 陣列裡，多加一條：

```json
{ "type": "command", "command": "node \"<家目錄>/.claude/tasks/peer_bootstrap.js\"" }
```

## 注意
- 把 `<家目錄>` 換成該機實際路徑（Windows 例：`C:\\Users\\你的使用者`；反斜線要雙寫 `\\`）。
- 改完用 `node -e "require('<家目錄>/.claude/settings.json')"` 驗證 JSON 沒壞（壞掉會影響該機所有 session）。
