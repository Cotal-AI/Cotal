---
---

The manager harness-boot mutation that drops the boot-resolved binary map now anchors on the spawn launch's `resolvedBinaries: harness.binaries`, so it is proved against `managed spawn uses the exact path resolved at boot` instead of grading ERROR.
