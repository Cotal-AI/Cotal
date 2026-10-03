---
"@cotal-ai/connector-hermes": patch
---

Run a managed Hermes seat as a Hermes named profile under its temp root, so its gateway gets a systemd unit name of its own, `hermes-gateway-cotal-<id>`. Hermes used to read the managed temp home as a root and give the seat the bare `hermes-gateway` name of the operator's own gateway: the seat refused to start while the operator's gateway service was active, and every launch tried to rewrite the operator's `hermes-gateway.service` to point at the seat's temp profile.
