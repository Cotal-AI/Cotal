An older `cotal` refuses a seed store written by a newer version. When it can verify a sufficient
`cotal` executable on PATH or at the installer's `~/.local/bin/cotal` location, the refusal names
that absolute path so a reduced service PATH does not select the older binary again. Otherwise it
keeps the generic newer-version instruction. `--reset` remains the explicit way to rebuild the store
for the running older version.

The default connector for a bare `cotal spawn` (no `--agent`) is the persona's `agent:` pin if it
has one, else `claude`; set `COTAL_DEFAULT_AGENT` (e.g. `opencode`) to change the fallback. It is
a default, so a persona that pins its harness still wins over it. An `--agent` naming a removed
connector fails loud with the exact

`cotal ext add` to restore it. Set `COTAL_SKIP_CONNECTOR_SEED=1` to turn off the automatic first-run
seed/refresh entirely (for a controlled or offline setup that manages connectors by hand); `cotal ext
seed` still runs on request.

## completion

```bash
cotal completion <bash|zsh|fish|powershell>   # print a stub to eval / source
cotal completion install [shell]              # install it persistently
```

Prints or installs shell completion. Completion candidates come from each command's declared flags
and, where useful, live mesh state (spaces, personas, managed agents) resolved offline.

## feedback

```bash
cotal feedback "<summary>" [--type <t>] [--email <e>] [--details <text>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--type <t>` | none | `bug` \| `idea` \| `friction` \| `praise` \| `other` |
| `--details <text>` | none | Longer free-form details |
| `--severity <s>` | none | `low` \| `medium` \| `high` |
| `--area <a>` | none | The part of Cotal this concerns |
| `--email <e>` | git email | Contact email (required on the keyless public path) |
| `--name <n>` | none | Your name (optional) |
| `--url <url>` | keyed / public intake | Intake URL override |
| `--key <k>` | `COTAL_FEEDBACK_KEY` | Feedback key |

Sends feedback to the Cotal developers. With a key (`--key` / `COTAL_FEEDBACK_KEY`) it routes to the
keyed beta intake; without one it goes to the public `cotal.ai` intake and requires a contact email
(`--email` / `COTAL_FEEDBACK_EMAIL`, else your git email). Run a self-hosted intake with
[`feedback-intake`](#server-daemons).

## Server daemons

Two long-lived infra roles ship with the CLI. They are not part of everyday operation; the delivery
daemon comes up automatically with `cotal up --detach` in auth mode.

```bash
cotal deliver --space <s> [--server <url>] [--creds <file>]
cotal auth-service --space <s> --server <url> [--port <n>] [--exchange-public-port <n>] [--exchange-public-url <https://…>] [--exchange-trusted-proxy]
cotal feedback-intake --keys <keys.json> [--port <n>] [--creds <file>]
```

`auth-service` runs a user-auth space's identity plane: the NATS auth callout, the
capability-gated local exchange and JWKS, and, when `--exchange-public-port` is set, the closed public
exchange/discovery face forwarded by an HTTPS reverse proxy. `--exchange-public-url` is the proxy URL
advertised to clients; `--exchange-trusted-proxy` opts into last-hop `X-Forwarded-For` attribution.
`cotal up --user-auth` starts and supervises the service for you, so you run it directly only to
recover one by hand.

`deliver` runs the server-side Plane-3 delivery daemon: the durable backstop and membership/ACL
authority. It is auth-mode-only and single-instance (`--shard`/`--shards` accept only `N=1`);
`--dev-mint` mints a scoped cred from the local signer for standalone dev. See the
[delivery daemon](delivery-daemon.md). `feedback-intake` runs a self-hosted feedback server
(requires `--keys` and a scoped `--creds`), announcing submissions into a space channel; flags
include `--host`/`--port`, `--store`, `--space`/`--channel`, `--max-bytes`, and `--rate-limit`.

## Plumbing

`cotal __complete <words…>` is the internal entry the shell-completion stubs call to emit candidates
for the current command line; you never run it directly. `cotal agent-bearer` is machine-facing
plumbing on user-auth meshes: spawned agents exec it to print a fresh short-lived bearer from their
spawn-time secret; you never run it directly either. Its local arm uses `--dir` to discover the
capability-gated loopback service. A remotely enrolled, already-granted agent instead receives
`--exchange-url <https://base>` in its launch argv: that arm sends `{owner, actor, actorToken}` to the
pinned public exchange with no local capability, follows no redirects, and refuses every non-HTTPS
URL because the actor token is the credential in the request body. (`cotal start` is a removed tombstone: it
errors and points you to `cotal spawn --detach`.)
