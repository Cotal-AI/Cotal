---
"cotal-ai": patch
---

On Windows, the background service now starts again within a minute after it exits, also in the Windows session in which it was installed. Its one-minute restart sat on the sign-in trigger, which only begins repeating at the next sign-in, so after a fresh install a service that crashed or was ended stayed down until the person signed out or restarted the computer. The restart now sits on a time trigger, and the sign-in trigger still starts the service at sign-in. Existing installs keep their task until they are installed again; their restart works from the next sign-in.
