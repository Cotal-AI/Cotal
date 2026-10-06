---
"@cotal-ai/lang": patch
---

The cotal-lang spec lists the scopes and the traits in which they differ in one table (§7): what a scope settles, its verdict when a migration orphans it, and whether a fork re-enters it when the cut lies inside it or refuses the cut (L5020). The journal entry's `kind` field, the absence rule for a scope's settled value, the L2013 admission, the migrate orphan table and the fork cut rule cite that table or the primitive table instead of listing kinds, so a new scope is one row in each. No behavior changes.
