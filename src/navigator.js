// Phase-1 navigation call. Parses, validates, and retries the LLM's structured
// action output. Falls back to BM25 search after two parse failures.

import { promptNavigate, NAVIGATE_SYSTEM } from "./prompts.js";

const ALLOWED_ACTIONS = new Set(["descend", "select_leaves", "bm25_fallback", "widen"]);

export const TRACE_PHASES = ["navigate", "synthesize", "fallback"];

export function summarizeTrace(traces) {
  return traces.map((t) => ({
    depth: t.depth,
    action: t.action.action,
    candidate_count: t.candidates.length,
    chosen: t.action.child_ids || t.action.leaf_ids || [],
    reason: t.action.reason,
    duration_ms: Math.round(t.duration_ms),
  }));
}

export class NavigationError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "NavigationError";
    this.code = code;
    this.cause = cause;
  }
}

function stripFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function findFirstJSONObject(text) {
  const stripped = stripFences(text);
  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

export function parseAction(text) {
  const block = findFirstJSONObject(text);
  if (!block) throw new NavigationError("no JSON object in response", "PARSE_FAIL");
  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch (e) {
    throw new NavigationError(`JSON.parse failed: ${e.message}`, "PARSE_FAIL", e);
  }
  if (!parsed || !ALLOWED_ACTIONS.has(parsed.action)) {
    throw new NavigationError(`invalid action: ${parsed && parsed.action}`, "BAD_ACTION");
  }
  if (parsed.action === "descend" && (!Array.isArray(parsed.child_ids) || parsed.child_ids.length === 0)) {
    throw new NavigationError("descend requires non-empty child_ids", "BAD_ACTION");
  }
  if (parsed.action === "select_leaves" && (!Array.isArray(parsed.leaf_ids) || parsed.leaf_ids.length === 0)) {
    throw new NavigationError("select_leaves requires non-empty leaf_ids", "BAD_ACTION");
  }
  if (parsed.action === "bm25_fallback" && !Array.isArray(parsed.query_terms)) {
    parsed.query_terms = [];
  }
  parsed.reason = (parsed.reason || "").slice(0, 200);
  return parsed;
}

export function validateAgainstCandidates(action, candidates) {
  const candidateIds = new Set(candidates.map((c) => c.node_id));
  const ids = action.action === "descend" ? action.child_ids : action.action === "select_leaves" ? action.leaf_ids : [];
  for (const id of ids) {
    if (!candidateIds.has(id)) {
      throw new NavigationError(`phantom id ${id}`, "PHANTOM_ID");
    }
  }
  return action;
}

const RETRY_MESSAGE = {
  role: "user",
  content:
    "Your previous response was not valid JSON. Respond ONLY with one JSON object matching the schema. No prose, no markdown.",
};

// Routing decision cache. Keyed by normalized query + current node id +
// candidate id list. Repeated identical queries skip the LLM call.
const routingCache = new Map();
const ROUTING_CACHE_LIMIT = 200;

function routingKey(query, currentNodeId, candidateIds) {
  const norm = query.toLowerCase().trim().replace(/\s+/g, " ");
  return `${norm}|${currentNodeId}|${[...candidateIds].sort().join(",")}`;
}

function cacheGet(key) {
  return routingCache.get(key) || null;
}

function cacheSet(key, action) {
  if (routingCache.size >= ROUTING_CACHE_LIMIT) {
    const firstKey = routingCache.keys().next().value;
    routingCache.delete(firstKey);
  }
  routingCache.set(key, action);
}

export function clearRoutingCache() {
  routingCache.clear();
}

export class Navigator {
  constructor(db, inference) {
    this.db = db;
    this.inference = inference;
  }

  async callNavigate(query, currentNode, childOptions) {
    // Trivial case: only one candidate. There is nothing to choose, so skip
    // the LLM call. This avoids both wasted latency and a class of confusion
    // bugs we saw with small models attempting "select_leaves" against a
    // single non-leaf child.
    if (childOptions.length === 1) {
      const only = childOptions[0];
      const action = only.is_leaf
        ? { action: "select_leaves", leaf_ids: [only.node_id], reason: "only candidate" }
        : { action: "descend", child_ids: [only.node_id], reason: "only candidate" };
      return action;
    }
    const cacheK = routingKey(query, currentNode.node_id, childOptions.map((c) => c.node_id));
    const hit = cacheGet(cacheK);
    if (hit) return hit;
    const messages = promptNavigate(query, currentNode, childOptions);
    let resp;
    try {
      resp = await this.inference.chat(messages, { max_new_tokens: 220 });
    } catch (e) {
      throw new NavigationError(`inference failed: ${e.message}`, "INFER_FAIL", e);
    }
    try {
      const parsed = parseAction(resp.text);
      const validated = validateAgainstCandidates(parsed, childOptions);
      cacheSet(cacheK, validated);
      return validated;
    } catch (firstErr) {
      // Retry once with explicit error feedback.
      const retryMessages = [
        ...messages,
        { role: "assistant", content: resp.text },
        RETRY_MESSAGE,
      ];
      let retryResp;
      try {
        retryResp = await this.inference.chat(retryMessages, { max_new_tokens: 220 });
      } catch (e) {
        throw new NavigationError(`retry inference failed: ${e.message}`, "INFER_FAIL", e);
      }
      try {
        const parsed = parseAction(retryResp.text);
        const validated = validateAgainstCandidates(parsed, childOptions);
        cacheSet(cacheK, validated);
        return validated;
      } catch {
        const fb = {
          action: "bm25_fallback",
          query_terms: query.split(/\s+/).slice(0, 5),
          reason: `parse failed twice: ${firstErr.message}`,
        };
        cacheSet(cacheK, fb);
        return fb;
      }
    }
  }

  collectChildren(currentNodes) {
    const children = [];
    const seen = new Set();
    for (const n of currentNodes) {
      for (const cid of n.child_ids) {
        if (seen.has(cid)) continue;
        seen.add(cid);
        const child = this.db.corpus.tree.getNode(cid);
        if (child) children.push(child);
      }
    }
    return children;
  }

  async navigate(query, opts = {}) {
    const { maxDepth = 4, branchFactor = 1, onTrace } = opts;
    const traces = [];
    const root = this.db.corpus.tree.getRoot();
    if (!root) {
      return { selectedLeaves: [], path: [], traces, fallback: false };
    }
    let currentNodes = [root];
    const path = [root];
    let selectedLeafIds = [];
    let fallback = null;

    for (let depth = 0; depth < maxDepth; depth++) {
      const children = this.collectChildren(currentNodes);
      if (children.length === 0) {
        const allLeaves = currentNodes.filter((n) => n.is_leaf).map((n) => n.node_id);
        selectedLeafIds = allLeaves.length > 0 ? allLeaves : currentNodes.flatMap((n) => this.db.corpus.tree.getLeaves(n.node_id).map((l) => l.node_id));
        break;
      }
      const t0 = performance.now();
      const action = await this.callNavigate(query, currentNodes[currentNodes.length - 1], children);
      const event = {
        phase: "navigate",
        depth,
        query,
        candidates: children.map((c) => ({ node_id: c.node_id, title: c.title })),
        action,
        duration_ms: performance.now() - t0,
      };
      traces.push(event);
      if (typeof onTrace === "function") onTrace(event);

      if (action.action === "descend") {
        currentNodes = children
          .filter((c) => action.child_ids.includes(c.node_id))
          .slice(0, branchFactor);
        if (currentNodes.length === 0) {
          fallback = { fallback: true, query_terms: query.split(/\s+/).slice(0, 5), path };
          break;
        }
        path.push(currentNodes[0]);
      } else if (action.action === "select_leaves") {
        selectedLeafIds = action.leaf_ids;
        break;
      } else if (action.action === "bm25_fallback") {
        fallback = { fallback: true, query_terms: action.query_terms, path };
        break;
      } else if (action.action === "widen") {
        const parent = currentNodes[0].parent_id ? this.db.corpus.tree.getNode(currentNodes[0].parent_id) : root;
        currentNodes = parent ? this.db.corpus.tree.getChildren(parent.node_id) : [root];
      }
    }

    if (fallback) {
      return { ...fallback, traces };
    }

    if (selectedLeafIds.length === 0) {
      const collected = currentNodes.flatMap((n) => this.db.corpus.tree.getLeaves(n.node_id).map((l) => l.node_id));
      selectedLeafIds = collected;
    }

    return { selectedLeaves: selectedLeafIds, path, traces, fallback: false };
  }
}
