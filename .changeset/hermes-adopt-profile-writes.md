---
"@cotal-ai/connector-hermes": patch
---

Say what lands in an adopted Hermes profile. `docs/connect-hermes.md` described `COTAL_HERMES_ADOPT_HOME` as leaving the profile as found apart from `plugins/cotal`, but the Hermes gateway records one-time hints under `onboarding.seen` by writing `config.yaml` back whole, which drops comments and can change its layout, and the launcher also writes `cotal-tools.json` there. The page now names both writes and gives the `onboarding.seen` flags to set so the gateway leaves `config.yaml` as written.
