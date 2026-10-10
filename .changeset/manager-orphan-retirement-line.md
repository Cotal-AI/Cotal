---
"@cotal-ai/manager": patch
---

A spawn rolled back as an orphan on a user-auth manager no longer logs `despawn <name>: retirement confirmed for a prior lifecycle of "<name>"; the current hold is left intact`. That lifecycle was never despawned and has neither a successor nor a hold on its name, so the manager now logs `retire <name>: lifecycle <uid> retired; the name had no hold to clear`. A late answer that arrives while a successor holds the name keeps the prior-lifecycle line, and a despawn that clears its own hold keeps the retirement-completed line.
