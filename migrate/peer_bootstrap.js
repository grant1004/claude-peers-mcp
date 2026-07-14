#!/usr/bin/env node
// peer_bootstrap.js — 全開 session（空白對話）的自我定位。
// 印出「你是誰、負責什麼、先做什麼」的繁中簡報，讓剛開機、沒有前次對話記憶的
// peer session 立刻知道自己的身分並接軌。
//
// 身分來源（依序）：命令列參數 > 環境變數 CLAUDE_PEERS_PEER_ID
//   bun peer_bootstrap.js 小天才      # 明確指定
//   bun peer_bootstrap.js             # 讀 CLAUDE_PEERS_PEER_ID（named peer 啟動時帶）
//
// 設計成可被 SessionStart hook 直接呼叫：無身分時安靜退出（給非 peer session 用），
// 有身分時把角色卡印到 stdout（hook 會注入進 session context）。
'use strict'
const fs = require('fs')
const path = require('path')

const ROLES_PATH = path.join(process.env.USERPROFILE || require('os').homedir(), '.claude', 'tasks', 'peer_roles.json')

const id = (process.argv[2] || process.env.CLAUDE_PEERS_PEER_ID || '').trim()
if (!id) {
  // 非 peer session（沒帶身分）→ 安靜退出，不干擾一般 session
  process.exit(0)
}

let reg
try {
  reg = JSON.parse(fs.readFileSync(ROLES_PATH, 'utf8'))
} catch (e) {
  console.log(`[peer bootstrap] 讀不到 peer_roles.json（${e.message}）；請守門員確認 ${ROLES_PATH}`)
  process.exit(0)
}

const role = reg.roles && reg.roles[id]
const c = reg._common || {}

if (!role) {
  const validIds = Object.keys(reg.roles || {})
  // 猜最可能要打的 id（Levenshtein 編輯距離），抓 -id 打錯的常見情況
  const lev = (a, b) => {
    const m = a.length, n = b.length
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
    for (let j = 0; j <= n; j++) dp[0][j] = j
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
    return dp[m][n]
  }
  let best = null, bestD = Infinity
  for (const v of validIds) { const d = lev(id, v); if (d < bestD) { bestD = d; best = v } }
  const suggest = (best && bestD <= 2) ? `\n→ 你是不是要打「${best}」？（-id 可能打錯了）` : ''

  console.log(`⚠️ 你以 id「${id}」啟動，但 peer_roles.json 沒有這個角色。${suggest}
有效 id：${validIds.join('、')}
兩種可能：
1. -id 打錯了 → 關掉、用正確的名字重開（claude-peers -id <正確名字>）
2. 這是要新增的角色 → send_message 問守門員，或請守門員在 ${ROLES_PATH} 補登記後你再重開
先讀 ${c.protocol || 'worker_protocol.md'}、set_summary 宣告你是「${id}」，別假裝是別人。`)
  process.exit(0)
}

const lines = []
lines.push(`════════ 你是 peer：${id}（${role.title}）════════`)
lines.push('')
lines.push(`【你的職責】${role.duty}`)
if (role.threads && Object.keys(role.threads).length) {
  lines.push(`【你綁的討論串】` + Object.entries(role.threads).map(([k, v]) => `${k}=${v}`).join('、'))
}
if (role.channels && Object.keys(role.channels).length) {
  lines.push(`【你負責的頻道】` + Object.entries(role.channels).map(([k, v]) => `${k}=${v}`).join('、'))
}
if (role.tools) lines.push(`【現成工具】${role.tools}`)
if (role.backup) lines.push(`【你的備援】${role.backup}`)
if (role.note) lines.push(`【備註】${role.note}`)
lines.push('')
lines.push('【通用協議】')
lines.push(`- 讀協議：${c.protocol}`)
lines.push(`- 路由表：${c.routes}`)
lines.push(`- 載入你這串的工作記憶：${c.memory_load}（把 <THREAD_ID> 換成你綁的串）`)
lines.push(`- 對口：${c.gatekeeper}`)
lines.push(`- 交付方式：${c.delivery}`)
lines.push('')
lines.push('【現在就做】')
;(c.first_actions || []).forEach((a, i) => lines.push(`${i + 1}. ${a}`))
lines.push('')
lines.push('訊息投遞已是 at-least-once（會重投直到你 ack）；看到重複訊息＝重投，回覆或 check_messages 一次即可。')

console.log(lines.join('\n'))
