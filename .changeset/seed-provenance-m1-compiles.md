---
---

The seed-migration-provenance mutation fixture's first mutation now compiles, so its proof grades the migration-announcement check again. Deleting the announcement call left `announceSeedMigration` and `committedStamp` unused, and `noUnusedLocals` failed the build before the suite ran, so the proof reported WRONG-RED for that mutation. The replacement drops only the call and keeps both names referenced. This changes repository test tooling only, so no published package is bumped.
