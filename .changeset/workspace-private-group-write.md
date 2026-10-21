---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Accept group write on a protected directory, or on a declared service adapter path, when the account database proves the group is the caller's user private group, the Debian and Ubuntu default under umask 0002. On Linux, `getent` must show that the group is the caller's primary group, lists no other member and is no other account's primary group, and `getfacl` must show no extended ACL on the entry. The account list counts only when `/etc/nsswitch.conf` names `files` and `systemd` alone for passwd and group, so a directory source such as LDAP or SSSD refuses. Each read is bounded, and only a proven group is remembered for the life of the process. World write, a foreign owner, a symlink, an extended ACL and an unavailable proof still refuse, and a credential file stays owner-only. A refusal now names the offending path, the reason and a `chmod` remedy, and says what kind of path was checked instead of calling every path a credential reference. The installer sets `umask 022` before it creates anything.
