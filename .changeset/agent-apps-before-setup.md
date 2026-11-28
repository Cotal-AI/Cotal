---
"cotal-ai": patch
---

Open Agent apps before connecting a computer. The desktop can list, install, and sign in to supported apps without first setting up the background service. When this copy of Cotal owns the service, it refreshes the service after an install and when you choose Check again, so spaces can find the apps. If the app cannot verify ownership, Agent apps is read-only.

Desktop setup can now return `LIFECYCLE_BLOCKED` while an agent app change is in progress. Wait for that change to finish, then try setup again.
