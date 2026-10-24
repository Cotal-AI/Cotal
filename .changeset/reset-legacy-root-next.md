---
"@cotal-ai/cli": patch
---

`cotal reset space` and `reset store` for a space with no registration and no stopped controller
stack, as a legacy root's `down` leaves one, now name `cotal clean all --force` (or `clean store
--force`) from that root as the next step, as the reset docs say. They named `cotal space show`,
which cannot find such a space.
