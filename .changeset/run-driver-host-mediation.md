---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/runtime": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
---

Restrict workflow driver credentials to their own journal and record writes. Move effects and leader reads onto a separate trusted host connection, with journal ownership checks, cancellation cleanup checks, and host-held wait acknowledgements. Hosted and local runs use this split; authenticated local runs now require a recorded space signer rather than a single credentials file.

Custom run hosts must accept the separate mediator connection. Seat-adopting effect hosts must implement `restoreMigratedSeats` so migration reads stay on the host.
