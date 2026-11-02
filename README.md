# Browser Harness

An experimental, local-first **ChatGPT browser → OpenAI-compatible agent gateway**.
Use a dedicated, manually logged-in ChatGPT tab as the reasoning component of an
existing agent harness. The harness executes tools; this gateway never runs shell
commands or accesses your files on the model's behalf.

```text
Your agent harness
  → authenticated HTTP API at 127.0.0.1:4318/v1
  → separately authenticated WebSocket
  → Chrome extension
  → dedicated ChatGPT tab (visible UI only)
```

This is an initial implementation, **not a verified substitute for the official
model API**. Automated tests use simulated browser peers and DOM fixtures, not
paid accounts. One live run on a ChatGPT Plus web account (October 2026 UI) passed a
text completion, the `read_project_readme` two-turn tool loop, client cancellation
(generation stopped, tab disarmed) and re-pairing. ChatGPT changes its markup often;
model identity, availability, and quota accounting remain unverified. Nothing here guarantees unlimited usage,
avoids subscription limits, or exposes the ordinary chat allowance as an official API.

## Current scope

| Feature | Status |
| --- | --- |
| ChatGPT browser text | Live-tested once on a Plus account; markup changes can break it |
| `GET /v1/models`, `POST /v1/chat/completions` | Implemented subset described below |
| Tool calls | Strict JSON emulation; validated names, arguments, IDs and results |
| Streaming | Buffered SSE after final reply validation, not live token streaming |
| Sessions | Fresh browser chat per request; complete supplied history replayed |
| Model selection | Manually choose in ChatGPT; the gateway does not verify the actual model |
| Images, uploads, native image generation, voice | Not implemented; unsupported request shapes rejected |
| Claude, Gemini, DeepSeek, Grok | Not implemented |
| Paid API/Codex fallback | None |

The code is original; no source from the projects discussed during research has
been copied into this repository.

## Prerequisites

- Node.js 20.18+ (Node 22 recommended), npm, Chrome 116+.
- An account permitted to use the ChatGPT website in the manner you intend.
- A dedicated Chrome tab that you will not use for other work while armed.

Review applicable provider terms before connecting an account. This project does
not establish permission to automate a service. It has no CAPTCHA solving, private
provider endpoints, stealth features, account rotation, or limit-bypass mechanism.
Stop if your provider does not permit your intended use.

## Setup

```sh
npm ci
npm run build
```

Generate **two distinct keys** in your terminal. These are local gateway secrets,
not OpenAI credentials. Do not commit them or put them in screenshots.

macOS / Linux:

```sh
export BROWSER_HARNESS_API_KEY="$(openssl rand -hex 32)"
export BROWSER_HARNESS_BRIDGE_TOKEN="$(openssl rand -hex 32)"
npm start
```

Windows PowerShell:

```powershell
$env:BROWSER_HARNESS_API_KEY = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
$env:BROWSER_HARNESS_BRIDGE_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

Windows shortcut: `scripts/windows/setup-and-start.ps1` clones or updates
`%USERPROFILE%\browser-harness`, builds it, starts the gateway, and copies the bridge
token to your clipboard. Unlike the gateway itself, this helper stores both keys in
`%USERPROFILE%\.browser-harness\keys.json` (readable by your user only); delete that file
to rotate them. `scripts/windows/smoke.ps1` runs the smoke test with the stored API key.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup-and-start.ps1
```

The server binds to `127.0.0.1` only. `BROWSER_HARNESS_PORT` optionally changes
port 4318. Keys must each contain at least 32 characters. No keys are generated,
printed, or stored on disk by the gateway itself. Keep the terminal environment
available: separate shells need the same environment variables, not new keys.

1. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**,
   and choose `build/extension` in this repository.
2. Open a dedicated `https://chatgpt.com/` tab and sign in manually. Select the
   desired model in the website. No provider passwords or cookies enter the gateway.
3. Open the extension popup **on that tab**. Enter the gateway port and the value
   of `BROWSER_HARNESS_BRIDGE_TOKEN` from your terminal, then **Pair & arm this tab**.
   The API key is a different secret and must not be pasted into the extension.
4. The popup should report **Armed**. Keep that tab open and avoid interacting with
   it while requests run. Each request clicks New chat; prior chats are not deleted.

Optional hardening: copy the installed extension ID from `chrome://extensions`
and set `BROWSER_HARNESS_EXTENSION_ID` before starting the gateway. This restricts
WebSocket pairing to that extension origin as well as requiring the bridge token.

If a request fails with `tab_not_attached`, the tab was opened before the
extension loaded. A `ui_changed` error names the step that failed (`new_chat`,
`editor`, `insert`, `send`, or `reply`), so you can tell which selector needs updating.

After extension installation or reload, refresh the ChatGPT tab to load the content
script. Restart the gateway after source changes and rebuild/reload the extension
after extension changes.

## Connect an agent harness

For clients supporting a configurable OpenAI Chat Completions endpoint:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:4318/v1` |
| API key | Value of `BROWSER_HARNESS_API_KEY` |
| Model | `chatgpt-browser` |

This does **not** claim compatibility with every OpenAI client. Responses API,
Anthropic protocols, native reasoning fields, token counting, and advanced sampling
options are not implemented. Unsupported fields return HTTP 400 rather than being
silently ignored. Disable automatic model/provider fallback in your harness.

Example (macOS / Linux; keep the gateway running in another terminal with the same keys):

```sh
curl http://127.0.0.1:4318/v1/chat/completions \
  -H "Authorization: Bearer $BROWSER_HARNESS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-browser","messages":[{"role":"user","content":"Explain recursion briefly."}]}'
```

### A safe first agent task

```sh
npm run smoke
```

The included minimal harness asks ChatGPT to call `read_project_readme`, executes
only that fixed, read-only operation locally, sends its result back, then requests
a summary. It does not execute model-supplied file paths or shell commands. This
proves the intended two-turn tool loop when run against your paired browser; it is
not a general-purpose autonomous coding agent.

## API contract

Supported request fields: `model`, `messages`, `stream`, `tools`, `tool_choice`
(`auto`, `none`, `required`), and `parallel_tool_calls`. Messages accept roles
`system`, `developer`, `user`, `assistant`, and `tool`, with string content
(or null for assistant tool calls). Assistant `tool_calls` retain function names,
JSON argument strings and unique IDs; tool results must reference a pending ID.
All pending calls must be resolved before continuing. Tool choice defaults to auto.

Tools use OpenAI's `type: "function"` shape. Parameters must be JSON Schema object
schemas, at most 16KB each; references, async schemas and IDs are rejected. Names
must be unique. Requests are limited to 32 tools, 200 messages, 512KB JSON and a
rendered prompt of 200,000 characters. Unsupported schema keywords fail validation.
Format annotations (such as `format: "email"`) are unsupported and rejected too.

The browser receives a canonical JSON transcript with the full tool history.
Unlike a native API, these role labels are ordinary text in a website user message,
**not privileged system messages**. The model must answer with one complete JSON
envelope containing a per-request nonce and either final text or tool requests.
Prose, fences, examples, extra fields, unknown tools and invalid arguments are
rejected. The gateway never searches arbitrary prose for executable tool calls.
This reduces accidental interpretation; it does not eliminate prompt injection.

At most one request runs at a time, with four waiting slots. The 180-second
deadline includes queue time. On active cancellation, timeout, disconnect or a
browser adapter error, the lease is closed and queued work fails: inspect the tab
and explicitly pair again. No uncertain action is automatically retried. Invalid
model envelopes return 502 without tool execution or a repair retry.

`stream: true` returns standard SSE completion chunks and `[DONE]`, **buffered
until the final reply passes validation**. Errors return JSON before streaming
headers are sent. Clients must tolerate the browser generation delay. Usage/token
counts are omitted because the browser does not expose trustworthy API accounting.

`GET /health` exposes only `{ "ok": true }`. `GET /v1/status` requires the API key
and reports pairing state and capabilities. REST rejects all browser `Origin`
headers, accepts only the exact loopback Host header, and enables no CORS access.

## Security and limitations

- Anyone with your gateway API key can submit prompts and consume your allowance.
  Anyone controlling the armed tab can influence responses. Use only trusted local
  clients; this is not a multi-user or remotely accessible service.
- The bridge token exists in extension service-worker memory only, not content
  scripts or persistent storage. Only the non-secret port is saved in session storage.
  Service-worker/browser restarts may require re-pairing. Heartbeats keep an active
  connection alive on supported Chrome versions.
- The extension has access only to ChatGPT pages, local WebSocket connections,
  session storage, and the active tab. It never requests cookie access or `<all_urls>`.
- Browser limits, challenge pages, login expiry, UI changes, and account settings
  can interrupt requests. Detection is best effort. There is no guarantee of model
  identity or that the provider will account for usage as expected.
- Native website actions cannot be fully controlled by the prompt. Start with
  provider connectors disabled and non-sensitive tasks. Do not send credentials.
- Local malicious software, compromised browser extensions, arbitrary tool schemas
  from untrusted clients, and a compromised provider page are outside this prototype's
  security boundary. Keep actual execution sandboxed and require approval for
  destructive operations, network access, credentials, purchases and publication.
- Fresh chats duplicate transcript context and accumulate website history. Persistent
  sessions, compaction, real token streaming and multimodal artifacts are future work.

## Development and verification

```sh
npm run lint
npm run typecheck
npm test
```

Tests exercise the HTTP gateway against simulated extension peers, complete tool
round trips, strict protocol validation, queue limits, cancellation, deadlines,
pairing failures, host/origin restrictions and ChatGPT-like DOM fixtures. They
require no account, keys, provider requests, or browser launch. They do not establish
live website compatibility. CI runs these checks and an audit of runtime dependencies.

The full development-dependency audit currently flags the
[minimatch amplification advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
through ESLint and TypeScript-ESLint. Runtime dependencies pass `npm audit --omit=dev`.
Do not pass untrusted glob patterns to the development tools. There is no compatible
patched legacy minimatch release in their pinned dependency ranges; do not run
`npm audit fix --force` (its proposed ESLint downgrade is not an appropriate fix).

Manual acceptance before relying on the gateway:

1. Confirm the selected ChatGPT model and record account usage indicators.
2. Pair a dedicated tab and run `npm run smoke` repeatedly.
3. Confirm the two requests used fresh chats and retained tool history correctly.
4. Cancel a request; confirm pairing is revoked and no automatic retry occurs.
5. Check account usage indicators again. Do not infer billing separation from login alone.

Browser-specific selectors live in `extension/adapter.ts`. Keep adapter updates
separate from the protocol and execution boundary; do not add private endpoints
or security/usage-limit bypasses to work around a broken UI.
