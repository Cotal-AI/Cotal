---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
---

`cotal spawn --resume <id> --detach --on <instance>` carries a Claude session held on the operator's host to a manager on another host, as `docs/design/resume-transfer.md` lays out. The CLI finds the transcript with the connector's new `resumeTranscript` locator and writes it into a JetStream Object Store bucket owned by the target instance, in chunks sized to the broker's `max_payload`, as a chain that an interrupted carry continues. The manager's new operator-only `transcript-receive` command stages it, removes the broker object, and issues a one-time `resumeClaim` that `spawn` consumes; a re-run of the same bytes moves none. The seat forks the transcript in a seat-private Claude home that authenticates with an environment credential, and `cotal ps --wide` names the source host, session, digest and carry time. The manager cluster document moves to revision 21. Carrying works on an open mesh in this release; an authenticated mesh refuses it until the transfer credentials are minted.
