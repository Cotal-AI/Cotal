---
"@cotal-ai/cli": patch
---

Foreground controller stacks now report broker death to their operating-system supervisor, and new systemd service units restart on failure.

A confirmed broker exit returns code 5 without discarding the mesh record or restarting inside Cotal. A later native invocation repairs the recorded stack. Generated direct-process units retry after five seconds and can replace their exact dead startup incarnation without a readiness caller. Unresolved native actions and stops remain blocked. Supervision documentation explains login and reboot limits, platform support, and the absence of a default seat memory cap.
