---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

In a folder that holds another space's stopped or prepared stack, bare `cotal` with a prepared or stopped selection labels the selection's `cotal up` as "Start this space" and offers no `cotal spawn`, as it does from any other folder, instead of calling it this folder's space.

Bare `cotal` names `cotal up --max-file-store 67108865` or more, as `status` does, for a stopped stack whose recorded file store cap is below the floor, both in its line on what the folder holds and in Start here, instead of a bare `cotal up` that fails on that cap.

A refusal in such a folder, as from `ps` or `send` while the selection is stopped, keeps the note under its heading whole, with the `cotal up` that restarts this folder's space, as `status` and the `FOLDER_SPACE_NOT_RUNNING` warning already do.
