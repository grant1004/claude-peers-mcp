# claude-peers 自動 set summary — 移植到新機（只跑 claude-peers-mcp）

目標：新機只用 claude-peers-mcp，要「重連自動保留 summary」＋「全開自動認角色、自己 set summary」。
分兩層，Layer 1 用 git、Layer 2 帶這個資料夾。

---

## Layer 1：重連自動保留 summary（＋訊息絕不丟）
**這層在 GitHub repo 裡，用 git 就好，不用帶檔。**

1. 新機的 `claude-peers-mcp` 切到分支 `feat/desired-peer-id`，`git pull`
   （改動已 push：commit「Make peer messaging reliable + preserve summary across reconnect」）
2. `cd claude-peers-mcp && bun install`
3. 重啟該機的 broker：關掉舊的（`bun cli.ts kill-broker`），下次 peer 啟動時會自動拉起新版；
   或直接 `bun broker.ts`（port 7899）
4. 生效：之後 peer **重連/重啟不會再清空 summary**（broker 會保留該 id 的舊 summary）

> 只要 Layer 1 的話，到這就結束了。

---

## Layer 2：全開空白 session 自動認角色、自己 set summary
把這個資料夾的檔放到新機對應位置：

1. **`peer_bootstrap.js`** → 放到 `<家目錄>/.claude/tasks/peer_bootstrap.js`
   （檔案本身可攜、內部用 homedir，不用改）

2. **`peer_roles.example.json`** → 改成新機自己的角色，存成 `<家目錄>/.claude/tasks/peer_roles.json`
   - 把 `roles` 換成那台實際要跑的 peer（名字＝之後 `-id` 用的名字）
   - `_common` 的路徑若不是 Windows-grant 記得改或刪

3. **SessionStart hook** → 照 `settings-sessionstart-hook.md` 把片段加進新機的 `~/.claude/settings.json`
   （這是讓開機自動跑 bootstrap 的關鍵）

4. **`claude-peers.ps1`**（選用，選單啟動器）→ 放到新機 PATH 上的目錄（例 `<家目錄>\bin`）
   - 之後啟動 peer：`claude-peers`（跳選單挑角色）或 `claude-peers -id <角色名>`
   - 它會設 `CLAUDE_PEERS_PEER_ID`＝bootstrap 靠這個認身分
   - 若不裝這支，也可手動：啟動 claude 前先設 `$env:CLAUDE_PEERS_PEER_ID="<角色名>"`

### 驗證 Layer 2
- 用 `claude-peers -id <某角色>` 全開一個 peer → 開場應自動印出該角色的身分卡
- peer 照卡片 set_summary → `bun cli.ts peers` 看得到它的 summary

---

## 前提／注意
- 新機要有 **bun**（claude-peers-mcp 用）、**node**（跑 peer_bootstrap.js）
- Layer 2 的自動認角色，前提是 peer 啟動時帶了 `CLAUDE_PEERS_PEER_ID`（用 claude-peers.ps1 或手動設）
- `peer_bootstrap.js` 打錯 id 會列出有效角色＋猜最接近的，不會靜默出錯
- 完整原理見本機 `~/.claude/tasks/MIGRATION_CHECKLIST.md` 的「Session 自我辨識」段（那份是全套移植清單，你只需要上面這兩層）
