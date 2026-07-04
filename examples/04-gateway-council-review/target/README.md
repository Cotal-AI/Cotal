# agentgw: a demo agent gateway (review target)

`agentgw` is a small LLM gateway for a coding-agent CLI: it holds the provider API keys server-side, issues CLI auth tokens, rate-limits, and serves an encrypted logic bundle so the client never sees raw keys. The client is a thin pipe; the gateway is the trusted broker.

## Status: purpose-built review target, NOT production code

This gateway was written from scratch for a Cotal review demo. It is deliberately realistic and deliberately flawed: it carries the kinds of security and integrity mistakes a real agent gateway makes, so a review mesh has something real to catch. Do not deploy it.

Its shape is modeled on the gateway inside **glock**, an AI coding agent by **smundhra**, used as a design reference with the author's permission. None of glock's source is copied here; every file is original and owned by the Cotal authors. glock itself is not affiliated with or endorsing this demo.

## Design (as advertised)

- **Zero keys on the client.** Provider keys live only in the gateway env or the per-user key store.
- **Fine-grained permissions.** Dangerous agent actions require explicit operator approval; the runner enforces a permission gate before any shell or write tool runs.
- **Encrypted bundle.** Proprietary agent logic is delivered AES-256-GCM encrypted and decrypted only in memory, never written to disk.
- **Per-user rate limits.** 100 requests/min per user, sliding window, Redis-backed.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness. |
| `POST /auth/token` | Device-flow-ish: issue a 30-day CLI bearer token. |
| `POST /llm` | Proxy an LLM completion. Auth + rate-limited. Uses the caller's BYO key if stored. |
| `GET /bundle` | Serve the encrypted logic bundle for the authenticated user. |

## Run

```bash
./run.sh
bun run server.ts
```

## Files

- `server.ts`: routes and wiring
- `auth.ts`: token issue/validate + on-disk token store
- `keys.ts` + `keys.sql`: per-user BYO provider keys
- `ratelimit.ts`: sliding-window limiter
- `bundle.ts`: encrypted bundle delivery
- `run.sh`: dev runner
