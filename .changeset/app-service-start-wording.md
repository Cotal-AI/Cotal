---
"cotal-ai": patch
---

When the desktop app asks the background service on this computer to start and it does not answer within 15 seconds, the app now reports that the background service has not started, shows any startup refusal from that launch in Details, and offers Check status in the app instead of blaming the network or directing you to a terminal command. While that screen is shown, a stopped-service status check keeps it on screen and a ready answer clears it.
