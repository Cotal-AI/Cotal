---
"@cotal-ai/cli": patch
---

`cotal service uninstall` on macOS removes the launchd agent that `cotal service install` wrote. The plist records its mesh and root as `<!-- cotal-mesh: <mesh> -->` comments, and the reader kept the closing ` -->`, so `service status` reported the mesh and root with that suffix and `service uninstall --mesh <mesh>` always refused with a remedy that could not work. Each platform's unit now writes and reads its provenance header through one comment syntax, so the reader strips exactly what the writer added. Linux units are unchanged.
