# probes/ — run by hand, wired into nothing

These are not tests. Nothing here runs in `pnpm smoke`, `pnpm smoke:ci`, or any gate, and nothing
imports them. They need an external binary on PATH, so they are kept as apparatus you run
deliberately and read the output of.

## real-host-refusal.mjs — does a refusal reach the real OpenCode host as a failure?

The connector's adapter turns a flagged `ToolResult` into a thrown `execute`. Whether OpenCode then
records a **failed** tool call, or swallows the throw into an ordinary result, is a fact about the
host — no adapter-level test can see it.

**Real:** the `opencode` binary under `serve`, launched through the connector's own `dist/serve.js`
shim in its shipped `COTAL_SERVE_HEADLESS=1` mode (the production non-terminal entry point — the
probe does not hand-roll a launcher); the real `dist/plugin.bundle.js` the connector injects; a real
`nats-server`; a real model turn that really calls the tool.

**Stand-in:** the model provider only — `offline-provider.mjs`, a loopback OpenAI-compatible server
with a fixed turn script. No external traffic, no sampling. It proves how the **host** handles a
thrown `execute`; it proves nothing about how any real model behaves after seeing an errored tool
call.

### Running it

Needs `opencode` and `nats-server` on PATH, and the connector built
(`pnpm --filter @cotal-ai/connector-opencode build`).

```sh
node extensions/connector-opencode/probes/real-host-refusal.mjs                       # FIXED arm
node extensions/connector-opencode/probes/prefix-bundle.mjs /tmp/prefix.bundle.js     # build the mutant
node extensions/connector-opencode/probes/real-host-refusal.mjs --bundle /tmp/prefix.bundle.js
```

Everything it creates — scratch `HOME`, broker store, workspace root — lives in a temp dir it
removes on exit. It deletes inherited `COTAL_*` from its own env, asserts its broker URL is
loopback and not the live host before dialling, and signals process groups on teardown.

### If it dies badly: what to look for, and how to confirm what is yours

The probe starts a **real** `opencode serve` and a **real** `nats-server`, both detached, so they
outlive the runner unless something tears them down. Teardown runs from the `finally` **and** from
handlers on `SIGINT`/`SIGTERM`/`SIGHUP`, and the teardown is idempotent, so both paths firing is
fine. A `SIGKILL` still leaks — nothing can catch it.

**Confirm ownership from the process environment, never from a name or a `pgrep -f` pattern.** Name
patterns match your own shell, your editor, and any unrelated `opencode` you or someone else is
using; `pgrep -f` also matches the checker itself. This run owns a process only if it references
this run's own scratch:

```sh
ls -d /tmp/cotal-ochost-*                    # a surviving scratch dir names the run
for p in /proc/[0-9]*; do                    # which processes reference it
  tr '\0' '\n' < $p/environ 2>/dev/null | grep -q /tmp/cotal-ochost- && \
    echo "$(basename $p) $(cat $p/comm)"
done
```

Kill only those pids, then remove the directory. Never redirect a full process listing anywhere
that gets committed or posted — select fields (`ps -eo pid=,comm=`) and leave `args` out of it.

### What the two arms proved

Same script, same turn, same session; only the bundle differs.

| arm | call 1 (disconnect, succeeds) | call 2 (refusal) | |
| --- | --- | --- | --- |
| FIXED | `completed` | **`error`**, `state.error` = ``Refused [not-connected]: this endpoint is already off the mesh - nothing to disconnect`` | 5/5 |
| PRE-FIX | `completed` (identical) | **`completed`**, output ``⚠ Refused [not-connected]: …`` — a host success | 3/5, red on exactly OH1 and OH2 |

Broker witness in both arms: `connections` 1 before the turn → 0 after, cumulative
`total_connections` 1 — the disconnect was real at the broker, and nothing silently re-dialled.

The **control is green in both arms**, which is what makes the difference attributable to the
adapter rather than to the host. The pre-fix arm passing would mean the probe had stopped measuring
the adapter.

`OH2` asserts on `state.error`, not on a stringified `state`: in the pre-fix arm the same text sits
in `state.output`, so a cell that greps the whole object passes in both arms and discriminates
nothing.

## prefix-bundle.mjs — the pre-fix mutant, built fail-closed

Copies the shipped bundle with `resolveOrThrow` reverted to its old flattening. It refuses to write
unless the anchor matches **exactly once**: a mutation that silently changed nothing, or changed a
line it did not name, is worse than no mutation. It never touches the tree.
