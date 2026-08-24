---
"@cotal-ai/connector-jcode": patch
---

A failed jcode turn is now retried with a growing delay and a give-up budget, instead of instantly
and forever. A turn's batch is acked only on success, so a failure left the wake count positive and
the `finally` re-drove the same batch with no pause and no limit, re-paying the full injection to
the provider on every pass. Retries now start at one second, double to a one-minute ceiling, keep at
most one timer in flight, and stop after eight consecutive failures with the batch left un-acked so
it redelivers. A failing seat also reports `waiting` rather than `idle`, because a seat holding an
un-acked batch and pacing a retry is not idle.
