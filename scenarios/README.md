# Test machines

Machines you can wipe in seconds, for trying the Cotal app by hand on each OS. The app runs live
from a checkout, so a code change shows up without building or installing anything.

## Linux: an Ubuntu desktop VM on the Ubuntu PC

Run these on the PC. The script is `scenarios/machines/ubuntu-desktop.sh`; on the Ubuntu PC it is
installed as `cotal-vm`, so `cotal-vm reset` and so on.

| To | Run | Takes |
|---|---|---|
| Wipe the VM back to clean and start it | `ubuntu-desktop.sh reset` | 12 s |
| Open the app from the checkout on its screen | `ubuntu-desktop.sh app` | 6 s |
| Save the VM as it is now, as a starting point | `ubuntu-desktop.sh save signed-out-2-agents` | 16 s |
| Go back to that starting point | `ubuntu-desktop.sh reset signed-out-2-agents` | 12 s |
| See the saved starting points | `ubuntu-desktop.sh list` | |
| Pull main and rebuild | `ubuntu-desktop.sh dev update` | about 1 min |
| Stop it when you're done | `ubuntu-desktop.sh stop` | |

**Seeing the screen.** The VM's screen is only reachable from the PC itself. From your Mac, open
a tunnel with `ssh -L 5901:127.0.0.1:5901 <you>@<the PC>`, then in Finder choose Go > Connect to
Server and enter `vnc://localhost:5901`. The password is in
`~/.config/cotal-test-machines/cotal-dev-ubuntu.vnc-password` on the PC.

**Changing code.** The checkout is `~/cotal-test-machines/ubuntu-desktop/Cotal` on the PC; the VM
sees the same folder. Edit the app's window code (`desktop/src`) and the open window reloads
within a few seconds. Edit its Rust code (`desktop/src-tauri`) and it rebuilds and reopens. After
changing the `cotal` command or the background service, run `ubuntu-desktop.sh dev build`, then
`ubuntu-desktop.sh app`.

A reset wipes everything inside the VM: the background service, sign-ins, installed agent apps.
The checkout and the build stay, so the app is back in seconds.

## Command-line profiles, on every machine

A profile is a separate Cotal home with its own background service, for trying a command-line
setup without touching the machine's real one. The app window always uses the machine's own
service, so profiles are for the `cotal` command only. Inside the Linux VM:

```bash
cotal-dev profile new trial
cotal-dev profile shell trial
cotal-dev profile reset trial
cotal-dev profile rm trial
```

`cotal-dev profile list` shows them and `cotal-dev profile run trial -- cotal status` runs one
command in one.

## Windows

Your Windows 11 VM is Windows 11 Pro, so it can run Windows Sandbox: a throwaway Windows desktop
that starts clean every time. Two steps are yours, because they need its Hyper-V host and a
restart:

1. On the Hyper-V host, with the VM shut down:
   `Set-VMProcessor -VMName <vm> -ExposeVirtualizationExtensions $true`. Turn off Dynamic Memory
   for that VM, and give it at least 8 GB.
2. In the VM, in an administrator PowerShell:
   `Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All`, then
   restart. Windows Sandbox then opens from Start.

Until then, Windows gets the same command-line profiles as above.

## Mac

Your MacBook already runs the app from its live checkout (`cotal-dev app`). Nothing else is set up
there.
