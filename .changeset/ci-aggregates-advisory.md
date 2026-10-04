---
---

The `ci-ok`, `windows-ok` and `installer-ok` workflow jobs called themselves the required status for `main`, but no ruleset or branch protection requires them: `attribution` is the only required status context, so a red aggregate reports and the merge can still proceed. Their comments and the release page now say they are advisory, and the `ci-ok` comment names the check-run string a ruleset would have to require. This changes repository tooling only; no published package changes.
