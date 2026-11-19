---
"@cotal-ai/connector-jcode": patch
---

A Jcode seat now stops its TUI before its server, on a normal stop and when a launch fails. From Jcode 0.99.1 a TUI that loses its server starts a new one on the seat's socket, and that server made the next launch of the same name fail until Jcode's idle timeout ended it. The TUI also starts with Jcode's desktop companion autostart off, so Jcode 1.0 no longer leaves a companion process behind each seat.
