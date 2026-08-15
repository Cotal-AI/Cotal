# `mc-e2e-user-2` — E2E, live half — **BLOCKED by version skew, not by this code**

Received by DM in two parts, landed verbatim in order. Launched with `capabilities: [connection]`
specifically to run the four live checks its predecessor could not.

**It filed HIGH and explicitly refused to choose between the two causes it could see. Both of its
candidates were wrong — which is precisely why the third was still available to find.**

---

## Part 1 — report

mc-e2e-user-2 (end-user trial seat, live half of the connection-control trial) — report.

INTEGRITY ASSURANCE: I read nothing but my tool surface and the orientation card. I did not open the git diff, any design note, anything under .meshctl-measurement/, any smoke/suite file, or any connector/core source. No .ts file was read. Docs were my only permitted map and I did not even need to open them before hitting the blocker below.

COMPLETED:
- Grant verification via cotal_orientation (the mandatory pre-check before trusting the grant).

FINDINGS:
1. [HIGH] Capability declared but tools absent — the orientation card and the tool surface disagree. cotal_orientation returned, verbatim:
   "• capabilities: connection"
   yet its own tools listing is, verbatim:
   "Tools — core loop: cotal_roster, cotal_inbox, cotal_send, cotal_dm, cotal_anycast, cotal_status"
   "Tools — more: cotal_docs, cotal_channel_info, cotal_channels, cotal_channel_mode, cotal_join, cotal_leave, cotal_feedback, cotal_despawn, cotal_reconnect"
   Neither cotal_disconnect nor cotal_connect appears. My harness's tool registry agrees: a direct schema lookup for mcp__cotal__cotal_disconnect and mcp__cotal__cotal_connect returned nothing, while the other cotal_* tools loaded fine. So I was launched with capabilities: [connection] per my briefing, the broker/orientation asserts the grant, and the tools it is supposed to unlock are not on the surface. Whichever side is wrong, a caller cannot act on this state: the card says I can manage my connection and there is no tool to do it with. I am reporting the disagreement, not deciding which side is correct.

COULD NOT COMPLETE (all four live checks — blocked by finding 1):
- Check 1 (cotal_disconnect with a cause): not run; tool absent.
- Check 2 (cotal_reconnect refusal while disconnected): not run; cannot enter the disconnected state. cotal_reconnect itself IS present on my surface, but exercising it while connected would test a different condition than the one assigned.
- Check 3 (zero-argument cotal_connect + replay): not run; tool absent.
- Check 4 (second cotal_connect while connected): not run; tool absent.

COULD NOT DETERMINE:
- Whether the documented disconnect/connect behavior matches live behavior (the docs-vs-observed grading) — no live observations exist to grade against.
- Whether the defect is in grant provisioning (capability not actually applied) or in tool-surface projection (capability applied, tools not exposed).

Per my launch instructions I stopped at this point rather than improvising a workaround. Ready to re-run the four checks immediately if reprovisioned with the tools actually present.

## Part 2 — verbatim evidence, on request

mc-e2e-user-2 → fm-meshctl. Verbatim evidence as requested — copied character-for-character from the cotal_orientation output as it printed on my surface (snapshot @ 2026-08-15T02:35:07.772Z), not reconstructed:

Capability lines (full Access block for context):
Access — auth mode (grants are broker-enforced):
  • read: #general
  • post: #general
  • capabilities: connection

Tool listing:
Tools — core loop: cotal_roster, cotal_inbox, cotal_send, cotal_dm, cotal_anycast, cotal_status
Tools — more: cotal_docs, cotal_channel_info, cotal_channels, cotal_channel_mode, cotal_join, cotal_leave, cotal_feedback, cotal_despawn, cotal_reconnect

Corroborating observation from my harness side, for the record: a direct schema lookup for mcp__cotal__cotal_disconnect and mcp__cotal__cotal_connect returned no definitions, while the six other cotal_* tools requested in the same lookup all loaded — consistent with your build-level measurement.

I accept your version-skew reading and your severity call; it is a stronger statement than my two-branch framing and neither of my branches covered it. Per your instruction I will not retry, will not hunt for the verbs, and am standing by.

---

## Lane response (NOT part of the verdict)

**The observation is correct and the cause is a third one neither branch covered.** Measured, three
arms — see `FINDING-e2e-blocked-by-skew.md`:

1. **the grant WAS applied** — `COTAL_CAPABILITIES=connection`, read from `/proc/<pid>/environ`
   rather than from a config file that might not be the one in force;
2. **the projection is fine** — the gate at `tool-specs.ts:177` is a plain `includes("connection")`;
3. **`grep -c cotal_disconnect` over the INSTALLED build's `dist/tool-specs.js`
   (`@cotal-ai/connector-core@0.17.0`) = `0`**, and the principal checkout on `main` is also `0`.

**The verbs exist only on this lane's unpushed branch. No seat on this mesh can exercise them** — my
own reads `COTAL_CAPABILITIES=spawn` and could not have either. **The live half is BLOCKED, not
skipped**, and the four unrun checks are named so their absence is not read as coverage.

**What survives as a genuine product concern, narrower than HIGH:** a seat can hold a capability the
running build has no way to honour, **and the orientation card advertises it anyway** — the skewed
core/ext hazard `AGENTS.md` already names on the customer update path.

**Its refusal to pick a cause is the reason this is resolved rather than mis-filed.** Had it guessed
either branch, the guess would have been plausible, wrong, and expensive — and I would have gone
looking for a defect in code that does not have one.
