---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
---

Let a remote participant supervisor spawn and terminally release a HOST-OWNED managed agent (#1972). A registered participant holds no ledger writer, no JetStream provisioner, and no signing seed, so `cotal spawn <actor> -d --on <instanceId>` previously failed in auth preflight and a despawn refused outright.

`@cotal-ai/core` adds the two closed wire operations and their parsers: `manager-managed-agent-enrollment` and `manager-managed-agent-prepare-retirement`. An enrollment carries the SHA-256 digest of the agent's standing actor token and never the token, and carries no lifecycle UID at all; a prepare-retirement's `opId` must be `managedRetirementOpId(target.lifecycleUid)`.

`@cotal-ai/auth` adds `authorizeRemoteManagedAgentEnrollment` and `authorizeRemoteManagedAgentPrepareRetirement`, which require `supervise` at the caller instance's current open manager gate with the host-issued registration proof, plus the loopback door `POST /manager-service-authority/verify-enrollment` (`VERIFY_ENROLLMENT_PATH`) that a host platform calls for the decision while it owns every write. The door derives the caller's scope from the local ledger rather than the request body. `dispatchManagerAuthorityRequest` refuses both kinds with `unimplemented`, since stock owns no such storage, and the provider gains the `enrollRemoteManagedAgent` and `prepareRemoteManagedAgentRetirement` clients.

`@cotal-ai/manager` adds the `remoteAuthority.enrollManagedAgent` hook and takes it in `provisionUserAgent`: the participant generates the actor token, writes it at 0600 before the request, sends only the digest, adopts the HOST's chosen lifecycle UID, and launches `agent-bearer --exchange-url`. `prepareAgentRetirement` now performs the host release instead of throwing.
