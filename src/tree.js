// Canonical NodeRecord schema, deterministic ID builder, and content hashing.
// The Tree class is added in a follow-up commit.

export const NODE_LEVELS = ["corpus", "document", "section", "subsection", "page", "leaf"];

function isStringArray(arr) {
  return Array.isArray(arr) && arr.every((v) => typeof v === "string");
}

export function nodeId(parts) {
  if (!parts || typeof parts !== "object") {
    throw new Error("nodeId: parts must be an object");
  }
  const segments = [];
  for (const [key, value] of Object.entries(parts)) {
    if (value === undefined || value === null) continue;
    const safeKey = String(key).replace(/[:/\\]/g, "_");
    const safeVal = String(value).replace(/[/\\]/g, "_");
    segments.push(`${safeKey}:${safeVal}`);
  }
  if (segments.length === 0) {
    throw new Error("nodeId: at least one part required");
  }
  return segments.join("/");
}

export function makeNode(opts) {
  const {
    node_id,
    doc_id,
    parent_id = null,
    title,
    level,
    routing_summary = "",
    summary = "",
    child_ids = [],
    span = null,
    page_start = null,
    page_end = null,
    keywords = [],
    is_leaf,
    created_at = Date.now(),
    source_hash = "",
  } = opts || {};

  if (typeof node_id !== "string" || node_id.length === 0) {
    throw new Error("makeNode: node_id required");
  }
  if (typeof doc_id !== "string" || doc_id.length === 0) {
    throw new Error("makeNode: doc_id required");
  }
  if (typeof title !== "string") {
    throw new Error("makeNode: title required");
  }
  if (!NODE_LEVELS.includes(level)) {
    throw new Error(`makeNode: invalid level ${level}`);
  }
  if (!Array.isArray(child_ids) || !isStringArray(child_ids)) {
    throw new Error("makeNode: child_ids must be an array of strings");
  }
  if (!isStringArray(keywords)) {
    throw new Error("makeNode: keywords must be an array of strings");
  }

  const computedIsLeaf = typeof is_leaf === "boolean" ? is_leaf : child_ids.length === 0;
  if (computedIsLeaf && child_ids.length !== 0) {
    throw new Error("makeNode: leaf cannot have child_ids");
  }
  if (!computedIsLeaf && child_ids.length === 0 && level !== "corpus") {
    // corpus root may briefly have no children before documents are added
  }

  if (span !== null) {
    if (!Array.isArray(span) || span.length !== 2 || !span.every((n) => typeof n === "number")) {
      throw new Error("makeNode: span must be [number, number] or null");
    }
    if (span[0] > span[1]) {
      throw new Error("makeNode: span start must be <= end");
    }
  }

  if (page_start !== null && typeof page_start !== "number") {
    throw new Error("makeNode: page_start must be number or null");
  }
  if (page_end !== null && typeof page_end !== "number") {
    throw new Error("makeNode: page_end must be number or null");
  }

  return {
    node_id,
    doc_id,
    parent_id,
    title,
    level,
    routing_summary,
    summary,
    child_ids: child_ids.slice(),
    span: span ? [span[0], span[1]] : null,
    page_start,
    page_end,
    keywords: keywords.slice(),
    is_leaf: computedIsLeaf,
    created_at,
    source_hash,
  };
}

export async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const TREE_SCHEMA_VERSION = 1;

export class Tree {
  constructor(rootId, nodesById = new Map(), opts = {}) {
    this.rootId = rootId;
    this.nodesById = nodesById instanceof Map ? nodesById : new Map(Object.entries(nodesById));
    this.corpusName = opts.corpusName || "default";
    this.docIndex = opts.docIndex || {};
  }

  static fromJSON(json) {
    if (!json || typeof json !== "object") {
      throw new Error("Tree.fromJSON: invalid input");
    }
    if (json.version !== TREE_SCHEMA_VERSION) {
      throw new Error(`Tree.fromJSON: unsupported version ${json.version}`);
    }
    const nodes = new Map();
    for (const [id, n] of Object.entries(json.nodes || {})) {
      nodes.set(id, n);
    }
    return new Tree(json.root_id, nodes, {
      corpusName: json.corpus_name,
      docIndex: json.doc_index || {},
    });
  }

  toJSON() {
    const nodes = {};
    const sortedIds = Array.from(this.nodesById.keys()).sort();
    for (const id of sortedIds) {
      nodes[id] = this.nodesById.get(id);
    }
    return {
      version: TREE_SCHEMA_VERSION,
      corpus_name: this.corpusName,
      root_id: this.rootId,
      nodes,
      doc_index: this.docIndex,
    };
  }

  getNode(id) {
    return this.nodesById.get(id) || null;
  }

  getRoot() {
    return this.getNode(this.rootId);
  }

  getChildren(id) {
    const node = this.getNode(id);
    if (!node) return [];
    return node.child_ids.map((cid) => this.getNode(cid)).filter(Boolean);
  }

  getPath(id) {
    const path = [];
    let cur = this.getNode(id);
    const seen = new Set();
    while (cur) {
      if (seen.has(cur.node_id)) {
        throw new Error(`getPath: cycle detected at ${cur.node_id}`);
      }
      seen.add(cur.node_id);
      path.unshift(cur);
      if (!cur.parent_id) break;
      cur = this.getNode(cur.parent_id);
    }
    return path;
  }

  walk(visitor) {
    const root = this.getRoot();
    if (!root) return;
    const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      const { node, depth } = stack.shift();
      visitor(node, depth);
      const children = this.getChildren(node.node_id);
      for (let i = children.length - 1; i >= 0; i--) {
        stack.unshift({ node: children[i], depth: depth + 1 });
      }
    }
  }

  walkLeaves(visitor) {
    this.walk((node, depth) => {
      if (node.is_leaf) visitor(node, depth);
    });
  }

  getLeaves(parentId) {
    const out = [];
    const start = this.getNode(parentId);
    if (!start) return out;
    const stack = [start];
    while (stack.length) {
      const node = stack.pop();
      if (node.is_leaf) {
        out.push(node);
      } else {
        for (const child of this.getChildren(node.node_id)) {
          stack.push(child);
        }
      }
    }
    return out;
  }

  replaceNode(node) {
    const prev = this.nodesById.get(node.node_id);
    if (prev && prev.parent_id !== node.parent_id) {
      throw new Error(`replaceNode: parent_id mismatch for ${node.node_id}`);
    }
    this.nodesById.set(node.node_id, node);
  }

  upsertNode(node) {
    this.nodesById.set(node.node_id, node);
  }

  removeSubtree(id) {
    const node = this.getNode(id);
    if (!node) return;
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      for (const cid of cur.child_ids) {
        const child = this.getNode(cid);
        if (child) stack.push(child);
      }
      this.nodesById.delete(cur.node_id);
    }
    if (node.parent_id) {
      const parent = this.getNode(node.parent_id);
      if (parent) {
        parent.child_ids = parent.child_ids.filter((cid) => cid !== id);
      }
    }
  }

  stats() {
    let nodeCount = 0;
    let leafCount = 0;
    let maxDepth = 0;
    let internalCount = 0;
    let totalBranching = 0;
    this.walk((node, depth) => {
      nodeCount++;
      if (node.is_leaf) {
        leafCount++;
      } else {
        internalCount++;
        totalBranching += node.child_ids.length;
      }
      if (depth > maxDepth) maxDepth = depth;
    });
    const avgBranching = internalCount > 0 ? totalBranching / internalCount : 0;
    return { nodeCount, leafCount, maxDepth, avgBranching };
  }
}
