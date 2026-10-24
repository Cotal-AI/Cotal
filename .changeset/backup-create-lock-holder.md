---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A `backup create` that loses to another operation now says what holds the root. One that finds the
maintenance lock held names the operation, such as another `backup create` or a restore, its process
and since when it has held the lock, and asks to wait for it. One that runs during a restore names
that restore attempt and its process and asks to wait, where it used to suggest rolling the restore
back. These refusals name no attempt of their own, because they journaled none. A refusal that names
a running restore or backup process now also says when it started.
