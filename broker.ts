#!/usr/bin/env bun
/**
 * claude-peers broker daemon
 *
 * A singleton HTTP server on localhost:7899 backed by SQLite.
 * Tracks all registered Claude Code peers and routes messages between them.
 *
 * Auto-launched by the MCP server if not already running.
 * Run directly: bun broker.ts
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  PeerId,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.CLAUDE_PEERS_PORT ?? "7899", 10);
// Use `os.homedir()` instead of `process.env.HOME` so the default DB path
// resolves correctly on Windows (where HOME is typically unset; Node/Bun
// derive the home directory from USERPROFILE / SystemDrive\Users).
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? join(homedir(), ".claude-peers.db");

// --- At-least-once delivery tuning ---
// 訊息不再「一撈出就銷帳」，也「永不因次數放棄」。銷帳（delivered=1）只由收件方
// ack（送出回覆）或 consume（check_messages 取進 context）觸發——所以訊息不可能被靜默丟失。
// 重投分兩段：前 BURST_ATTEMPTS 次快投（VISIBILITY_MS）保即時，之後轉慢投（SLOW_VISIBILITY_MS）
// 當安全網、一路投到被 ack 為止，避免瘋狂洗版。死掉的 peer 由 cleanStalePeers 清其未讀訊息。
const VISIBILITY_MS = parseInt(process.env.CLAUDE_PEERS_VISIBILITY_MS ?? "20000", 10);
const BURST_ATTEMPTS = parseInt(process.env.CLAUDE_PEERS_BURST_ATTEMPTS ?? "5", 10);
const SLOW_VISIBILITY_MS = parseInt(process.env.CLAUDE_PEERS_SLOW_VISIBILITY_MS ?? "300000", 10);

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    tty TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

// Schema migration (idempotent): at-least-once needs per-message delivery bookkeeping.
// Old DBs created before this change lack these columns — add them if missing.
{
  const cols = db.query("PRAGMA table_info(messages)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("deliver_attempts")) {
    db.run("ALTER TABLE messages ADD COLUMN deliver_attempts INTEGER NOT NULL DEFAULT 0");
  }
  if (!have.has("last_attempt_at")) {
    db.run("ALTER TABLE messages ADD COLUMN last_attempt_at TEXT");
  }
}

// Clean up stale peers (PIDs that no longer exist) on startup
function cleanStalePeers() {
  const peers = db.query("SELECT id, pid FROM peers").all() as { id: string; pid: number }[];
  for (const peer of peers) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(peer.pid, 0);
    } catch {
      // Process doesn't exist, remove it
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();

// Periodically clean stale peers (every 30s)
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, pid, cwd, git_root, tty, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateLastSeen = db.prepare(`
  UPDATE peers SET last_seen = ? WHERE id = ?
`);

const updateSummary = db.prepare(`
  UPDATE peers SET summary = ? WHERE id = ?
`);

const deletePeer = db.prepare(`
  DELETE FROM peers WHERE id = ?
`);

const selectAllPeers = db.prepare(`
  SELECT * FROM peers
`);

const selectPeersByDirectory = db.prepare(`
  SELECT * FROM peers WHERE cwd = ?
`);

const selectPeersByGitRoot = db.prepare(`
  SELECT * FROM peers WHERE git_root = ?
`);

const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, 0)
`);

// Auto-push (redelivery) path — two-tier, never gives up (never marks delivered):
//   - first BURST_ATTEMPTS pushes: fast retry (VISIBILITY_MS apart) for immediacy
//   - after that: slow retry (SLOW_VISIBILITY_MS apart) forever, as a safety net
// A message is only ever marked delivered by a real ack/consume, so it can never be
// silently dropped — the worst case is a slow, low-frequency re-ping until acked.
const selectDue = db.prepare(`
  SELECT * FROM messages
  WHERE to_id = ? AND delivered = 0
    AND (
      (deliver_attempts < ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?))
      OR
      (deliver_attempts >= ? AND last_attempt_at <= ?)
    )
  ORDER BY sent_at ASC
`);

// Manual check_messages path: everything still undelivered for this peer (ignores
// visibility — the model is explicitly pulling, so hand it all pending at once).
const selectAllUndelivered = db.prepare(`
  SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC
`);

const bumpAttempt = db.prepare(`
  UPDATE messages SET deliver_attempts = deliver_attempts + 1, last_attempt_at = ? WHERE id = ?
`);

// Ack a single message, but only if it actually belongs to the peer claiming it (guard
// against a peer acking someone else's message).
const markDeliveredForPeer = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ? AND to_id = ?
`);

const markDelivered = db.prepare(`
  UPDATE messages SET delivered = 1 WHERE id = ?
`);

// --- Generate peer ID ---

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const now = new Date().toISOString();

  // Carry-over summary: a reconnect/restart re-registers with an empty or auto-generated
  // summary, which would wipe the role the peer had published. Capture the prior summary
  // for the id it's reclaiming (and for its pid) BEFORE any delete, so we can preserve it
  // when the incoming registration doesn't bring its own.
  let carriedSummary = "";
  const wantedId = body.desired_id?.trim();
  if (wantedId) {
    const prevById = db.query("SELECT summary FROM peers WHERE id = ?").get(wantedId) as
      | { summary: string }
      | null;
    if (prevById?.summary) carriedSummary = prevById.summary;
  }

  // Remove any existing registration for this PID (re-registration after a session restart).
  const existingByPid = db.query("SELECT id, summary FROM peers WHERE pid = ?").get(body.pid) as
    | { id: string; summary: string }
    | null;
  if (existingByPid) {
    if (!carriedSummary && existingByPid.summary) carriedSummary = existingByPid.summary;
    deletePeer.run(existingByPid.id);
  }

  // Decide the peer ID. If the caller supplied `desired_id`, try to honor it.
  // Conflict resolution mirrors the PID-based takeover above: if the previous
  // holder's process is dead, evict and reuse the ID; otherwise fall back to
  // generating a unique random ID.
  let id = "";
  if (body.desired_id && body.desired_id.trim()) {
    const wanted = body.desired_id.trim();
    const existingById = db.query("SELECT id, pid FROM peers WHERE id = ?").get(wanted) as
      | { id: string; pid: number }
      | null;
    if (!existingById) {
      id = wanted;
    } else {
      let prevAlive = false;
      try {
        process.kill(existingById.pid, 0);
        prevAlive = true;
      } catch {
        prevAlive = false;
      }
      if (!prevAlive) {
        deletePeer.run(existingById.id);
        id = wanted;
      } else {
        // Previous holder still alive — fall back to random ID so registration
        // never fails outright. The launcher can detect this drift by comparing
        // the requested ID with the returned ID.
        id = generateId();
      }
    }
  } else {
    id = generateId();
  }

  // Use the incoming summary if it carries one, otherwise fall back to the preserved prior
  // summary so a reconnect keeps the peer's published role instead of blanking it.
  const effectiveSummary =
    body.summary && body.summary.trim() ? body.summary : carriedSummary;

  insertPeer.run(id, body.pid, body.cwd, body.git_root, body.tty, effectiveSummary, now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];

  switch (body.scope) {
    case "machine":
      peers = selectAllPeers.all() as Peer[];
      break;
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      if (body.git_root) {
        peers = selectPeersByGitRoot.all(body.git_root) as Peer[];
      } else {
        // No git root, fall back to directory
        peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      }
      break;
    default:
      peers = selectAllPeers.all() as Peer[];
  }

  // Exclude the requesting peer
  if (body.exclude_id) {
    peers = peers.filter((p) => p.id !== body.exclude_id);
  }

  // Verify each peer's process is still alive
  return peers.filter((p) => {
    try {
      process.kill(p.pid, 0);
      return true;
    } catch {
      // Clean up dead peer
      deletePeer.run(p.id);
      return false;
    }
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  // Verify target exists
  const target = db.query("SELECT id FROM peers WHERE id = ?").get(body.to_id) as { id: string } | null;
  if (!target) {
    return { ok: false, error: `Peer ${body.to_id} not found` };
  }

  insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

// Auto-push path (called by each peer's MCP server every ~1s).
// Redelivery semantics: return due messages and bump their attempt counter, but NEVER
// mark them delivered — that happens only on explicit ack/consume, so nothing is ever
// silently dropped. Retry cadence is two-tier (fast burst, then slow safety net forever).
function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const now = Date.now();
  const cutoffFast = new Date(now - VISIBILITY_MS).toISOString();
  const cutoffSlow = new Date(now - SLOW_VISIBILITY_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  // Two-tier due set: fast tier while attempts < BURST_ATTEMPTS, slow tier thereafter.
  // No give-up — messages stay pending until a real ack/consume, so nothing is dropped.
  const messages = selectDue.all(
    body.id, BURST_ATTEMPTS, cutoffFast, BURST_ATTEMPTS, cutoffSlow
  ) as Message[];
  for (const msg of messages) {
    bumpAttempt.run(nowIso, msg.id);
  }
  return { messages };
}

// Explicit ack: recipient confirms it consumed these messages (replied / checked).
// Only marks messages actually addressed to the acking peer.
function handleAckMessages(body: { id: PeerId; message_ids: number[] }): { ok: boolean; acked: number } {
  let acked = 0;
  for (const mid of body.message_ids ?? []) {
    const res = markDeliveredForPeer.run(mid, body.id);
    acked += res.changes;
  }
  return { ok: true, acked };
}

// Manual pull (check_messages tool): return ALL undelivered for this peer and mark them
// delivered immediately — being returned into the model's context IS consumption.
function handleConsumeMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectAllUndelivered.all(body.id) as Message[];
  for (const msg of messages) {
    markDelivered.run(msg.id);
  }
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- HTTP Server ---

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method !== "POST") {
      if (path === "/health") {
        return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
      }
      return new Response("claude-peers broker", { status: 200 });
    }

    try {
      const body = await req.json();

      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/ack-messages":
          return Response.json(handleAckMessages(body as { id: PeerId; message_ids: number[] }));
        case "/consume-messages":
          return Response.json(handleConsumeMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers broker] listening on 127.0.0.1:${PORT} (db: ${DB_PATH})`);
