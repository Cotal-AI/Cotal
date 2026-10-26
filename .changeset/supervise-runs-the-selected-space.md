---
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal supervise` is no longer deprecated. Help lists it under its own Run a manager group, it prints no deprecation warning, and it is not removed in `1.0.0`. Without `--space` it now supervises the space every other command targets: `COTAL_SPACE`, else the space this folder hosts or is registered for, else the one `cotal use` selected. A bare `cotal supervise` with a hosted space selected used to target the default space and refuse that it was neither hosted nor registered. A manager started for a selected space keeps its records in the folder that space is registered at, so a start from any folder is the same manager. The CLI docs gain a section on starting a manager for a hosted space.
