/**
 * OpenCode Discord Rich Presence — V2 plugin
 *
 * A dependency-free port of opencode-discord-rpc for the OpenCode V2 plugin API.
 * Speaks Discord's IPC named-pipe protocol directly (no @xhayper/discord-rpc,
 * no npm install, no build step).
 *
 * Env config (same names as the original):
 *   OPENCODE_DISCORD_ENABLED        "false" to disable      (default "true")
 *   OPENCODE_DISCORD_CLIENT_ID      your own Discord app id  (default built-in)
 *   OPENCODE_DISCORD_RETRY_INTERVAL reconnect interval ms    (default 15000)
 *   OPENCODE_DISCORD_MAX_RETRIES    max reconnect attempts   (default 5)
 */

import net from "node:net";
import { randomUUID } from "node:crypto";

// Discord application that owns the opencode presence assets.
const DEFAULT_CLIENT_ID = "1462270555586822206";

// IPC opcodes
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

function readConfig() {
  return {
    clientId: process.env.OPENCODE_DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID,
    enabled: process.env.OPENCODE_DISCORD_ENABLED !== "false",
    retryInterval: parseInt(process.env.OPENCODE_DISCORD_RETRY_INTERVAL || "15000", 10),
    maxRetries: parseInt(process.env.OPENCODE_DISCORD_MAX_RETRIES || "5", 10),
  };
}

// "claude-sonnet-4-20250514" -> "claude-sonnet-4", "gpt-4o-2024-08-06" -> "gpt-4o"
function formatModelName(modelId) {
  if (!modelId) return undefined;
  return String(modelId)
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

const STATUS_TEXT = {
  coding: "Coding...",
  idle: "Idle",
  thinking: "Thinking...",
  waiting: "Waiting for input...",
};

function log(msg, level = "info") {
  // Surfaces in ~/.local/share/opencode/log via stdout capture.
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
    this.pending = null; // last activity payload to (re)send once READY
    this.closedByUs = false;
  }

  pipePath(id) {
    // Windows: \\?\pipe\discord-ipc-N  |  *nix handled below.
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
          // Begin handshake.
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
        if (this.pending) this.sendActivity(this.pending);
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

  buildActivity({ status, modelName, startTimestamp }) {
    const statusText = STATUS_TEXT[status] || "Using OpenCode";
    const activity = {
      details: modelName ? `Using ${modelName}` : "Using OpenCode",
      state: statusText,
      assets: {
        large_image: "opencode_rp_large_dark_1024",
        large_text: "OpenCode - AI Coding Assistant",
        small_image: "opencode_icon_tight_dark_1024",
        small_text: statusText,
      },
      buttons: [{ label: "Visit OpenCode.ai", url: "https://opencode.ai" }],
    };
    if (startTimestamp) activity.timestamps = { start: startTimestamp };
    return activity;
  }

  updatePresence(presence) {
    const activity = this.buildActivity(presence);
    this.pending = presence;
    if (!this.connected || !this.socket) return;
    this.sendActivity(presence);
  }

  sendActivity(presence) {
    if (!this.socket) return;
    const activity = this.buildActivity(presence);
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

  clearPresence() {
    this.pending = null;
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(
        this.encode(OP_FRAME, {
          cmd: "SET_ACTIVITY",
          args: { pid: process.pid, activity: null },
          nonce: randomUUID(),
        })
      );
    } catch {
      // ignore
    }
  }

  disconnect() {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.clearPresence();
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

    let currentStatus = "idle";
    let currentModel = undefined;
    let sessionStart = Date.now();

    const refreshModel = async () => {
      try {
        const def = await ctx.model.default();
        const id = def?.modelID || def?.id || def?.model?.id;
        const name = formatModelName(id);
        if (name && name !== currentModel) currentModel = name;
      } catch {
        // model may be unavailable early in startup; keep last known.
      }
    };

    const push = () => {
      rpc.updatePresence({
        status: currentStatus,
        modelName: currentModel,
        startTimestamp: sessionStart,
      });
    };

    log("Initializing Discord Rich Presence...");
    await refreshModel();
    await rpc.connect();
    push();

    const controller = new AbortController();

    (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = event?.type;
          if (!type) continue;

          switch (type) {
            case "session.created": {
              sessionStart = Date.now();
              currentStatus = "coding";
              await refreshModel();
              push();
              break;
            }
            case "session.status": {
              const t = event?.properties?.status?.type;
              if (t === "busy") currentStatus = "coding";
              else if (t === "idle") currentStatus = "waiting";
              push();
              break;
            }
            case "session.idle": {
              currentStatus = "idle";
              push();
              break;
            }
            case "session.deleted": {
              currentStatus = "idle";
              currentModel = undefined;
              rpc.clearPresence();
              break;
            }
            case "session.updated": {
              await refreshModel();
              push();
              break;
            }
            case "message.updated":
            case "message.part.updated": {
              if (currentStatus !== "thinking" && currentStatus !== "coding") {
                currentStatus = "thinking";
                push();
              } else if (currentStatus !== "thinking") {
                currentStatus = "thinking";
                push();
              }
              break;
            }
            default: {
              // Loose fallbacks for anything model/tool related.
              if (type.startsWith("message")) {
                if (currentStatus !== "thinking") {
                  currentStatus = "thinking";
                  push();
                }
              }
              break;
            }
          }
        }
      } catch {
        // stream aborted on unload — expected.
      }
    })();

    // Cleanup on plugin unload.
    return () => {
      controller.abort();
      rpc.disconnect();
    };
  },
};
