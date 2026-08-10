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

`cotal meshes add` therefore gates on the address. Loopback literals (`127.0.0.0/8`, `::1`) are
permitted because nothing leaves the machine. Private-overlay literals (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`) are permitted with a printed warning: they ride an encrypted tunnel only
while that tunnel is actually up, and with it down the range is ordinary carrier-grade NAT that
hostile routing can answer. Everything else is refused with an explanation, including ordinary
private ranges such as `10.x` and `192.168.x` — a café network is private too, and private is not
the same as yours.

**Scope, stated precisely so this is not read as more.** This gates NEW REGISTRATIONS, and only
those. It is not a client-side dial fence: a record written before this change, or a `--server`
override, reaches the broker through the ordinary connect path without consulting it. Calling the
join path "protected" or "made safe" would be wrong. Fencing the credential-bearing dial itself
is separate work.

Hostnames are refused as well, even ones that resolve somewhere permitted, because otherwise
whoever answers the lookup decides which machine receives the credentials. The check runs before
`--force`, which exists for a mesh that is temporarily down and never waives it.
