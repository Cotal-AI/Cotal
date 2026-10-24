---
"@cotal-ai/runtime": patch
---

`run ps --endpoint <endpoint>` that matches no run now says that no run record lives under that
endpoint and names the endpoints runs are recorded under, with an `ENDPOINT_HAS_NO_RUNS` warning.
It used to print an empty list with no hint.
