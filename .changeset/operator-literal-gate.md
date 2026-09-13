---
---

Repository checks now reject public and shared IPv4 literals, Linux and macOS home paths, and configured host tokens while preserving counted fixtures. Runtime host names remain scanned without configured-token guards, CIDR network notation remains allowed, and binary skips are reported.
