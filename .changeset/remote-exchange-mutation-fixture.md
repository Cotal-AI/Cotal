---
"@cotal-ai/auth": patch
---

The public exchange suite (`smoke:remote-exchange:live`) now has a mutation fixture, `implementations/auth/smoke/mutations/remote-exchange.json`, for its security cells: the capless loopback 401 that pairs the public 200, the per-peer refusal throttle, a valid credential still minting from a throttled key while a refusal's reason is withheld, and the one sentence an unknown agent and a wrong secret share. Its per-peer isolation and budget-separation cells now probe with a refused exchange and require its own 401 sentence. They probed with a valid credential, which mints even from a full bucket, so they stayed green with every peer sharing one bucket and with public refusals charging the loopback budget. Service behaviour is unchanged.
