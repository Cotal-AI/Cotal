---
"@cotal-ai/core": patch
---

`setActivity`, `setCondition`, `setAttention`, and `setStatus` when it carries an activity, throw a `TypeError` naming the field before they change local state when `activity`, `attention` or `condition.code` is not a string, or when `condition` is not an object. The reader already drops a presence row with those values. A caller that passed an object keeps its previous row. Nothing is coerced.
