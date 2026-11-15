---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

`cotal update --self` and the daemon's automatic update now work where the package manager's folders are group-writable, as the Homebrew Node's `lib` is and as npm under a umask of 0002 leaves the package, and where Node before 24.22 copied the new version with group-writable folders. 0.164.16 and 0.164.17 refused there with `unprotected execution entry`, and each automatic attempt left a 66 MB folder behind. Those two versions cannot update themselves on such a machine: run the installer again or `npm install -g cotal-ai@latest` once. Their automatic attempts now print that instruction and remove the leftover folders. Staging folders are removed after every update. Connector reconciliation no longer refuses its own staging folder under a umask of 0002 on a machine without `getfacl`.
