# ccusage Ledger

A personal dashboard that visualizes usage, token counts, and costs of agent CLIs (Claude Code / Codex / OpenCode, etc.).

It reads JSON emitted by [ccusage](https://github.com/ccusage/ccusage) and displays daily / monthly / yearly cost, tokens, and cache hit rate, plus per-model and per-agent breakdowns in charts and tables.

## Screenshot

![ccusage Ledger](assets/image.png)

## Requirements

[Bun](https://bun.sh) is required for development (build / test / typecheck). The `ccusage-ledger` bin starts via `#!/usr/bin/env node`, so the published package does not require Bun to start.

## Getting Started

From the repository:

```sh
bun install
bun run dev
```

From the npm distribution:

```sh
npx ccusage-ledger
# or
bunx ccusage-ledger
```

The browser opens `http://127.0.0.1:3000` on start (local interactive environments only; it does not auto-open in a non-TTY environment).

## What it shows

- **Period granularity**: daily / monthly / yearly
- **Period navigation**: all periods, or select a specific month / year with ◀▶
- **By model**: cost stacking, mix ratio, effective unit price, cost ranking
- **By agent**: share donut (cost / token toggle), efficiency table
- **Detailed table by period × agent**
- **Language**: toggle Japanese / English in the top-right corner (initial language is English; the choice is saved in the browser and restored on the next launch)

## Configuration

| Env var | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | Bind port |
| `CCUSAGE_LEDGER_ALLOW_LAN` | (none) | Set to `1` to start with only a warning for a non-loopback bind |

### About LAN exposure

By default the server binds only to `127.0.0.1`. With a non-loopback bind such as `HOST=0.0.0.0`, anyone on the network can view the dashboard (usage data), and plaintext HTTP can be eavesdropped and tampered with.

- On a TTY, a warning is shown and confirmation is requested at startup
- On a non-TTY, startup is refused unless `CCUSAGE_LEDGER_ALLOW_LAN=1` is set
- For non-loopback connections, `/api/usage` returns 403 (the data body is not served); the decision is based on the connection's source IP, so an SSH tunnel reaching loopback still works

To view from another device, use an **SSH tunnel**. The tunnel itself acts as access control, and the connection source becomes loopback, so `/api/usage` works as well. The SSH tunnel encrypts the network segment, but the connection between the tunnel endpoint and the dashboard on the server still uses plain HTTP end-to-end (the encryption boundary is the SSH connection, not the dashboard itself).

```sh
ssh -L 3000:127.0.0.1:3000 your-server
```

> Authentication is intentionally not implemented. This server assumes single-user local use; the boundary is enforced by limiting who can reach the screen (loopback / SSH tunnel).
>
> A local reverse proxy that forwards to `127.0.0.1:3000` (e.g. nginx `proxy_pass`) makes every proxied connection appear to come from loopback, so `/api/usage` is served to anyone the proxy is reachable from without triggering any LAN-bind warning. Do not put the dashboard behind a LAN-facing reverse proxy unless that is exactly what you want.

## HTML Export

```sh
bun run export
```

Outputs a single HTML file to `dist/ccusage-ledger.html` in the current working directory.

**Caution**: The exported file contains your ccusage usage data. Only export it when sharing with someone you trust. For external distribution, set `X-Frame-Options: DENY` in the server response headers (the exported HTML's CSP is injected via `<meta>`, which browsers ignore for `frame-ancestors`; iframe embedding is only prevented by the JS frame buster). If the output lands inside a git repository other than ccusage-ledger, a warning is printed — the file contains personal data, do not commit or upload it.

## Data

The server runs [ccusage](https://github.com/ccusage/ccusage) (pinned as `ccusage@20.0.19`) directly to fetch the full history and caches it at `~/.cache/ccusage-ledger/usage.json` (based on `XDG_CACHE_HOME` if set). Secrets such as API keys are not passed to the child process.

The child process gets an empty temporary `HOME` and only a small allowlist of non-secret env vars (`PATH`, `TERM`, `TMPDIR`, etc.) plus the agent data-directory env vars (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_DATA_DIR`, `OPENCODE_DATA_DIR`) — never the real `HOME` or API keys — so it cannot discover `~/.ssh`, `~/.aws`, etc. by default. At startup the installed ccusage wrapper is sha256-verified against a pinned value on every platform, and the platform native binary against a per-platform table (platforms without a recorded hash are warned, not verified).

> This guards against accidental access and post-install tampering. The hash constant ships inside the artifact it verifies, so a supply-chain compromise of the pinned release itself (or a same-user attacker) is out of scope for this control.

## Development

```sh
bun run build      # bundle the frontend into dist/bundle.js
bun test           # run tests
bun run typecheck  # type-check
```

## License

MIT
