import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Presence = { loginEnabled: boolean; relocationOffer: boolean; pinOffer: boolean; pinMessage: string };
let offerShown = false;
let relocationShown = false;
let working = false;
let report: (message: string, error?: boolean) => void;

function offer(id: string, message: string, primary: string, accept: () => Promise<void>, decline: () => Promise<void>): void {
  if (document.getElementById(id)) return;
  const box = document.createElement("section"); box.id = id; box.setAttribute("aria-label", primary);
  const explanation = document.createElement("p"); explanation.textContent = message;
  const yes = document.createElement("button"); yes.type = "button"; yes.className = "button"; yes.textContent = primary;
  const no = document.createElement("button"); no.type = "button"; no.className = "text-button"; no.textContent = "Not now";
  const act = async (fn: () => Promise<void>) => {
    yes.disabled = no.disabled = true;
    try { await fn(); box.remove(); } catch (error) { report(String(error), true); yes.disabled = no.disabled = false; }
  };
  yes.addEventListener("click", () => void act(accept)); no.addEventListener("click", () => void act(decline));
  const actions = document.createElement("div"); actions.className = "actions";
  actions.append(yes, no);
  box.append(explanation, actions);
  (document.getElementById(id === "move-offer" ? "connection-card" : "settings-startup") ?? document.querySelector(".connection-card") ?? document.querySelector("main")!).append(box);
}

export async function refreshPresence(connected = false): Promise<void> {
  if (working) return;
  working = true;
  try {
    const p = await invoke<Presence>("desktop_presence");
    const checkbox = document.getElementById("autostart") as HTMLInputElement;
    checkbox.checked = p.loginEnabled;
    if (p.relocationOffer && !relocationShown) {
      relocationShown = true;
      offer("move-offer", "Move Cotal to Applications so its Dock icon and Open at login use a permanent location. Cotal will reopen there. An existing installation will not be replaced.", "Move to Applications", () => invoke("move_to_applications"), () => invoke("dismiss_presence_offer", { offer: "relocation" }));
    }
    if (connected && !offerShown) {
      if (p.pinOffer) {
        offerShown = true;
        offer("pin-offer", "Keep Cotal within reach after you close its window. Windows will ask you to approve.", "Pin Cotal to the taskbar", async () => {
          const pinned = await invoke<boolean>("pin_to_taskbar");
          report(pinned ? "Cotal is pinned to your taskbar." : "Windows did not pin Cotal. Your connection is unchanged.");
        }, () => invoke("dismiss_presence_offer", { offer: "pin" }));
      } else if (p.pinMessage) {
        offerShown = true;
        const message = document.createElement("p"); message.id = "pin-availability"; message.textContent = p.pinMessage;
        document.getElementById("settings-startup")!.append(message);
      }
    }
  } finally { working = false; }
}

export async function startPresence(notice: (message: string, error?: boolean) => void, actions?: { settings: () => void; dashboard: () => void }): Promise<void> {
  report = notice;
  await listen<string>("desktop-close-explained", event => report(event.payload));
  await listen<string>("desktop-presence-error", event => report(event.payload, true));
  if (actions) {
    await listen("desktop-open-settings", actions.settings);
    await listen("desktop-open-dashboard", actions.dashboard);
  }
  await refreshPresence();
}

export async function setLoginPreference(enabled: boolean): Promise<void> {
  try { await invoke("set_login_preference", { enabled }); }
  finally { await refreshPresence(); }
}
