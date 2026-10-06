---
"@cotal-ai/auth": patch
---

The manager cluster parser that activation, standing renewal and run-attempt admission share now words its refusals for the document instead of an activation request: "found no canonical manager cluster document", "the manager cluster document carries a malformed command declaration" and "the manager cluster document declares command <name> twice". A standing renewal or run-attempt admission that fails on its registered manager cluster no longer reports an activation that never happened. No other behavior changes.
