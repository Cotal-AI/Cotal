---
"@cotal-ai/runtime": patch
---

`settleOnce` now drains the fire pump before it returns: the wait's answer is still decided by the race (fact, failure, or cancellation), but the settle does not return until the pump's in-flight `takeFire` has ended, and the pump re-checks `wait.over` after each fire so it stops without starting another. Before (#1460), a settle whose fire was mid-flight returned as soon as its fact was observed, so a completed `driveRun` could resolve while the pump's journal replay under the run's takeover id was still open — the replay consumer appeared after the drive had returned, and the next reader under the same takeover hit `RunJournalReplayRaced` cross-process about a driver that no longer existed. A failed pump still raises through the drain exactly as it did through the race.
