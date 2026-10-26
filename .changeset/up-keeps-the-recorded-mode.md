---
"@cotal-ai/cli": patch
---

`cotal up` keeps the mode a stopped project last ran in, whatever address the restart names.

`--server` and `--host` name where the broker listens, not whether it authenticates, but the mode was read off the same condition as the address. A project started with `--open`, stopped, and restarted with the address it already ran on came back with auth required and a delivery daemon, and the receipt said nothing about the change. The address still follows the flags, the recorded mode is inherited whenever the start names no mode of its own, and the receipt says the mode it started in. A `--open` or `--user-auth` flag still starts the mode it names.

A `--server nats://` address on a root whose recorded policy serves TLS refuses `USAGE_INVALID` before anything starts, naming `.cotal/broker-policy.json` and the `tls://` address to pass. It used to start a TLS broker, register it under an address no client can dial, and print `TLS: serving <subject> at nats://<address>` over it.
