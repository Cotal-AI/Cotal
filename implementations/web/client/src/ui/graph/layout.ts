// The graph's force layout: d3-force over the topology model, driven by the caller one tick at a
// time. The simulation's own timer is stopped as soon as it is built, so nothing runs unless the
// caller ticks, and the caller ends the layout by ceasing to tick. No window and no document, so a suite can import it under Node.
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { TopoModel, TopoNode } from "../../lib/topology.js";

interface Body extends SimulationNodeDatum {
  id: string;
  /** The radius other nodes keep clear of. */
  r: number;
}

/** A channel pill's width: the mock's `14 + length * 7` over the channel's name. */
export const pillWidth = (label: string): number => 14 + label.length * 7;

/** How much room a node takes: half a pill and a margin for a channel, a character and its name for an agent. */
const radius = (n: TopoNode): number => (n.kind === "channel" ? pillWidth(n.label) / 2 + 6 : 30);

/** What makes two models the same layout problem: the same nodes and the same links. Heat, a label
 *  and a status change what is drawn and not where it sits, so none of them is in the key. */
export function structureKey(model: TopoModel): string {
  const nodes = model.nodes.map((n) => n.id).sort();
  const links = model.links.map((l) => `${l.source}\u0000${l.target}\u0000${l.kind}`).sort();
  return `${nodes.join("\u0001")}\u0002${links.join("\u0001")}`;
}

/** Ticks run before the first draw, enough for the simulation's alpha to decay to its floor. The
 *  layout is then at rest when the graph first renders, and d3-force is deterministic, so the same
 *  model always rests in the same place. */
const WARM_TICKS = 300;

/** The alpha a change in the node or link set heats the simulation back to. */
const REHEAT = 0.5;

export class ForceLayout {
  private readonly sim: Simulation<Body, undefined>;
  private readonly links: ForceLink<Body, SimulationLinkDatum<Body>>;
  private bodies = new Map<string, Body>();
  private key: string | undefined;

  constructor(width: number, height: number) {
    // The distances were tuned on the panel's 420 units; a larger drawing spreads them in proportion.
    const k = Math.min(width, height) / 420;
    this.links = forceLink<Body, SimulationLinkDatum<Body>>([]).id((d) => d.id).distance(90 * k).strength(0.4);
    this.sim = forceSimulation<Body>()
      .force("link", this.links)
      .force("charge", forceManyBody<Body>().strength(-280 * k * k))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<Body>().radius((d) => d.r))
      // A weak pull to the middle keeps a group with no link to the rest from drifting out of view.
      .force("x", forceX<Body>(width / 2).strength(0.04))
      .force("y", forceY<Body>(height / 2).strength(0.04))
      .stop();
  }

  /** Takes in a model. Nodes already placed keep their place. Returns whether the node or link set
   *  differs from the last one given, which is when the caller should `reheat`. */
  sync(model: TopoModel): boolean {
    const key = structureKey(model);
    if (key === this.key) return false;
    const next = new Map<string, Body>();
    for (const n of model.nodes) next.set(n.id, this.bodies.get(n.id) ?? { id: n.id, r: radius(n) });
    this.bodies = next;
    this.sim.nodes([...next.values()]);
    this.links.links(model.links.map((l) => ({ source: l.source, target: l.target })));
    this.key = key;
    return true;
  }

  /** Runs the simulation to rest in one go, for the first draw. */
  warm(): void {
    this.sim.alpha(1).tick(WARM_TICKS);
  }

  /** Heats the simulation so the layout moves to fit a changed node or link set. */
  reheat(): void {
    this.sim.alpha(Math.max(this.sim.alpha(), REHEAT));
  }

  /** Moves the layout one step. */
  tick(): void {
    this.sim.tick();
  }

  /** Whether the layout has come to rest and needs no more ticks. */
  get settled(): boolean {
    return this.sim.alpha() < this.sim.alphaMin();
  }

  /** A node's place, or undefined for an id the layout has not been given. */
  at(id: string): { x: number; y: number } | undefined {
    const b = this.bodies.get(id);
    return b && Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x!, y: b.y! } : undefined;
  }
}
