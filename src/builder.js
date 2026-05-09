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
