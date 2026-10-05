---
"@cotal-ai/auth": minor
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/workspace": minor
---

`cotal spawn --resume <id> --detach --on <instance>` carries a Claude session held on the operator's host to a manager on another host, as `docs/design/resume-transfer.md` lays out. The CLI finds the transcript with the connector's new `resumeTranscript` locator and writes it into a JetStream Object Store bucket owned by the target instance, in chunks sized to the broker's `max_payload`, as a chain that an interrupted carry continues. The manager's new operator-only `transcript-receive` command stages it, removes the broker object, and issues a one-time `resumeClaim` that `spawn` consumes; a re-run of the same bytes moves none. The seat forks the transcript in a seat-private Claude home that authenticates with an environment credential, and `cotal ps --wide` names the source host, session, digest and carry time. The manager cluster document moves to revision 21. Two one-shot credentials carry it on an authenticated mesh: a `transfer-writer` the CLI mints from the space's signing seed for the one transcript it hashed, or on a user-auth mesh exchanges from the operator's login as the new `transfer-writer` view (scope `admin`), and a `transfer-reader` the target manager mints for its own bucket on each receive or sweep, or that the host issues a remote manager through the new manager-service `transferReader` operation. A carried seat records the digest of the transcript Claude forked, and the manager stops a seat whose record does not match the carried bytes, including one whose launch was uncertain and that joined later. Space deletion lists the transfer buckets and deletes them: `deleteSpace` given the space's trust material mints its own `teardown` naming them, and it now throws naming every stream it could not delete instead of reporting success.
