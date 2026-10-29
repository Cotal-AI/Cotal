---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

When a manager's contract does not declare a field the CLI sends, the version-skew refusal now gives
the version that manager reports in its `status` and says which side is older. For an older manager
it names `cotal update --self` on the manager's host and then `cotal manager restart`, or a CLI at the
manager's version. For an older CLI it names `cotal update --self`. An unpinned refusal also names the
manager whose contract refused the field, and a managed spawn's next step no longer says to fix what
the manager reported, because the manager never received the request. Core's undeclared-argument
marker now carries the instance the refused request was bound to.
