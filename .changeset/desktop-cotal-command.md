---
"cotal-ai": patch
---

Installing the Cotal desktop app now gives you the `cotal` command in a new terminal on Windows, macOS and Linux, with no separate npm install. It runs the CLI bundled with the app on the app's own Node. Windows installers add the installation's `bin` folder to the end of your user PATH and uninstall takes it off again. On macOS the app adds its bundle's `bin` folder to the end of PATH in your login shell's startup file the first time it opens from Applications. Linux packages link `/usr/bin/cotal`. A `cotal` you already installed with npm or the shell installer stays first on PATH and keeps running, and the app never replaces a `cotal` it did not create.
