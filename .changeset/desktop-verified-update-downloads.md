---
"cotal-ai": patch
---

The desktop app shares the command line's automatic-update preference and can verify signed update downloads when its build has an updater key. Builds without a key keep their release summary, notification preference and platform installer path. Configured builds check the manifest again when Check now is pressed, while automatic checks stay daily. Release preparation stays in Settings without a main-view error. This change does not install downloaded updates or add automatic rollback.
