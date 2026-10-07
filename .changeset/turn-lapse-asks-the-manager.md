---
"@cotal-ai/runtime": patch
"@cotal-ai/core": patch
---

A run's `turn` and `wait(down)` no longer read a seat as down while the manager still runs it. On a loaded host a live seat's presence heartbeats could stall for more than the 30-second lapse window while its process kept working, and the run failed the turn with L4002 (`lapsed`) although the seat went on to finish its step. Once a lapse is confirmed from presence, the run now asks the manager with `inspect`: if the manager still runs that incarnation, the 30 seconds start over; if it does not, or no manager answers, the lapse stands and the turn fails with L4002 as before. A run host's credential now carries the `inspect` request for this.
