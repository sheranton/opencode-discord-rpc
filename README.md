# opencode-discord-rpc

Discord Rich Presence for [OpenCode](https://opencode.ai) **V2** — show your AI
coding activity in Discord.

- Shows the model you're using (e.g. `claude-sonnet-4`, `gpt-4o`)
- Live activity status — **Coding** / **Thinking** / **Waiting for input** / **Idle**
- Session elapsed timer
- "Visit OpenCode.ai" button
- Auto-reconnects if Discord restarts
- **Zero dependencies, zero build step** — talks to Discord over its local IPC
  pipe directly, so there's nothing to `npm install` and nothing to compile

> **Built for OpenCode V2.** The V2 plugin API is a breaking change from V1. If
> you're on a V1 plugin you'll see `PluginModule.LoadError: Plugin must export a
> default definition with an id and an effect or setup function` on launch —
> that's the symptom this plugin exists to fix. This is a native V2
> `{ id, setup }` plugin.

---

## Requirements

- **OpenCode v2.0+**
- **Discord desktop app** running (the web client does not expose the local RPC pipe)
- Node 18+ / Bun (bundled with OpenCode)

---

## Installation

Pick one of the two methods below. Both end with OpenCode loading a native V2
plugin.

### Method A — Global (recommended, applies to every project)

Clone into your OpenCode config directory:

```sh
# Windows (PowerShell)
git clone https://github.com/sheranton/opencode-discord-rpc "$env:USERPROFILE\.config\opencode\plugins\discord-rpc"

# macOS / Linux
git clone https://github.com/sheranton/opencode-discord-rpc ~/.config/opencode/plugins/discord-rpc
```

Then reference it in your **global** config at
`~/.config/opencode/opencode.json(c)` (on Windows:
`%USERPROFILE%\.config\opencode\opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/<you>/.config/opencode/plugins/discord-rpc"
  ]
}
```

> On macOS/Linux use the absolute path, e.g.
> `"/home/<you>/.config/opencode/plugins/discord-rpc"`.
> Note the key is **`plugins`** (plural) in V2 — the old V1 `"plugin"` key is
> deprecated.

### Method B — Per project (auto-loaded, no config entry)

Any plugin dropped into a project's `.opencode/plugins/` directory is loaded
automatically — no `plugins` entry needed:

```sh
git clone https://github.com/sheranton/opencode-discord-rpc .opencode/plugins/discord-rpc
```

That's it. **Fully quit and relaunch OpenCode** (not just reload) with Discord
running, and your Rich Presence appears.

---

## Updating

```sh
cd <wherever you cloned it>
git pull
```

Then restart OpenCode.

---

## Configuration

Works out of the box with no configuration. Advanced tuning via environment
variables:

| Variable | Description | Default |
| --- | --- | --- |
| `OPENCODE_DISCORD_ENABLED` | Set to `"false"` to disable | `"true"` |
| `OPENCODE_DISCORD_CLIENT_ID` | Use your own Discord Application ID | built-in |
| `OPENCODE_DISCORD_RETRY_INTERVAL` | Reconnect interval in ms | `15000` |
| `OPENCODE_DISCORD_MAX_RETRIES` | Max reconnection attempts | `5` |

### Using your own Discord Application (optional)

The built-in client ID ships the OpenCode logo assets. To use your own app:

1. Create an app at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Rich Presence → Art Assets**, upload images named
   `opencode_rp_large_dark_1024` (large) and `opencode_icon_tight_dark_1024`
   (small) — or fork this plugin and change the asset keys in `index.js`.
3. Set `OPENCODE_DISCORD_CLIENT_ID` to your Application ID.

---

## How it works

On `setup`, the plugin:

1. Resolves your current model via `ctx.model.default()`.
2. Opens Discord's local IPC pipe (`\\?\pipe\discord-ipc-N` on Windows, or
   `$XDG_RUNTIME_DIR/discord-ipc-N` on *nix), performs the v1 handshake, and
   waits for the `READY` frame.
3. Subscribes to the OpenCode event stream (`ctx.event.subscribe`) and maps
   events to presence state:

   | OpenCode event | Presence |
   | --- | --- |
   | `session.created` | resets timer → **Coding** |
   | `session.status` (`busy` / `idle`) | **Coding** / **Waiting for input** |
   | `message.part.updated`, `message.updated` | **Thinking** |
   | `session.idle` | **Idle** |
   | `session.deleted` | presence cleared |

Presence updates are sent as `SET_ACTIVITY` IPC frames. If Discord isn't running
yet, the plugin retries on the configured interval. On plugin unload it aborts
the event stream and clears the presence.

---

## Troubleshooting

**Presence not showing**

1. Make sure the **Discord desktop app** is running (not just the browser).
2. Discord → **Settings → Activity Privacy** → enable
   *"Display current activity as a status message"*.
3. Fully quit and relaunch OpenCode — the plugin connects on startup.

**Check the OpenCode log**

```
~/.local/share/opencode/log/opencode.log
```

Filter for `discord-rpc`. A healthy start logs `Connected to Discord`. If you
see `Max retry attempts reached`, Discord wasn't up when OpenCode launched —
start Discord, then restart OpenCode.

**Still seeing `PluginModule.LoadError` on launch**

You've still got the old V1 package referenced. Remove any
`"plugin": ["opencode-discord-rpc"]` (singular, npm package) entry from your
config and use the `"plugins"` path entry from the install steps above.

---

## Privacy

This plugin does **not** expose your project name/path, file names, file
contents, or any code or conversation text. It shows only: the model name, your
activity status, and how long the session has been active.

---

## Credits

Dependency-free V2 rewrite of the original
[opencode-discord-rpc](https://github.com/phoenixak/opencode-discord-rpc) concept
by phoenixak, re-implemented against the OpenCode V2 plugin API with a native
Discord IPC client (no third-party RPC library).

## License

MIT — see [LICENSE](LICENSE).
