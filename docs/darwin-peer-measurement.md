# Measure macOS daemon peer disconnects

This temporary workflow reuses the immutable 0.165.4 A and same-source synthetic B archives from run44022566678. It does not modify shipped product source or relax peer UID/PID verification.

One disposable macos-15 job runs the existing stopped-daemon update cell twice, serially. Each records at most50 stock read-only daemon-status commands immediately after initial readiness and after the update. Each stage stops after180seconds. Every exit, error and timing is retained. An uncertain request stops sampling and remains explicit. Cleanup keeps the existing strict uninstall result.

The first pass is uninstrumented. Only after its cleanup is confirmed does a second pass preload a diagnostic socket observer into the owned CLI and native launchd environment. It records connect/end/close/error events and explicit end/destroy call stacks, without recording request or response payloads. It wraps existing methods and does not add error handlers or change returned values. Preload tracing can affect timing, so its frequency is reported separately. No trace is a product fix or evidence that an earlier connection had the same closing side.

The native job is pushed only after release run44038618333 has acquired its macOS cells. There is no manual dispatch or release-branch edit. Public issue7244 retains the original uninstall failure. A frequency of zero does not close that issue or identify a fix.
