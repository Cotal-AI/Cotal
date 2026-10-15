/** Gives this suite's process a DOM from happy-dom, a test-only devDependency that client source
 *  never imports. Import it FIRST, before any module that renders Markdown or mounts React:
 *  `lib/md.ts` builds its sanitizer from the `window` it finds on the first render, and React's
 *  client reads `window` and `document` when it loads.
 *
 *  Every name the window carries that Node does not already define is copied onto `globalThis`, so
 *  `document`, `HTMLElement`, `Node` and the event classes resolve as they do in a page. `window`
 *  and `document` are set unconditionally, because the art seam may already have pointed `window`
 *  at `globalThis` when it loaded first.
 *
 *  ONE PART OF HAPPY-DOM IS REPLACED, AND WHY. DOMPurify walks the parsed body with a NodeIterator
 *  and removes the node it is standing on. The DOM standard gives NodeIterator "pre-removing steps"
 *  so the walk resumes after a removed node; happy-dom's iterator (20.14.6 and 21.0.1 alike) is a
 *  TreeWalker underneath and has none, so the walk ends at the first removal and everything after
 *  it is returned unsanitized. Under that iterator `<script>` survives DOMPurify, which no browser
 *  allows. `createNodeIterator` is therefore replaced with `SpecNodeIterator` below, which follows
 *  the standard's traversal and its removal rule. The Markdown suite proves both halves: the native
 *  iterator really stops, and this one really resumes. */
import { Window } from "happy-dom";

export const dom = new Window({ url: "http://localhost/" });

const g = globalThis as Record<string, unknown>;
for (let o: object | null = dom; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
  for (const key of Object.getOwnPropertyNames(o)) {
    if (key in g || key === "constructor") continue;
    let value: unknown;
    try { value = (dom as unknown as Record<string, unknown>)[key]; } catch { continue; }
    // A method such as `getComputedStyle` reads `this`; a class (capitalised) must stay unbound.
    if (typeof value === "function" && /^[a-z]/.test(key)) value = (value as (...a: unknown[]) => unknown).bind(dom);
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }
}
g.window = dom;
g.document = dom.document;

/** The part of a DOM node the iterator walks. */
interface TreeNode {
  nodeType: number;
  parentNode: TreeNode | null;
  firstChild: TreeNode | null;
  lastChild: TreeNode | null;
  nextSibling: TreeNode | null;
  previousSibling: TreeNode | null;
  contains(other: TreeNode): boolean;
}
type Filter = ((n: TreeNode) => number) | { acceptNode(n: TreeNode): number } | null;

/** The node after `node` in tree order, staying inside `root`, or null at the end. */
function following(node: TreeNode, root: TreeNode): TreeNode | null {
  if (node.firstChild) return node.firstChild;
  for (let n: TreeNode | null = node; n && n !== root; n = n.parentNode) if (n.nextSibling) return n.nextSibling;
  return null;
}

/** The last node in tree order inside `node`, `node` itself when it has no children. */
function lastInclusiveDescendant(node: TreeNode): TreeNode {
  let n = node;
  while (n.lastChild) n = n.lastChild;
  return n;
}

/** NodeIterator as the DOM standard defines it (dom.spec.whatwg.org, "Interface NodeIterator").
 *  The standard runs the removal rule when a node is removed; this runs it on the next step instead,
 *  from where the removed node sat when it was handed out. That is the same position as long as the
 *  caller removes only the node it was handed, after inserting anything it keeps after that node,
 *  which is what DOMPurify does. */
export class SpecNodeIterator {
  private reference: TreeNode;
  private beforeReference = true;
  /** Where the walk resumes if `reference` is gone by the next step: the standard's removal rule. */
  private resumeAt: TreeNode | null = null;

  constructor(readonly root: TreeNode, readonly whatToShow = 0xffffffff, readonly filter: Filter = null) {
    this.reference = root;
  }

  private accepts(node: TreeNode): boolean {
    if (!((1 << (node.nodeType - 1)) & this.whatToShow)) return false;
    if (!this.filter) return true;
    const verdict = typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node);
    return verdict === 1; // FILTER_ACCEPT
  }

  nextNode(): TreeNode | null {
    if (this.reference !== this.root && !this.root.contains(this.reference) && this.resumeAt) {
      this.reference = this.resumeAt;
      this.beforeReference = false;
    }
    let node: TreeNode | null = this.reference;
    let before = this.beforeReference;
    for (;;) {
      if (before) before = false;
      else {
        node = following(node!, this.root);
        if (!node) return null;
      }
      if (this.accepts(node!)) break;
    }
    this.reference = node!;
    this.beforeReference = false;
    this.resumeAt = node!.previousSibling ? lastInclusiveDescendant(node!.previousSibling) : node!.parentNode;
    return node;
  }
}

type DocumentProto = { createNodeIterator(root: TreeNode, whatToShow?: number, filter?: Filter): unknown };
/** The prototype that owns `createNodeIterator`. `window.Document` is a per-window subclass, so the
 *  method lives further up the chain, on the base class every document (a parsed one included)
 *  inherits from. */
const owner = (o: object | null): DocumentProto => {
  for (; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, "createNodeIterator")) return o as DocumentProto;
  throw new Error("happy-dom's document has no createNodeIterator");
};
const docProto = owner(dom.document);
/** happy-dom's own `createNodeIterator`, kept so the Markdown suite can show why it is replaced. */
export const nativeCreateNodeIterator = docProto.createNodeIterator;
docProto.createNodeIterator = function (root, whatToShow, filter) {
  return new SpecNodeIterator(root, whatToShow ?? 0xffffffff, filter ?? null);
};

/** The prototype on `o`'s chain that owns `key`, or throws: a missing owner means happy-dom moved
 *  the member and the shim below would silently patch nothing. */
const ownerOf = (o: object | null, key: string): object => {
  for (; o; o = Object.getPrototypeOf(o)) if (Object.prototype.hasOwnProperty.call(o, key)) return o;
  throw new Error(`happy-dom has no ${key} on this chain`);
};
// The second replacement. DOMPurify reads a node's name through the getter on `Node.prototype`
// (`lookupGetter(Node.prototype, "nodeName")`), so a page script cannot clobber it. In a browser that
// getter answers for every kind of node. happy-dom puts the real answer on `Element`, `Text` and
// `Comment` and leaves the base getter returning nothing for them, so DOMPurify reads every tag name
// as "" and drops the whole body. The base getter is made to defer to the node's own class.
const nodeBase = ownerOf((dom as unknown as { Node: { prototype: object } }).Node.prototype, "nodeName");
const baseNodeName = Object.getOwnPropertyDescriptor(nodeBase, "nodeName")!.get!;
/** happy-dom's own base `nodeName` getter, kept so the Markdown suite can show why it is replaced. */
export const nativeNodeName = (node: object): string => baseNodeName.call(node) as string;
Object.defineProperty(nodeBase, "nodeName", {
  configurable: true,
  get(this: object) {
    for (let o = Object.getPrototypeOf(this); o && o !== nodeBase; o = Object.getPrototypeOf(o)) {
      const own = Object.getOwnPropertyDescriptor(o, "nodeName");
      if (own?.get) return own.get.call(this);
    }
    return baseNodeName.call(this);
  },
});

/** Release the window's timers and handles, so the suite's process can exit. */
export const closeDom = (): Promise<void> => dom.happyDOM.close();
