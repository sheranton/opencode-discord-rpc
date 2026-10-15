/**
 * OpenCode Discord Rich Presence — V2 plugin
 *
 * A dependency-free port for the OpenCode V2 plugin API. Speaks Discord's IPC
 * named-pipe protocol directly (no @xhayper/discord-rpc, no npm install, no
 * build step).
 *
 * Shows:
 *   - the model the active session is using
 *   - the project / session you're coding in
 *   - live token count in the session's context
 *   - activity status (Coding / Thinking / Waiting / Idle) + elapsed timer
 *
 * Env config:
 *   OPENCODE_DISCORD_ENABLED        "false" to disable          (default "true")
 *   OPENCODE_DISCORD_CLIENT_ID      your own Discord app id      (default built-in)
 *   OPENCODE_DISCORD_RETRY_INTERVAL reconnect interval ms        (default 15000)
 *   OPENCODE_DISCORD_MAX_RETRIES    max reconnect attempts       (default 5)
 *   OPENCODE_DISCORD_SHOW_PROJECT   "false" to hide project name (default "true")
 *   OPENCODE_DISCORD_SHOW_SESSION   "false" to hide session title(default "true")
 *   OPENCODE_DISCORD_SHOW_TOKENS    "false" to hide token count  (default "true")
 */

import net from "node:net";
import { randomUUID } from "node:crypto";

const DEFAULT_CLIENT_ID = "1462270555586822206";

// IPC opcodes
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

// Discord throttles SET_ACTIVITY; keep a floor between sends.
const PRESENCE_MIN_INTERVAL = 2500;
// Throttle session.get() lookups during streaming bursts.
const SESSION_REFRESH_INTERVAL = 2000;

function readConfig() {
  const flag = (v, def) => (v === undefined ? def : v !== "false");
  return {
    clientId: process.env.OPENCODE_DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID,
    enabled: process.env.OPENCODE_DISCORD_ENABLED !== "false",
    retryInterval: parseInt(process.env.OPENCODE_DISCORD_RETRY_INTERVAL || "15000", 10),
    maxRetries: parseInt(process.env.OPENCODE_DISCORD_MAX_RETRIES || "5", 10),
    showProject: flag(process.env.OPENCODE_DISCORD_SHOW_PROJECT, true),
    showSession: flag(process.env.OPENCODE_DISCORD_SHOW_SESSION, true),
    showTokens: flag(process.env.OPENCODE_DISCORD_SHOW_TOKENS, true),
  };
}

// "claude-sonnet-4-20250514" -> "claude-sonnet-4", "gpt-4o-2024-08-06" -> "gpt-4o"
function formatModelName(modelId) {
  if (!modelId) return undefined;
  return String(modelId)
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

// last path segment of a win/unix directory
function baseName(dir) {
  if (!dir) return undefined;
  const parts = String(dir).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
}

// 34210 -> "34.2k", 980 -> "980"
function formatTokens(n) {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

const STATUS_TEXT = {
  coding: "Coding",
  idle: "Idle",
  thinking: "Thinking",
  waiting: "Waiting for input",
};

function log(msg, level = "info") {
  console.log(`[discord-rpc] [${level}] ${msg}`);
}

/**
 * Minimal Discord IPC client: handshake + SET_ACTIVITY over the local named pipe.
 */
class DiscordIPC {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.retryCount = 0;
    this.retryTimer = null;
    this.recvBuf = Buffer.alloc(0);
    this.pending = null;
    this.closedByUs = false;
  }

  pipePath(id) {
    if (process.platform === "win32") return `\\\\?\\pipe\\discord-ipc-${id}`;
    const base =
      process.env.XDG_RUNTIME_DIR ||
      process.env.TMPDIR ||
      process.env.TMP ||
      process.env.TEMP ||
      "/tmp";
    return `${base.replace(/\/$/, "")}/discord-ipc-${id}`;
  }

  encode(op, data) {
    const payload = Buffer.from(JSON.stringify(data), "utf8");
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  async connect() {
    if (!this.config.enabled || this.connected || this.connecting) return this.connected;
    this.connecting = true;
    this.closedByUs = false;
    const ok = await this.tryPipes(0);
    this.connecting = false;
    if (!ok) this.scheduleReconnect();
    return ok;
  }

  tryPipes(start) {
    return new Promise((resolve) => {
      const attempt = (id) => {
        if (id > 9) return resolve(false);
        const sock = net.connect(this.pipePath(id));
        let settled = false;
        sock.on("connect", () => {
          settled = true;
          this.socket = sock;
          this.recvBuf = Buffer.alloc(0);
          sock.on("data", (chunk) => this.onData(chunk));
          sock.on("close", () => this.onClose());
          sock.on("error", () => {});
          sock.write(this.encode(OP_HANDSHAKE, { v: 1, client_id: this.config.clientId }));
          resolve(true);
        });
        sock.on("error", () => {
          if (settled) return;
          sock.destroy();
          attempt(id + 1);
        });
      };
      attempt(start);
    });
  }

  onData(chunk) {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    while (this.recvBuf.length >= 8) {
      const op = this.recvBuf.readInt32LE(0);
      const len = this.recvBuf.readInt32LE(4);
      if (this.recvBuf.length < 8 + len) break;
      const body = this.recvBuf.slice(8, 8 + len);
      this.recvBuf = this.recvBuf.slice(8 + len);

      let data = {};
      try {
        data = JSON.parse(body.toString("utf8"));
      } catch {
        data = {};
      }

      if (op === OP_PING) {
        this.socket?.write(this.encode(OP_PONG, data));
        continue;
      }
      if (op === OP_CLOSE) {
        this.onClose();
        return;
      }
      if (op === OP_FRAME && data.evt === "READY") {
        this.connected = true;
        this.retryCount = 0;
        log("Connected to Discord");
        if (this.pending) this.send(this.pending);
      }
    }
  }

  onClose() {
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    if (this.closedByUs) return;
    if (wasConnected) log("Disconnected from Discord", "warn");
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.retryCount >= this.config.maxRetries) {
      log(`Max retry attempts (${this.config.maxRetries}) reached. Giving up.`, "warn");
      return;
    }
    this.retryCount++;
    this.retryTimer = setTimeout(() => this.connect(), this.config.retryInterval);
  }

  /** activity is a fully-built Discord activity object, or null to clear. */
  send(activity) {
    this.pending = activity;
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(
        this.encode(OP_FRAME, {
          cmd: "SET_ACTIVITY",
          args: { pid: process.pid, activity },
          nonce: randomUUID(),
        })
      );
    } catch (err) {
      log(`Failed to update presence: ${err?.message || err}`, "error");
    }
  }

  disconnect() {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.send(null);
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.socket = null;
    this.connected = false;
    this.connecting = false;
  }
}

export default {
  id: "discord-rpc",
  async setup(ctx) {
    const config = readConfig();
    if (!config.enabled) {
      log("Plugin disabled via configuration");
      return () => {};
    }

    const rpc = new DiscordIPC(config);

    // --- live state ---
    let status = "idle";
    let sessionID = undefined;
    let startTimestamp = Date.now();
    const snap = { model: undefined, project: undefined, title: undefined, ctxTokens: 0 };

    // read a field out of an event regardless of V1/V2 wrapper naming
    const eventData = (event) => event?.data ?? event?.properties ?? {};
    const unwrap = (res) => (res && typeof res === "object" && "data" in res ? res.data : res);

    const contextTokens = (tokens) => {
      if (!tokens) return 0;
      const cache = tokens.cache || {};
      return (
        (tokens.input || 0) + (cache.read || 0) + (cache.write || 0)
      );
    };

    // Pull model/title/project/tokens from a Session.Info object.
    const applySession = (info) => {
      if (!info) return;
      const model = formatModelName(info.model?.id);
      if (model) snap.model = model;
      if (config.showSession && info.title) snap.title = info.title;
      if (config.showProject) {
        const proj = baseName(info.location?.directory);
        if (proj) snap.project = proj;
      }
      if (config.showTokens) snap.ctxTokens = contextTokens(info.tokens);
      if (info.time?.created) startTimestamp = info.time.created;
    };

    let lastRefresh = 0;
    let refreshTimer = null;
    const refreshSession = async (id, force = false) => {
      if (!id) return;
      const now = Date.now();
      const since = now - lastRefresh;
      if (!force && since < SESSION_REFRESH_INTERVAL) {
        if (!refreshTimer) {
          refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refreshSession(sessionID, true);
          }, SESSION_REFRESH_INTERVAL - since);
        }
        return;
      }
      lastRefresh = now;
      try {
        const info = unwrap(await ctx.session.get({ sessionID: id }));
        applySession(info);
        schedulePush();
      } catch {
        // session may be gone or not ready; keep last snapshot
      }
    };

    // Build the Discord activity object from current state.
    const buildActivity = () => {
      const statusText = STATUS_TEXT[status] || "Idle";

      // Line 1: model
      const details = snap.model ? `Using ${snap.model}` : "Using OpenCode";

      // Line 2: status + project + tokens, whichever are enabled/available
      const bits = [statusText];
      if (config.showProject && snap.project) bits.push(snap.project);
      if (config.showTokens && status !== "idle" && snap.ctxTokens > 0) {
        bits.push(`${formatTokens(snap.ctxTokens)} tok`);
      }
      const state = bits.join(" \u00b7 "); // " · "

      // Hover text on the large icon: session title (falls back to project)
      const hover =
        (config.showSession && snap.title) ||
        (config.showProject && snap.project) ||
        "OpenCode - AI Coding Assistant";

      const activity = {
        details: details.slice(0, 128),
        state: state.slice(0, 128),
        assets: {
          large_image: "opencode_rp_large_dark_1024",
          large_text: String(hover).slice(0, 128),
          small_image: "opencode_icon_tight_dark_1024",
          small_text: statusText,
        },
        buttons: [{ label: "Visit OpenCode.ai", url: "https://opencode.ai" }],
      };
      if (status !== "idle" && startTimestamp) {
        activity.timestamps = { start: startTimestamp };
      }
      return activity;
    };

    // --- throttled presence push ---
    let lastSend = 0;
    let pushTimer = null;
    const doSend = () => {
      lastSend = Date.now();
      rpc.send(buildActivity());
    };
    const schedulePush = () => {
      const since = Date.now() - lastSend;
      if (since >= PRESENCE_MIN_INTERVAL) {
        if (pushTimer) {
          clearTimeout(pushTimer);
          pushTimer = null;
        }
        doSend();
      } else if (!pushTimer) {
        pushTimer = setTimeout(() => {
          pushTimer = null;
          doSend();
        }, PRESENCE_MIN_INTERVAL - since);
      }
    };

    // --- startup ---
    log("Initializing Discord Rich Presence...");
    try {
      const def = await ctx.model.default();
      snap.model = formatModelName(def?.modelID || def?.id) || snap.model;
    } catch {
      // ignore
    }
    try {
      const proj = baseName(ctx.location?.project?.directory || ctx.location?.directory);
      if (config.showProject && proj) snap.project = proj;
    } catch {
      // ignore
    }
    await rpc.connect();
    schedulePush();

    // --- event loop ---
    const controller = new AbortController();
    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = event?.type;
          if (!type) continue;
          const d = eventData(event);
          const id = d.sessionID || d.info?.id || d.id;

          switch (type) {
            case "session.created": {
              sessionID = id || sessionID;
              startTimestamp = event?.created || Date.now();
              status = "coding";
              if (config.showProject) {
                const proj = baseName(d.location?.directory);
                if (proj) snap.project = proj;
              }
              if (config.showSession && d.title) snap.title = d.title;
              schedulePush();
              refreshSession(sessionID, true);
              break;
            }
            case "session.updated": {
              if (id) sessionID = id;
              if (d.info) applySession(d.info);
              refreshSession(sessionID);
              schedulePush();
              break;
            }
            case "session.status": {
              if (id) sessionID = id;
              const t = d.status?.type || d.info?.status?.type;
              if (t === "busy") status = "coding";
              else if (t === "idle") status = "waiting";
              schedulePush();
              break;
            }
            case "session.idle": {
              status = "idle";
              refreshSession(sessionID, true);
              schedulePush();
              break;
            }
            case "session.deleted": {
              if (!id || id === sessionID) {
                status = "idle";
                sessionID = undefined;
                snap.title = undefined;
                snap.ctxTokens = 0;
                rpc.send(null);
              }
              break;
            }
            case "message.updated":
            case "message.part.updated": {
              if (id) sessionID = id;
              if (status !== "thinking" && status !== "coding") status = "thinking";
              else status = "thinking";
              refreshSession(sessionID);
              schedulePush();
              break;
            }
            default: {
              if (type.startsWith("message")) {
                if (id) sessionID = id;
                if (status !== "thinking") {
                  status = "thinking";
                  schedulePush();
                }
                refreshSession(sessionID);
              }
              break;
            }
          }
        }
      } catch {
        // stream aborted on unload — expected.
      }
    })();

    return () => {
      controller.abort();
      if (pushTimer) clearTimeout(pushTimer);
      if (refreshTimer) clearTimeout(refreshTimer);
      rpc.disconnect();
    };
  },
};
