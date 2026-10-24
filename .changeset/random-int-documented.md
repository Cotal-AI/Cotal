---
"@cotal-ai/connector-core": patch
"cotal-ai": patch
---

The workflows guide now says what `random()`, `randomInt(n)` and `pick(xs)` return, and that a
builtin ignores arguments past the ones it takes, so `randomInt(1, 1000)` is `randomInt(1)` and
always 0. `1 + randomInt(1000)` draws from 1 to 1000.
