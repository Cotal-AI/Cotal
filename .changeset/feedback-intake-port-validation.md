---
"@cotal-ai/delivery": patch
---

`cotal feedback-intake` now refuses a `--port` that is not a decimal number from 1 to 65535 before it probes the broker, with an error that names `--port`. An out-of-range port such as `70000` used to pass argument parsing, so the intake connected and announced itself on the mesh before `listen()` failed with `options.port should be >= 0 and < 65536`. A hex or exponent spelling such as `0x1f90` or `8080e0` was accepted and bound that port.
