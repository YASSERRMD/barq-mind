// Tree summarization pass. Walks an ingested tree leaves-first, then bottom-up,
// asking the inference engine to fill routing_summary, summary, and keywords on
// every node. Caches results keyed on source_hash so re-runs are cheap.

import { sha256, hashChildren } from "./tree.js";
import {
  promptRoutingSummary,
  promptFullSummary,
  promptKeywords,
} from "./prompts.js";

const CACHE_FILE = "summary-cache";
const PERSIST_BATCH = 10;

function parseKeywords(text) {
  if (typeof text !== "string") return [];
  let trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === "string").slice(0, 8);
    }
  } catch {
    // fall through to comma split
  }
  return trimmed
    .split(/,\s*/)
    .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, ""))
    .filter(Boolean)
    .slice(0, 8);
}

function truncateSummary(text) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  return cleaned.length > 1000 ? cleaned.slice(0, 1000) : cleaned;
}

async function summarizeLeaf(node, leafText, inference, opts = {}) {
  const fullMessages = promptFullSummary(node, [], leafText);
  const fullResp = await inference.chat(fullMessages, { max_new_tokens: 280 });
  const summary = truncateSummary(fullResp.text);

  const routingMessages = promptRoutingSummary(node, [
    { title: node.title, snippet: leafText.slice(0, 240) },
  ]);
  const routingResp = await inference.chat(routingMessages, { max_new_tokens: 80 });
  const routing_summary = truncateSummary(routingResp.text);

  const keywordsMessages = promptKeywords(leafText);
  const kwResp = await inference.chat(keywordsMessages, { max_new_tokens: 120 });
  const keywords = parseKeywords(kwResp.text);

  return { routing_summary, summary, keywords };
}

export async function summarizeLeavesPass(tree, corpus, inference, cache, opts = {}) {
  const { onProgress, force = false } = opts;
  const leaves = [];
  tree.walkLeaves((leaf) => leaves.push(leaf));

  let updates = 0;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const text = leaf.span ? await corpus.getRawText(leaf.doc_id, leaf.span) : "";
    if (!text) {
      if (typeof onProgress === "function") onProgress(i + 1, leaves.length, leaf.title);
      continue;
    }
    const hash = await sha256(text);
    const cached = !force && cache.entries[hash];
    if (cached) {
      leaf.routing_summary = cached.routing_summary;
      leaf.summary = cached.summary;
      leaf.keywords = cached.keywords;
      leaf.source_hash = hash;
    } else {
      const out = await summarizeLeaf(leaf, text, inference, opts);
      leaf.routing_summary = out.routing_summary;
      leaf.summary = out.summary;
      leaf.keywords = out.keywords;
      leaf.source_hash = hash;
      cache.entries[hash] = {
        routing_summary: out.routing_summary,
        summary: out.summary,
        keywords: out.keywords,
        model: inference.modelId,
        created_at: Date.now(),
      };
      updates++;
      if (updates % PERSIST_BATCH === 0) {
        await corpus.save();
        await persistCache(corpus, cache);
      }
    }
    tree.upsertNode(leaf);
    if (typeof onProgress === "function") onProgress(i + 1, leaves.length, leaf.title);
  }
  await corpus.save();
  await persistCache(corpus, cache);
}

async function summarizeInternal(node, childContext, inference) {
  const routingMessages = promptRoutingSummary(node, childContext);
  const routingResp = await inference.chat(routingMessages, { max_new_tokens: 80 });
  const routing_summary = truncateSummary(routingResp.text);

  const fullMessages = promptFullSummary(node, childContext, "");
  const fullResp = await inference.chat(fullMessages, { max_new_tokens: 280 });
  const summary = truncateSummary(fullResp.text);

  const blob = childContext.map((c) => `${c.title} ${c.snippet}`).join(" ");
  const keywordsMessages = promptKeywords(blob);
  const kwResp = await inference.chat(keywordsMessages, { max_new_tokens: 120 });
  const keywords = parseKeywords(kwResp.text);

  return { routing_summary, summary, keywords };
}

function topologicalInternal(tree) {
  const order = [];
  const stack = [{ id: tree.rootId, visited: false }];
  const seen = new Set();
  while (stack.length) {
    const top = stack[stack.length - 1];
    const node = tree.getNode(top.id);
    if (!node) {
      stack.pop();
      continue;
    }
    if (top.visited) {
      stack.pop();
      if (!node.is_leaf) order.push(node);
      continue;
    }
    top.visited = true;
    for (const cid of node.child_ids) {
      if (!seen.has(cid)) {
        seen.add(cid);
        stack.push({ id: cid, visited: false });
      }
    }
  }
  return order;
}

export async function summarizeInternalsPass(tree, inference, cache, opts = {}) {
  const { onProgress, force = false } = opts;
  const internals = topologicalInternal(tree);
  let updates = 0;
  for (let i = 0; i < internals.length; i++) {
    const node = internals[i];
    const childContext = node.child_ids
      .map((cid) => tree.getNode(cid))
      .filter(Boolean)
      .map((c) => ({
        title: c.title,
        snippet: (c.routing_summary || c.summary || "").slice(0, 220),
      }));
    const childHashes = node.child_ids
      .map((cid) => tree.getNode(cid))
      .filter(Boolean)
      .map((c) => c.source_hash || "");
    const hash = await hashChildren(node.title, childHashes);
    const cached = !force && cache.entries[hash];
    if (cached) {
      node.routing_summary = cached.routing_summary;
      node.summary = cached.summary;
      node.keywords = cached.keywords;
      node.source_hash = hash;
    } else {
      const out = await summarizeInternal(node, childContext, inference);
      node.routing_summary = out.routing_summary;
      node.summary = out.summary;
      node.keywords = out.keywords;
      node.source_hash = hash;
      cache.entries[hash] = {
        routing_summary: out.routing_summary,
        summary: out.summary,
        keywords: out.keywords,
        model: inference.modelId,
        created_at: Date.now(),
      };
      updates++;
    }
    tree.upsertNode(node);
    if (typeof onProgress === "function") onProgress(i + 1, internals.length, node.title);
  }
  return updates;
}

export async function summarizeTree(tree, corpus, inference, opts = {}) {
  const cache = await loadCache(corpus.storage, inference.modelId);
  await summarizeLeavesPass(tree, corpus, inference, cache, opts);
  const internalUpdates = await summarizeInternalsPass(tree, inference, cache, opts);
  await corpus.save();
  await persistCache(corpus, cache);
  return { internalUpdates };
}

export async function loadCache(storage, modelId) {
  const json = await storage.readJSON(CACHE_FILE);
  if (!json || json.model !== modelId) {
    return { model: modelId, entries: {} };
  }
  return json;
}

export async function persistCache(corpus, cache) {
  await corpus.storage.writeJSON(CACHE_FILE, cache);
}

export async function clearCache(corpus) {
  await corpus.storage.delete(CACHE_FILE);
}

export function pruneCache(cache, validHashes) {
  const valid = validHashes instanceof Set ? validHashes : new Set(validHashes);
  let removed = 0;
  for (const hash of Object.keys(cache.entries)) {
    if (!valid.has(hash)) {
      delete cache.entries[hash];
      removed++;
    }
  }
  return removed;
}

export function cacheStats(cache) {
  return {
    model: cache.model,
    entryCount: Object.keys(cache.entries).length,
  };
}
