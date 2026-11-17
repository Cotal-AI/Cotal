---
"@cotal-ai/cli": patch
---

Operating-system supervision can now recover a foreground controller stack after its broker dies. The launcher retains the mesh records and exits with failure, while an intentional whole-stack stop still releases it successfully. Newly installed systemd process units restart on failure and acknowledge declared readiness after every native invocation. Existing units keep their recorded bytes until explicitly reinstalled. The supervision guide explains stack ownership and login and boot limits on each platform.
