---
"@cotal-ai/core": patch
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
---

When a seat's declared startup confirmation never appears, the pty runtime now records its own reason, `Cotal startup confirmation failed: prompt "<prompt>" did not appear within 15000ms.`, as the exit's diagnostic. Before, it only painted that line into the seat's screen, so the reap line carried no diagnostic and the launch failure named whatever row the screen ended on, such as a dialog's footer. The launch failure now names the exit diagnostic beside the last output when the two differ, or says the runtime's exit detail was unreadable when its reader throws, and the reap lines label it `diagnostic` because it is no longer only a connector's line. A connector diagnostic over 240 characters is now cut on a code point, so it never carries half a surrogate pair into a launch terminal, and a lone surrogate in a runtime's exit diagnostic or reader error is replaced with U+FFFD, so the failed terminal still commits.
