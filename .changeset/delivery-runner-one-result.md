---
"@cotal-ai/delivery": patch
---

`startDeliveryService` now builds its `HostedServiceHandle` from a result the delivery runner always returns, with no cast. The runner was typed `void | HostedServiceHandle` and the hosted entry narrowed it with `as HostedServiceHandle`, so a change that sent the hosted path into the CLI's run-until-signalled wait, or returned nothing on it, still typechecked and would have left `startDeliveryService` pending forever or resolving `undefined`. The CLI runner now owns that wait itself. Behaviour is unchanged.
