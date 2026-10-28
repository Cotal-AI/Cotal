---
"@cotal-ai/cli": patch
---

`cotal invoke` and `cotal endpoint invoke` with a `--timeout` you set now name that flag when no instance answers the contract read in time: the `TARGET_UNAVAILABLE` refusal says the deadline may have been too short, and its Next adds a rerun with a longer `--timeout`. A served endpoint whose contract read outran a short `--timeout` used to be reported only as nothing serving it. Without the flag the refusal is unchanged.
