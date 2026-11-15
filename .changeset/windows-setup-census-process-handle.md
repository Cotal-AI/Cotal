---
"cotal-ai": patch
---

Windows setup no longer refuses an upgrade when an exiting, elevated, or another account's process on the computer has an empty WMI executable path. During setup preparation and interrupted-setup recovery, the census identifies every process matching an installed executable name through its own limited-query kernel handle, ignores processes that have already exited, records another account's unopenable processes in the setup result without blocking the upgrade, and keeps refusing when a live process runs from the installation folder or cannot be identified.
