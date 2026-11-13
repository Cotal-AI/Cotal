---
"@cotal-ai/workspace": patch
---

A command that waits while another `cotal` command changes the installation now says so. While `cotal setup`, `ext add`, `ext seed` or an update prepares connectors, every other command waits for it, `cotal status` included, and it used to wait in silence for as long as that took. After one second it prints `waiting for another cotal command (pid <id>) to finish changing this installation` on stderr.
