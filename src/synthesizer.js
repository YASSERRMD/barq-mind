// Phase-2 synthesis call. Takes the leaves selected by the navigator (or by
// BM25 fallback), fetches their raw text, prompts the LLM to answer with a
// trailing Sources line, and parses the citations back out.

import { promptSynthesize } from "./prompts.js";

const PER_LEAF_CHAR_BUDGET = 1500;
const TOTAL_CHAR_BUDGET = 24000;

export class SynthesisError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "SynthesisError";
    this.code = code;
    this.cause = cause;
  }
}

export async function buildLeafPayloads(db, leafIds) {
  const out = [];
  for (const id of leafIds) {
    const node = db.corpus.tree.getNode(id);
    if (!node) continue;
    let text = "";
    if (node.span) {
      text = (await db.corpus.getRawText(node.doc_id, node.span)) || "";
    } else if (node.summary) {
      text = node.summary;
    }
    out.push({
      node_id: node.node_id,
      doc_id: node.doc_id,
      title: node.title,
      page_start: node.page_start,
      page_end: node.page_end,
      text: text.slice(0, PER_LEAF_CHAR_BUDGET),
    });
  }
  return out;
}

export function extractCitations(response) {
  if (typeof response !== "string") return { answer: "", citations: [] };
  const sourcesIdx = response.search(/\n\s*Sources:\s*/i);
  if (sourcesIdx === -1) return { answer: response.trim(), citations: [] };
  const answer = response.slice(0, sourcesIdx).trim();
  const sourcesLine = response.slice(sourcesIdx).replace(/\n\s*Sources:\s*/i, "").trim();
  const items = sourcesLine.split(/[,;]\s+/);
  const citations = [];
  for (const raw of items) {
    const item = raw.replace(/[.;]\s*$/, "").trim();
    if (!item) continue;
    const idMatch = /\[([^\]]+)\]/.exec(item);
    if (idMatch) {
      citations.push({ section: item.replace(/\s*\[[^\]]+\]\s*/, "").trim() || idMatch[1], node_id: idMatch[1], page: null });
      continue;
    }
    const pageMatch = /(.+?)\s+(?:p|pp|pages?)\.?\s*([\d-]+)/i.exec(item);
    if (pageMatch) {
      citations.push({ section: pageMatch[1].trim(), page: pageMatch[2].trim() });
    } else {
      citations.push({ section: item, page: null });
    }
  }
  return { answer, citations };
}

export class Synthesizer {
  constructor(db, inference) {
    this.db = db;
    this.inference = inference;
  }

  async synthesize(query, selectedLeafIds, navPath, opts = {}) {
    if (!Array.isArray(selectedLeafIds) || selectedLeafIds.length === 0) {
      return {
        answer: "Insufficient evidence in the indexed sources.",
        citations: [],
        raw_response: "",
        duration_ms: 0,
      };
    }
    const t0 = performance.now();
    const allLeaves = await buildLeafPayloads(this.db, selectedLeafIds);
    const leaves = trimToBudget(allLeaves);
    const messages = promptSynthesize(query, leaves, navPath || []);
    let resp;
    try {
      resp = await this.inference.chat(messages, { max_new_tokens: 400, ...opts });
    } catch (e) {
      throw new SynthesisError(`inference failed: ${e.message}`, "INFER_FAIL", e);
    }
    const { answer, citations } = extractCitations(resp.text);
    return {
      answer,
      citations,
      raw_response: resp.text,
      duration_ms: performance.now() - t0,
    };
  }
}

export function trimToBudget(leaves, totalCharBudget = TOTAL_CHAR_BUDGET) {
  let used = 0;
  const out = [];
  for (const leaf of leaves) {
    const len = (leaf.text || "").length;
    if (used + len > totalCharBudget) {
      const remaining = Math.max(0, totalCharBudget - used);
      if (remaining > 200) {
        out.push({ ...leaf, text: leaf.text.slice(0, remaining) });
        used = totalCharBudget;
      }
      break;
    }
    out.push(leaf);
    used += len;
  }
  return out;
}
