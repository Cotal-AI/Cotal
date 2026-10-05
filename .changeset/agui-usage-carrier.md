---
"@cotal-ai/connector-core": patch
---

AG-UI frame metadata (`CotalMeta`) now declares a `usage` carrier for a run's model usage: input and output token counts, the cached and reasoning parts of those totals, and the cost in US dollars. It rides the event that closes the run (`RUN_FINISHED` or `RUN_ERROR`), and a count the harness does not report is left out rather than written as zero. Before, a connector that read these numbers from its harness had no declared key to publish them under, so it dropped them, and a connector that invented its own key would have disagreed with the next one about the name of the same quantity. No connector fills the carrier yet; each adopts it in its own change.
