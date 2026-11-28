/** Space-name conflicts and provider-endorsed account moves in the desktop shell. */
import { icon } from "./icons";
import { parseEndorsedMigration, parseSpaceCollisions, shownSpaceLabel, type EndorsedMigration, type SpaceCollision } from "./model";

function hostOf(url: string | undefined): string {
  if (!url) return "another account";
  try { return new URL(url).host; } catch { return url; }
}

export function existingRegistrationCopy(item: SpaceCollision): string {
  if (item.existingOrigin === "catalog") return `Currently registered under ${hostOf(item.existingIdp)}.`;
  if (item.existingOrigin === "up") return "Currently registered from a local space on this computer.";
  return `Currently saved manually${item.existingIdp ? ` (${hostOf(item.existingIdp)})` : ""} on this computer.`;
}

export interface SpaceConflictsHost {
  openPanel(): void;
  moveAccount(migration: EndorsedMigration): Promise<void>;
  replaceSpace(item: SpaceCollision): Promise<void>;
  signOutProvider(idp: string): Promise<void>;
  changed(): void;
}

export class SpaceConflicts {
  collisions: SpaceCollision[] = [];
  migration: EndorsedMigration | undefined;
  private readonly kept = new Set<string>();
  private readonly errors = new Map<string, string>();
  private busySpace: string | undefined;
  private message = "";
  private messageError = false;

  constructor(private readonly host: SpaceConflictsHost) {}

  get activeCollisions(): SpaceCollision[] {
    return this.collisions.filter(item => !this.kept.has(`${item.catalogIdp}:${item.space}`));
  }

  get hasUnresolved(): boolean {
    return this.activeCollisions.length > 0;
  }

  get busy(): boolean {
    return this.busySpace !== undefined;
  }

  applySpacesResult(result: Record<string, unknown>, resetKept = false): void {
    if (resetKept) this.kept.clear();
    this.collisions = parseSpaceCollisions(result);
    this.migration = parseEndorsedMigration(result);
    const currentKeys = new Set(this.collisions.map(item => `${item.catalogIdp}:${item.space}`));
    for (const key of this.kept) if (!currentKeys.has(key)) this.kept.delete(key);
    for (const key of this.errors.keys()) if (!currentKeys.has(key)) this.errors.delete(key);
    if (!this.collisions.length) { this.message = ""; this.messageError = false; }
  }

  keepExisting(item: SpaceCollision): void {
    const key = `${item.catalogIdp}:${item.space}`;
    this.kept.add(key);
    this.errors.delete(key);
    this.message = `Kept existing registration for ${shownSpaceLabel(item.catalogLabel, item.space)}.`;
    this.messageError = false;
    this.host.changed();
  }

  async replaceWithCatalog(item: SpaceCollision): Promise<void> {
    if (this.busy) return;
    const key = `${item.catalogIdp}:${item.space}`;
    this.busySpace = key;
    this.errors.delete(key);
    this.message = "";
    this.messageError = false;
    this.host.changed();
    try {
      await this.host.replaceSpace(item);
      this.kept.delete(key);
      this.message = `Now using ${hostOf(item.catalogIdp)} for ${shownSpaceLabel(item.catalogLabel, item.space)}.`;
      this.messageError = false;
    } catch (error) {
      const text = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
      this.errors.set(key, text);
      this.message = text;
      this.messageError = true;
    } finally {
      this.busySpace = undefined;
      this.host.changed();
    }
  }

  async signOutOther(idp: string): Promise<void> {
    if (this.busy) return;
    this.busySpace = `signout:${idp}`;
    this.message = "";
    this.messageError = false;
    this.host.changed();
    try {
      await this.host.signOutProvider(idp);
      this.message = `Signed out of ${hostOf(idp)} and refreshed spaces.`;
      this.messageError = false;
    } catch (error) {
      this.message = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
      this.messageError = true;
    } finally {
      this.busySpace = undefined;
      this.host.changed();
    }
  }

  renderCallout(root: HTMLElement, outerBusy: boolean): void {
    const active = this.activeCollisions;
    if (!active.length) {
      root.hidden = true;
      delete root.dataset.key;
      return;
    }
    root.hidden = false;
    const migration = this.migration && active.some(item => item.existingOrigin === "catalog" && item.existingIdp === this.migration!.fromIdp)
      ? this.migration
      : undefined;
    const key = JSON.stringify([active, migration, outerBusy || this.busy]);
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    const heading = document.createElement("h2");
    const copy = document.createElement("p");
    const actions = document.createElement("div");
    actions.className = "actions";
    if (migration) {
      const fromHost = hostOf(migration.fromIdp);
      const toHost = hostOf(migration.toIdp);
      heading.textContent = `Move spaces from ${fromHost}`;
      copy.textContent = `${migration.spaces.length === 1 ? `Your space ${migration.spaces[0]} is` : `Your spaces (${migration.spaces.join(", ")}) are`} still registered under ${fromHost}, which now points to ${toHost}. Approve once in your browser to move ${migration.spaces.length === 1 ? "it" : "them"}.`;
      const move = document.createElement("button");
      move.type = "button";
      move.id = "move-account";
      move.dataset.testid = "move-account";
      move.className = "button primary";
      move.disabled = outerBusy || this.busy;
      move.textContent = `Move to ${toHost}`;
      move.addEventListener("click", () => void this.host.moveAccount(migration));
      actions.append(move);
    } else {
      heading.textContent = active.length === 1 ? `1 space name already exists here` : `${active.length} space names already exist here`;
      copy.textContent = `${active.map(item => item.space).join(", ")} matched existing registrations on this computer, so Cotal kept what was already here.`;
    }
    const review = document.createElement("button");
    review.type = "button";
    review.id = "open-conflicts";
    review.dataset.testid = "open-conflicts";
    review.className = migration ? "text-button" : "button secondary";
    review.disabled = outerBusy || this.busy;
    review.textContent = migration ? "Review spaces" : "Review space conflicts";
    review.addEventListener("click", () => this.host.openPanel());
    actions.append(review);
    root.replaceChildren(heading, copy, actions);
  }

  renderPanel(banner: HTMLElement, list: HTMLElement, messageEl: HTMLElement, outerBusy: boolean): void {
    const disabled = outerBusy || this.busy;
    if (messageEl.textContent !== this.message) messageEl.textContent = this.message;
    messageEl.classList.toggle("error", this.messageError);
    if (this.migration) {
      banner.hidden = false;
      const fromHost = hostOf(this.migration.fromIdp);
      const toHost = hostOf(this.migration.toIdp);
      const heading = document.createElement("h2");
      heading.textContent = `Move account from ${fromHost} to ${toHost}`;
      const copy = document.createElement("p");
      copy.textContent = `${fromHost} endorses ${toHost} as its new address. Moving updates ${this.migration.spaces.join(", ")} together after a fresh browser approval.`;
      const actions = document.createElement("div");
      actions.className = "actions";
      const move = document.createElement("button");
      move.type = "button";
      move.dataset.testid = "panel-move-account";
      move.className = "button primary";
      move.disabled = disabled;
      move.textContent = `Move to ${toHost}`;
      const m = this.migration;
      move.addEventListener("click", () => void this.host.moveAccount(m));
      actions.append(move);
      banner.replaceChildren(heading, copy, actions);
    } else {
      banner.hidden = true;
      banner.replaceChildren();
    }
    if (!this.collisions.length) {
      const empty = document.createElement("li");
      empty.className = "conflict-empty";
      empty.textContent = "No space name conflicts remain.";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...this.collisions.map(item => {
      const key = `${item.catalogIdp}:${item.space}`;
      const isKept = this.kept.has(key);
      const error = this.errors.get(key);
      const row = document.createElement("li");
      row.className = "app-row conflict-row";
      row.dataset.testid = "space-conflict-row";
      row.dataset.space = item.space;
      row.dataset.state = error ? "failed" : isKept ? "ready" : "warn";

      const copy = document.createElement("div");
      copy.className = "app-copy";
      const title = document.createElement("div");
      title.className = "app-name";
      const label = shownSpaceLabel(item.catalogLabel, item.space);
      title.textContent = label === item.space ? item.space : `${label} (${item.space})`;

      const status = document.createElement("p");
      status.className = "app-status";
      status.append(icon(error ? "warning" : isKept ? "check" : "warning"), document.createTextNode(
        error ? error : isKept ? `Kept existing registration` : `${existingRegistrationCopy(item)} ${hostOf(item.catalogIdp)} also lists this space name.`,
      ));
      copy.append(title, status);

      const actions = document.createElement("div");
      actions.className = "conflict-actions";
      if (item.existingOrigin === "catalog") {
        if (!this.migration && item.existingIdp) {
          const signOut = document.createElement("button");
          signOut.type = "button";
          signOut.className = "button secondary";
          signOut.disabled = disabled;
          signOut.textContent = `Sign out ${hostOf(item.existingIdp)}`;
          signOut.setAttribute("aria-label", `Sign out ${hostOf(item.existingIdp)} to use ${hostOf(item.catalogIdp)} for ${item.space}`);
          signOut.addEventListener("click", () => void this.signOutOther(item.existingIdp!));
          actions.append(signOut);
        }
      } else {
        const useCatalog = document.createElement("button");
        useCatalog.type = "button";
        useCatalog.className = "button secondary";
        useCatalog.disabled = disabled;
        useCatalog.textContent = `Use ${hostOf(item.catalogIdp)}`;
        useCatalog.setAttribute("aria-label", `Use ${hostOf(item.catalogIdp)} for ${item.space}`);
        useCatalog.addEventListener("click", () => void this.replaceWithCatalog(item));
        actions.append(useCatalog);
      }
      if (!isKept) {
        const keep = document.createElement("button");
        keep.type = "button";
        keep.className = "text-button";
        keep.disabled = disabled;
        keep.textContent = "Keep existing";
        keep.setAttribute("aria-label", `Keep existing registration for ${item.space}`);
        keep.addEventListener("click", () => this.keepExisting(item));
        actions.append(keep);
      }
      row.append(copy, actions);
      return row;
    }));
  }
}
