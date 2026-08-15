---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/connector-hermes": minor
---

A refusal now reaches the host as a failure, and a partial connect is no longer machine-indistinguishable from a clean one.

Both layers made "success" the value you got by not looking. Core returns a truthy object in every arm, and the tool layer's only failure channel was a boolean that two shipped adapters dropped: a refusal carrying `isError: true` reached OpenCode and resolved as `"⚠ Refused [bind-failed]: …"`, and reached pi and resolved as ordinary content — both host-success states, with no mistake on the caller's part. Claude MCP and Codex preserve the flag, which is what makes this a defect in the result's shape rather than in three adapters.

OpenCode, pi and Hermes now REJECT rather than resolve when a tool result is flagged. That is the only construction where failing to inspect still yields a failure: a host that reads no field at all gets a rejected promise, and the full rendered text travels as the error message. For pi it is conformance rather than a change of policy — its pinned SDK states that `execute` must throw on failure. Every `cotal_*` tool is affected, not only the connection verbs: the flattening was never specific to them.

A connect the broker only partly granted is flagged as a failure and named `partial`. The prose already said PARTIAL while every machine-readable channel said clean success, so `if (!r.isError) ready()` believed it was listening on a channel the broker had refused. Silently wrong is the one direction this surface must not fail in: an over-warned caller investigates and learns the truth, an under-warned one proceeds on a false belief and never does. The new `ToolResult.outcome` (`"ok" | "partial" | "refused"`) is what makes that bearable — a host that judges a partial too loud for its UX can now distinguish it and soften it deliberately, where before it had nothing to soften on.

The shortfall is also measured against the read set the session ASKED for, not against the denials seen on one attempt. The live channel list shrinks when the broker refuses a subscription, so after one denial the endpoint no longer attempted that channel and a later connect reported `denied: []` and a clean `Connected ✓` — the shortfall vanished exactly when it became permanent.

`ConnectionOutcome` gains `ok`, true only when the caller got what it asked for. It is additive: `outcome`, `reason` and `denied` keep their exact meanings.

**It does not close the truthiness trap, and nothing additive can.** `if (await ep.disconnect())` is true for `{ outcome: "refused" }` and stays true, because object truthiness does not consult `valueOf`. The honest claim at the core API is "there is now a correct thing to write", not "the wrong thing stopped working" — the boundary where failing to inspect can be made to yield a refusal is the tool boundary, and that is where the rest of this change lives.

Verified per adapter through the real registered entry point, with a success control through the same path in each case. The OpenCode cells drive the tool map the host is handed. The pi and Hermes cells drive the adapter FUNCTION and say so in their names: neither host is executed here, so they are evidence about the adapter's contract and not about how those hosts present a rejection.
