# Temporary auth correlation probe

This isolated diagnostic candidate adds source-owned pull journals to `CotalEndpoint` and the
hosted auth service. Journals are off until a trusted local composition arms them. Arming twice
does not reset an epoch. No callback, observer promise, wire field or network call is added.
This candidate is not approved for permanent release inclusion.

The fixture arms the primary callout and its existing public client after setup and before
`start()`. The client keeps the original dial result or error reference and genuine stock
authenticator challenges. The server retains request equality fields only after its existing
provenance checks. A request already active when arming makes the epoch unqualified. Earlier
setup traffic cannot become a target request halfway through its processing.

There are eight client dial flights, eight challenges per flight, eight server request records
and sixteen fixed stage labels. Retained strings must be nonempty strings of at most 4096 UTF16
units. Unsupported fields become null without truncation. Counts saturate and overflow remains
sticky. Stored object references do not provide a deep object heap-size bound. Recording is not
hard synchronous preemption.

Private snapshots contain sensitive correlation values and original object references. Never
serialize them. The fixture exports only fixed stage outcomes, bounded ordinals and counts,
equality booleans and qualification labels. It uses challenge and instance equality plus the
original API error reference. Multiple challenges, shared rebuilds, repeated response stages,
unsupported fields and saturation prevent an exact label. A response method returning does not
prove broker acceptance. Missing observations do not prove native credential rejection.

The response method lookup, receiver, argument, ignored return and exception paths remain in
the existing order. The stock authenticator is called once with its original receiver and
argument list. No validation, issuer, expiry, permission, retry or cleanup decision changes.
The original 37, 48 and 53 control sets, effect and receipt assertions, deadlines and custody
oracles remain intact.

## Prepared verification

These commands are proposed for a separately admitted environment. They were not run locally:

```sh
pnpm --filter @cotal-ai/core build
pnpm --filter @cotal-ai/auth build
pnpm smoke:diagnostic-auth-journal
pnpm smoke:diagnostic-auth-journal:live
node scripts/mutation-proof.mjs --config implementations/auth/smoke/mutations/diagnostic-auth-journal.json
```

The unit suite imports the shipped journal implementations and the fixture's actual join. The
live suite uses `CotalEndpoint.start()` and the shipped callout with a real operator-mode broker.
It compares off/on successful authentication and denials, checks genuine challenge equality
and preserves the original thrown reference. Unit checks alone do not prove that a real entry
reaches the journal. Named mutations cover both layers and rebuild after restoration.

Independent source/privacy review and complete author consumption precede publication.
Compilation, baseline, mutation kills and restoration remain unmeasured. Main decides execution
admission and whether the temporary surfaces are removed or a justified minimal API is retained.
A later repair must pass unchanged original acceptance without relying on this probe.
