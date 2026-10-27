---
"@cotal-ai/cli": patch
---

`cotal update` no longer reinstalls a first-party operator extension that is already at the running CLI's version. When the extension is recorded at that version with the spec update installs, the extensions prefix lock records it at that version, and every package the lock records is on disk at its recorded version, the extension pass verifies it in the update process, rebinds its shared peers to this CLI's copies, and prints a verified line. Any other extension is still reinstalled in an isolated child, now after a line that says why. On a current machine each extension used to cost a full npm install on every run.
