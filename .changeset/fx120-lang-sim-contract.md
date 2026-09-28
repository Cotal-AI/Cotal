---
"@cotal-ai/lang": minor
---

The scripted turn no longer asks for a timestamp it discards: `SimScript`'s turn entries drop the unused `at` field, so a script author's previously valid `at` literal now fails to typecheck (#729). The simulator grades a scripted wait's delivered value and a scripted ask's two-minute clock instead of taking them on faith (#724). `EffectHandler`'s docblock and the docs now state the handler failure contract: a `bind` failure is a throw (#735).
