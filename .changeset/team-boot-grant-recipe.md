---
"@cotal-ai/cli": patch
---

The fresh user-auth `team boot` refusal and its preparation steps in the CLI reference now name `cotal auth grant cli --sub <subject> --full`. The grant they named before left off `--full` and the three ACL lists, so `auth grant` refused it.
