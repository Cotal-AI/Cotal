---
---

The macOS app's bundled Node starts again. Since the bundle was signed ad hoc, the hardened runtime stopped it before it ran, so every action in the app ended in "This operation could not finish". The signature now carries the entitlements Node needs, and the build runs the bundled Node from the signed app.
