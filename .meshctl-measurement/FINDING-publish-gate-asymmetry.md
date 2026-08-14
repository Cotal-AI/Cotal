# Finding: the publish side has no client gate, so a widened publish grant is silent

Recorded `Fri Aug 14 09:33:32 PM UTC 2026` (`date -u`, read at the moment of writing) at tip
`32dbab12`. Filed as its own record rather than as a subsection of a mutation report, because it is
a property of the shipped surface and will outlive the round that found it.

## The asymmetry, at the two lines

**Read side — a client gate exists** (`extensions/connector-core/src/tool-specs.ts:516`):

    if (!channelInAllow(config.allowSubscribe, channel))
      return err(`Can't join #${channel}: it's outside your read ACL (allowSubscribe: …).`);

An agent that asks to read outside its ACL is told so, by name, in words it can act on.

**Publish side — no gate at all** (`extensions/connector-core/src/tool-specs.ts:343`):

    async run(agent, _config, { text: msg, channel, mentions }) {
      try {
        const m = await agent.send(msg, channel, mentions);
        return ok(`Sent to #${m.channel}…`);

`config.allowPublish` is never consulted. The call goes straight to `agent.send`.

## Why this is a finding and not a style note

**The broker is the only fence on the publish side.** That is defensible — it is the *right* fence,
and the read-side client gate is explicitly documented as "the friendly client gate" rather than the
boundary. The problem is not the missing gate. It is what the missing gate costs when the broker's
grant is wrong:

> **A widened PUBLISH grant produces NO CLIENT-VISIBLE SYMPTOM AT ALL. The caller is told it
> succeeded, because it did.**

Measured, not reasoned — MX9 (`.meshctl-measurement/MX7-PREDICTION.md`), which widened
`allowPublish` at the mint and ran the suite:

    witnessed: [ '#general:PUB-IN-ACL', '#secret:PUB-OUT-OF-ACL' ]
    outPub:    'Sent to #secret.'

**The subject's own words on a channel it was never admitted to, and the console says `Sent to
#secret.`** Nothing in the agent's own view distinguishes that from correct operation.

Contrast the read side under the same class of defect: a widened read grant delivers messages the
agent can *see arriving*, in an inbox it reads. It is still silent to the agent's ACL logic, but the
evidence is in front of it. **On the publish side there is no evidence anywhere on the client at
all** — the only observer is the broker and whoever is subscribed to the channel the agent should
never have reached.

## What this does and does not argue for

**It does NOT argue for adding a client-side publish gate by symmetry.** A client gate on publish
would be the same "friendly" advisory the read side has, and adding one because the other exists is
symmetry-driven design. It would also create a second place for the ACL to be wrong.

**What it argues is narrower and, I think, harder to dismiss:** the *diagnosability* of the two
sides is different, and only the read side's difference is documented. An operator debugging "why is
this agent posting to #secret" gets nothing from the agent's logs, its tool output, or its config —
all three report success. **The asymmetry should be written down where the grant is defined**, which
is now done at `extensions/connector-core/src/config.ts` (the `capabilities` field's note on why the
open-mode carve-out is not symmetric between `spawn` and `connection`).

## Coverage

`E12` in `extensions/connector-core/smoke/connection-control.smoke.ts` asserts the subject cannot
post outside its publish ACL after a self-reconnect, with `E11` as its positive arm over the same
witness list. Both are driven: MX9 kills `E12`; MX12b kills `E11`.

**Not covered:** whether a widened publish grant is detectable by any *shipped* surface. The suite
detects it with an independent witness the product does not have.
