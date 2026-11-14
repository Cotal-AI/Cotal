---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Fix the closing step of `cotal update --self` on a machine with the service installed. Since 0.164.10 that step compared the restarted daemon with the release that started the update instead of the release now installed. On Windows the update ended with exit 3 and "Outcome unconfirmed" although the new release was installed and reconciled. The closing step compares the daemon with the installed release again, as it did up to 0.164.9. Scheduled updates were not affected.
