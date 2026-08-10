---
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Refuse to register a mesh at an address this build cannot protect.

Registering a mesh is how a machine starts sending agent credentials to a broker it does not run,
and nothing here can require an encrypted connection yet. NATS announces itself in plaintext
before anyone authenticates, so an attacker on the path can pose as the broker and read the
credential straight out of the connect; a `tls://` URL does not prevent it, because it is the
connect options rather than the scheme that make the client insist on TLS.

`cotal meshes add` therefore accepts only addresses whose traffic is already protected: loopback
literals (`127.0.0.0/8`, `::1`), where nothing leaves the machine, and private-overlay literals
(`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), where a WireGuard tunnel authenticates and encrypts the
link between two enrolled machines. Everything else is refused with an explanation, including
ordinary private ranges such as `10.x` and `192.168.x` — a café network is private too, and
private is not the same as yours.

Hostnames are refused as well, even ones that resolve somewhere permitted, because otherwise
whoever answers the lookup decides which machine receives the credentials. The check runs before
`--force`, which exists for a mesh that is temporarily down and never waives it.
