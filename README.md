# Crew

AI teammates that do real work on a computer — yours, or a remote VM — using any model provider.

![Group chat](docs/group-chat.png)

## How it fits together

```
┌─ Desktop app (Electron) ─┐        ┌─ Remote VM ───────────────┐
│  UI ── local runtime     │──HTTP──│  runtime (same single file) │
│        (child process)   │  +SSE  │  bots · workspaces · cron   │
└──────────────────────────┘        └────────────────────────────┘
```

One **runtime** (`dist/crew-runtime.mjs`, a single dependency-free Node file) owns everything a bot
needs: the agent loop, tools, workspaces, memory, routines and the HTTP/SSE API. The desktop app
starts one locally and can connect to any number of remote ones. A bot lives on exactly one runtime;
"local vs. remote" is just which runtime you create it on (or copy it to).

| Feature | What it does |
|---|---|
| Teammates | Named bots with a role, instructions, model, autonomy level and capabilities. Templates included. |
| Own computer | Terminal, workspace files, web fetch, optional headless browser (Playwright). |
| Local or remote | Built-in local runtime; connect remote VMs from Settings; switch in the top-left menu; copy a bot across. |
| Any model | OpenAI-compatible (xAI/Grok, OpenAI, OpenRouter, Ollama, LM Studio, vLLM, gateways) or Anthropic-compatible. Per-bot provider + model. Keys stay on the runtime. |
| Teamwork | Group chats with a lead and `@mention` hand-offs; `ask_teammate` delegation from any chat (visible as its own thread). |
| Routines | Saved prompts run on a cron schedule or on demand; bots can save routines themselves. |
| Memory | Per-bot `MEMORY.md` (written by the bot, editable by you) plus a shared, read-mostly `TEAM.md` per runtime that every bot reads. Only bots marked "Team memory writer" can append to it. |
| Long threads & long tasks | Past a context budget (Settings → Context, default 32k tokens, estimated) older messages fold into a rolling thread summary, and older *steps of a running task* fold into a summary the bot writes itself. If that summary fails, old tool outputs are cleared instead. The full history stays visible in the UI. |
| Prompt caching | Prompts are built to be byte-stable across a run: a two-part system prompt (stable first, memory/summary second), no clock time, a fixed tool order. Anthropic-format providers get explicit `cache_control` breakpoints; OpenAI-compatible providers rely on their automatic prefix caching. Token usage, including cache hits, is shown on each reply. |
| Images | `read_file` on a PNG/JPEG/GIF/WebP, browser screenshots and MCP image results are shown to the model during the run that produced them. Models that reject images get the request retried without them, and are remembered. |
| Claude 5 models | Thinking blocks are kept and replayed exactly as received (the API requires this in tool loops), with `drop_block` so blocks invalidated by Crew's own history edits are dropped rather than failing the request. Opus 5.5's short notes between tool calls show in the chat. Each teammate has an **effort** setting (Opus 5.5 defaults to medium). Requests Claude declines are shown as declined, and on the Claude API are retried on a fallback model (toggle per provider). Beta features a model or gateway rejects are switched off for that model automatically. |
| Isolation | Per bot: **Own container** (Docker or Podman; only that bot's workspace is mounted) or **Host**. New bots default to a container when an engine is running. |
| Connectors | Stdio MCP servers configured per runtime. |
| Controls | Ask-first / Autonomous / Read-only per bot, inline approvals, Stop. |
| Spending limits | Each reply shows its cost. Monthly USD limits for the whole runtime (Settings → Spending), each teammate (profile) and each routine; checked before every model call, so a run stops at most one call past the limit and says why. Claude prices are built in; other models need a price per model on their provider, and are listed as "not counted" until they have one. |

### Container isolation

Each isolated bot gets one long-lived container named `crew-<bot id>` with its workspace at
`/workspace`. Shell commands run there; timeouts and Stop kill the whole process tree inside it.
Settings → Containers sets the image (default `node:22-bookworm`), network access and whether to run
as root. If no engine is running, an isolated bot's commands **fail** rather than fall back to the host.

What the container does *not* cover: file tools, web fetch, the browser tool and MCP servers still run
in the runtime process on the host. File tools are confined to the workspace (symlinks included), but
a bot with "Connectors" enabled can do whatever those MCP servers allow. Containers share the host
kernel — this is strong separation between bots and from your files, not a defence against a
kernel exploit. For that, put the runtime on a dedicated VM.

## Run it

```bash
npm install
npm run build
npm start            # runtime + UI in your browser: open the printed link
npm run desktop      # or the Electron app (npm i -D electron first)
```

## Put a runtime on a VM

Copy `dist/` to the VM (Node 20+), then:

```bash
node crew-runtime.mjs --name build-vm          # binds 127.0.0.1:4780, prints an "Open:" link with the token
ssh -N -L 4781:127.0.0.1:4780 user@vm          # on your machine
```

In the app: **Settings → Connect remote** and paste `http://127.0.0.1:4781/#token=…`.
`deploy/` has a systemd unit and a Dockerfile.

**Exposing it directly.** The runtime refuses plain HTTP on a non-loopback address. Either serve HTTPS
itself, or terminate TLS in front of it:

```bash
node crew-runtime.mjs --host 0.0.0.0 --tls-cert /etc/crew/cert.pem --tls-key /etc/crew/key.pem
node crew-runtime.mjs --host 127.0.0.1 --allow-insecure-http   # only behind a TLS reverse proxy on the same host
```

What protects a runtime:

- **One access token**, accepted only in the `Authorization` header — never in a URL, where it would
  land in logs and browser history. The "Open:" link carries it in the `#fragment`, which browsers
  don't send. Image and file links and the live event stream use 15-minute, read-only **tickets**
  signed per process (a restart invalidates them).
- **Origin allowlist.** Browsers may call the API only from the runtime's own origin, loopback (the
  desktop app), or origins added with `--allow-origin` / `CREW_ALLOWED_ORIGINS`. Others get a 403.
- **Provider API keys** never leave the runtime. Enter `env:VAR_NAME` instead of a key to read it from
  the runtime's environment (a systemd `EnvironmentFile`, a container secret) so it is never written
  to disk. The desktop app encrypts keys in `config.json` with a key held in the OS keychain; on Linux
  this needs a real keyring (libsecret/kwallet), otherwise keys stay in plain text, file mode 0600.

Not covered: the access token itself is stored in plain text in `config.json` (mode 0600), and there
is one token per runtime, with no separate users or roles.

## Tests

```bash
npm test                 # runtime end-to-end against a scripted provider (container tests run when Docker is available)
npm run test:ui          # drives the real UI in Chromium across two runtimes (needs playwright)
npm run test:desktop     # launches the Electron shell
node test/mock-provider.mjs 4999   # a fake provider at http://127.0.0.1:4999/v1 for clicking around
```

## Known limits

- **Host bots are not sandboxed.** A bot set to "Host" runs shell commands as the runtime's OS user.
  Use "Ask first", or prefer a container or VM.
- **Single user.** One access token per runtime; no accounts, roles or audit log.
- **Team memory is per runtime** and not synced between your laptop and a VM.
- **Context size is estimated** (about 4 characters per token, a flat ~1,600 tokens per image), not
  counted. Measured usage is reported in the UI but does not drive compaction.
- **Images are kept only for the run that produced them.** Later turns see a file path and can
  re-open it with `read_file`.
- **Prompt caching with Anthropic uses the default 5-minute TTL.** A reply after a longer pause
  rewrites the cache once. Whether a provider caches at all is up to the provider.
- **Not built:** Slack/Teams presence, joining meetings, learning a routine by watching your screen,
  OAuth-style app connectors (MCP only), mobile app.
- **Untested:** installers (`npm run dist`), the default container image and non-root container mode
  (tests use `debian:bookworm-slim` as root), Podman, the Dockerfile and systemd unit.
