---
"@cotal-ai/manager": patch
---

A manager whose SecretStore differs from the delivery daemon's no longer holds the space's daemon-credential renewal lease. Its renewal pass already released the lease, but the lease heartbeat took it back a few seconds later and kept it until the next pass, six hours on. On the split topology with `cotal up --no-manager` on the broker host and the only manager on another root, that manager never reminted and still blocked the renewal: a manager started on the daemon's own root lost the lease to it, and `cotal doctor auth --fix` on the broker host refused with `held by manager`, so `delivery.creds` and `membership-rw.creds` expired. The heartbeat now contends only while the manager's last store check found the daemon on its own store or found no daemon, so `doctor auth --fix` on the broker host renews the daemon credentials again.
