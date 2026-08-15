# `mc-e2e-user` — E2E, docs-only — **docs half COMPLETE and PASSED**, one MEDIUM finding (fixed)

Received by DM in two parts, landed verbatim in order. Pin
`66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.

**This seat had no code access by construction and certified that unprompted**, twice. It found a
real documentation defect the entire code-reading panel did not — because the panel could always
answer from the source and this seat could not.

---

## Part 1 — interim

INTERIM E2E REPORT — HEAD 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e. Docs-only assurance: I have not read the diff, design note, changed source/suites, or .meshctl-measurement/. Discovery succeeded from docs/README.md -> MCP tool catalog. docs/mcp-tools.md:29-30 names cotal_disconnect/cotal_connect; 301-325 specifies OFF/return behavior, verification via peer presence, retained durable membership/replay, refusals, and availability only with capabilities:[connection]. docs/agent-files.md:49 and 54-78 says the operator grants capabilities:[connection] in .cotal/agents/<name>.md, tools are absent without it, the disconnected agent is unreachable to all peers, and the grant is absent by default. OBSERVED default-deny: cotal_orientation says 'capabilities: none beyond defaults' and its actual tool list omits both controls. I therefore could not execute disconnect/connect or wrong-state calls in this seat. Please relaunch/respawn this same trial with capabilities:[connection] if you want the live reversible-path test completed. Documentation finding: docs/manifest.md:49-53 presents the manifest capability values but omits connection, so a cotal.yaml operator cannot tell from that reference whether/how to grant it. Planned live checks if enabled: disconnect(cause), external observer/UI confirms offline/cause; cotal_reconnect while deliberately offline must refuse and direct cotal_connect; cotal_connect() restores/replays and observer confirms online; a second connect clearly refuses already-connected.

## Part 2 — final

FINAL DOCS-ONLY E2E REPORT
HEAD: 66bb07d1e75f6f2f4d9959af03ffaaf000e4171e
Integrity: I did not read the diff, design note, changed source files, suites, or anything under .meshctl-measurement/.

COMPLETED
- Yes, docs alone say an agent can deliberately disconnect itself and reconnect itself. Discovery path: docs/README.md:93-97 calls mcp-tools.md the catalog of every cotal_* tool; docs/mcp-tools.md:29-30 names cotal_disconnect/cotal_connect; lines 301-325 give arguments, effects, refusal states, replay, and verification through peer presence.
- Human setup is clear in the agent-file path: docs/agent-files.md:49 and 54-78 says put connection in the persona's capabilities, e.g. capabilities: [connection], before launching that persona. It is absent by default; without it the connector omits both tools.
- Observed default-deny matches those docs: cotal_orientation reported no capabilities beyond defaults and did not list cotal_disconnect or cotal_connect.
- Intended user trial once granted: call cotal_disconnect({cause}), expect a confirmed departure/offline state visible to an external observer/UI; call cotal_reconnect while deliberately offline, expect an actionable refusal directing me to cotal_connect; call zero-arg cotal_connect, expect online presence and durable replay; call cotal_connect again, expect a specific already-connected refusal.

FINDING (MEDIUM)
- docs/manifest.md:49-53 is the 'every field' reference and gives an exhaustive-looking capabilities list, but omits connection. A human defining the team in cotal.yaml cannot determine from that page whether connection is accepted or how to grant it. The agent-file reference is clear, so this blocks the manifest path rather than the entire feature.

COULD NOT COMPLETE
- Live disconnect, reconnect, replay, observer verification, and wrong-state refusals. This trial persona was launched without capabilities:[connection], so the controls were not callable. That absence is expected policy behavior, not itself a defect. I requested a capability-enabled relaunch.

COULD NOT DETERMINE
- Whether runtime behavior matches the documented transition/refusal text.
- Whether cotal.yaml actually accepts connection despite the manifest reference omitting it.
- Whether editing capabilities on an already-running persona requires relaunch; the docs explain launch-time files/tool gating but do not state the update procedure explicitly.

DOC QUALITY
- Apart from the manifest omission, the MCP and agent-file pages are unusually clear about reachability risk, difference from cotal_reconnect/channel leave, retained membership, and actionable failure conditions. The feature is discoverable from docs alone.

---

## Lane response (NOT part of the verdict)

### ⚠️ DOWNGRADE — "observed default-deny" is **COULD NOT DISTINGUISH**, not a confirmation

**The seat's third COMPLETED bullet — "Observed default-deny matches those docs: `cotal_orientation`
reported no capabilities beyond defaults and did not list `cotal_disconnect` or `cotal_connect`" —
was banked by me AND by fm-orchestrator as evidence that the gate works. It is not, and it cannot
be.** The downgrade is recorded here rather than by editing the verdict, because the seat reported
exactly what it saw; the error is in what we concluded from it.

**The three-arm build measurement (`FINDING-e2e-blocked-by-skew.md`) later showed the INSTALLED
build's `dist/tool-specs.js` contains ZERO occurrences of either verb.** So the tools were absent
because **the build has no verbs**, not because a gate refused them. **An empty tool list and a
working gate produce the same output**, and no observation available to this seat separates them.
Worse in the same period: per mc-rev-authority, the gate in open mode **would not have refused them
anyway** — so the one reading we drew is the one reading the code could not have supported.

**This is the absence-versus-blind-instrument shape, and it arrived as a PASS rather than as a
zero**, which is why it went past two readers. A cell that reports "the thing is not there" is
evidence only once you have shown the instrument can see the thing when it IS there — which is
precisely the inverse control G6 now supplies at the code level, and which no seat on this mesh can
supply at the live level until the build carries the verbs.

**What survives:** the gate is measured at `G5`/`G6` against source, both arms differing. **What does
NOT survive: any claim that a live seat observed default-deny working.** The live half stays
BLOCKED, and this bullet is no longer counted toward it.

**The MEDIUM finding is UPHELD and FIXED** (`docs/manifest.md` now names `connection` in the
capability reference, pointing at `agent-files.md` for why it is enforced differently). **Its
severity call was right: it blocks the manifest path, not the feature.**

**Why this seat's result is worth more than its size.** Every other seat could answer a docs question
by reading the source. **This one could not, and that is exactly why it was the one that noticed the
reference page was incomplete.** A panel that can always fall back to the code cannot see a
documentation hole; it walks through it without registering that it did.

**Its two "could not determine" items are still open and are recorded as such:** whether `cotal.yaml`
actually accepts `connection` (code-read says yes — capabilities pass through with no closed enum —
but that is a read, not a trial), and whether editing capabilities on a running persona needs a
relaunch, which the docs never state.
