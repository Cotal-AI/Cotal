---
"cotal-ai": patch
---

`cotal daemon serve` no longer removes a live socket that another process bound at its path after a crash. A filesystem such as ext4 can give that socket the dead daemon's inode number, which the recovery matched alone. `serve` now removes the dead daemon's socket only when a connect to it is refused, and otherwise refuses `CONFLICT` (`ALREADY_RUNNING`) and leaves the socket in place.
