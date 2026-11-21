---
"@cotal-ai/cli": patch
---

A controller stack's `down` refusal for a shared broker now names the blocking registration and gives a usable next step. When another registration names the stack's exact broker address, the human-readable refusal names each blocking space with its `cotal space show`, its `cotal space forget --plain`, and the down to run again, instead of refusing without identifying the registration. The guard itself is unchanged: the broker is not stopped under the other registration, and nothing is forgotten automatically.
