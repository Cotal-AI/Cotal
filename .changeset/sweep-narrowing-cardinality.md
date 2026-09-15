---
---

Refuse a recursive sweep that has been narrowed back to a single named file. A sweep counts as coverage because it never enumerates its subjects, so one `continue` on an equality against a single known path turned it back into a named read while it was still graded as a sweep. The listing witness now asks what cardinality the guard chain between a listing and its read admits, so a sweep pinned to one entry is refused and a sweep filtered by extension, by prefix, or not at all still covers the source it finds.

Cardinality is a property of the guard rather than of how the guard is spelled, so the classifier normalizes before it decides: parentheses are unwrapped, a prefix `!` flips the sense of the condition instead of being dropped, and a compound guard is taken apart in the one direction each logical operator is sound in — `&&` where the guard holds, `||` where it does not. The side compared against the known string must also be the loop entry itself rather than anything merely mentioning it, so an extension filter written as an equality, such as `String(f).slice(-3) !== ".ts"`, is still a sweep instead of being mistaken for a guard that pins one entry.

Refs #1575
