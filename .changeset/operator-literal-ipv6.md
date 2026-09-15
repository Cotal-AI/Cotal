---
---

Repository checks now reject public IPv6 literals alongside the existing IPv4, home path and host token classes. An address is a finding only inside global unicast space, so the special-use table of RFC 6890 and the documentation ranges of RFC 3849 and RFC 9637 stay silent, and a prefix written in network notation is still allowed because it names a range rather than a host. Compressed and expanded spellings of one address classify the same way, an IPv4-mapped address is classified by the IPv4 rules only, and the counted fixture allowlist gains the well-known public resolver addresses already asserted in two smoke files.
