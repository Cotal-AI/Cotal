---
"cotal-ai": patch
---

The desktop app's version-update screen now says what happened and what the button does: "Cotal was updated. Restart the background service to finish the update. If agents are running, the restart waits until they finish, then happens by itself." with the button "Restart background service", instead of "Your connection needs an update" and "Update connection". When an agent application is installed while another copy of Cotal runs the background service, the app shows a warning instead of a success message, names that copy in plain words (the Cotal app in your Applications folder, the Cotal app in another folder when it is known, or a command-line install of Cotal) and the step that works there, and no longer offers Check again in this copy, where it cannot succeed. The warning clears by itself once that other copy has picked the app up.
