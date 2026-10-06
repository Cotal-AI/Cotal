---
"@cotal-ai/manager": patch
---

A seat resumed after `cotal down --preserve-state` now takes the same harness and capability checks as a spawned seat. Resume used to look its harness up on PATH again and launched without the binary paths the manager resolved at boot, so a harness installed after boot was refused by spawn and launched by resume, and a harness removed after boot was launched by spawn and refused by resume. Both paths now launch from the boot-resolved paths and refuse a connector whose boot row is unavailable with the recorded reason. The variant, prompt and exact-continuity refusals are one check that both paths share.
