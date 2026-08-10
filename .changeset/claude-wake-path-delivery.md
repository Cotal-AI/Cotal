---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

Never consume a Claude Code peer's message without delivering it.

An unattended agent could go permanently silent after a direct message. The connector's lifecycle
hook acked the message and marked it handled while it was still only *formatting* the hook reply
that carries it, but that reply has to reach the runtime through the hook relay, which abandons the
exchange after two seconds. When it did not land, the agent's model never saw the message while the
connector had already committed it — and because the message was recorded as handled, its own
JetStream redelivery was acked and discarded on arrival, so nothing could bring it back. The peer
simply stopped answering, and only a human noticed.

A message is now committed only once the reply carrying it is confirmed delivered to a live hook
client (`startControlServer` gains an additive `onReply(event, delivered)`); anything less leaves it
un-acked, so it redelivers and the agent is woken again. The verdict is tracked per hook event
rather than in one slot, because hook frames are separate connections that can overlap and would
otherwise let one frame's outcome commit another frame's messages. This errs toward delivering
twice rather than losing one: a re-surfaced batch is flagged as a possible repeat.

Two further ways the same path could go quiet are closed. Presence updates no longer gate delivery —
a failed presence write used to skip both the message injection and the end-of-turn flush of
anything held while the agent was busy. And a rejected wake notification is now retried with a
bounded backoff, since for an idle agent it is the only thing that can wake it.
