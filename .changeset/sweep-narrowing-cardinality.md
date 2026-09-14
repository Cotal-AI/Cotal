---
---

Refuse a recursive sweep that has been narrowed back to a single named file. A sweep counts as coverage because it never enumerates its subjects, so one `continue` on an equality against a single known path turned it back into a named read while it was still graded as a sweep. The listing witness now asks what cardinality the guard chain between a listing and its read admits, so a sweep pinned to one entry is refused and a sweep filtered by extension, by prefix, or not at all still covers the source it finds.

Refs #1575
