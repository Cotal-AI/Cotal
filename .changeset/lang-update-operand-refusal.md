---
"@cotal-ai/lang": patch
---

The tree-walker's `++` and `--` refuse an operand that is not already a number with L4018, the same sentence the compiled engine's `case "update"` throws, instead of reading it through a bare `Number(...)`: a record no longer decays to NaN and a numeric string no longer silently becomes a number, so `x++`, `x + 1` and `x += 1` agree (#646). The two declared divergences this covered are retired.
