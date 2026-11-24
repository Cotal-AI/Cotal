---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

When `cotal update --self` skips its version check because npm is in offline mode, report that it restored owner write permission on the Cotal connector configuration and that no installed packages were replaced. A retry that changes no permissions prints no notice.
