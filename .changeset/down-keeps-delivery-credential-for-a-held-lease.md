---
"@cotal-ai/cli": patch
---

A legacy bare `cotal down` now reads the delivery lease after it stops the delivery daemon. The daemon gives its lease release two seconds after the signal and then exits anyway, and `down` used to report it stopped and delete its credential in every case. When the release had not landed, the next `cotal up` could not recognise the row as the stopped daemon's, and its new daemon was refused with "a live lease already exists". When the row still names the stopped daemon's credential, or the lease cannot be read, `down` now keeps the credential and prints a line saying so, and the next `up` waits the row out and starts the new daemon.
