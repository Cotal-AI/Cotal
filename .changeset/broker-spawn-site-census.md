---
"@cotal-ai/cli": minor
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/runtime": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-hermes": minor
---

Enumerate broker spawn sites so an unmigrated suite fails the gate instead of leaking

The reaper claims a leaked `nats-server` by matching the store-dir token in its argv, and its header
states the standing condition: it "is only ever as complete as the migration that mints the token".
#1008 measured what that costs, 108 orphaned brokers on one box in a day, all holding loopback ports
inside the OS ephemeral range that suites draw from. The five suites it named were migrated, and
nothing was left behind that could notice the sixth.

`pnpm smoke:broker-migration` is that missing piece. It names no filenames: it walks `git ls-files`,
finds every call that starts a `nats-server`, and fails when one is not claimable by the reaper or
killable by the teardown helper. A suite added next week is in the population on the commit that
adds it. The census currently reads 319 spawn sites across 297 files, and the gate checks all 315
that are in scope.

The census found 98 unadopted sites, not five. Two conditions each break the chain on their own and
both are now required: the token has to be in a path the broker is STARTED with, since the reaper
reads argv and nothing else, and the handle has to reach `teardownOnSignal`, since the token only
helps once the owner is dead. Three shapes were leaking for reasons a named list would never have
surfaced. A suite minting a tokened store dir but launching with `-c <conf>` put the token somewhere
argv never carries, so it was unclaimable despite looking migrated. Brokers started with neither
`-sd` nor `-c` left no evidence at all; those now pass a tokened `-sd` purely as a marker, which
`nats-server` accepts without JetStream and writes nothing into. And suites that owned one broker
while leaving a sibling unowned read as clean under any file-level check, so ownership is decided per
spawn site.

A deliberate negative control opts out with a `SMOKE_BROKER_UNADOPTED_OK` marker, which is greppable
and per-site rather than a silent exclusion: `reaper.smoke.ts` must be able to start an untokened
broker, since that is the case it exists to detect.

The teardown helper no longer stalls three seconds and then reports a false alarm on every green
run. It waited on `process.kill(pid, 0)`, which keeps succeeding for a child that has been killed but
not yet waited on, so a suite whose own `finally` kills the broker first left a zombie that read as
alive until the deadline elapsed, and the helper then printed `did not exit before path cleanup`
about a process that was already dead. Liveness now distinguishes a zombie from a running process,
and a genuinely running broker is still waited on before its store dir is removed.
