---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Run eligible Linux daemon-hosted PTYs in a separate shared host with a cgroup per seat. A control connection loss does not end seats. Verified death of the owning Manager still ends its seats, and live seats still block update activation.

Processes a hosted Linux PTY seat starts end when the seat exits or stops, even if they detach from its terminal.

Updates wait for hosted launches to settle and name any PTY launch still held at the deadline, with the command to clear it.
