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
  // Match "Sources:" at the start of the string, after a newline, or after
  // sentence punctuation. Small models often inline the line instead of
  // putting it on its own line; accept both shapes.
  const re = /(?:^|\n|[.!?]\s+)Sources:\s*/i;
  const match = re.exec(response);
  if (!match) return { answer: response.trim(), citations: [] };
  const splitAt = match.index + match[0].length;
  const headEnd = match.index + (match[0].startsWith("\n") || match.index === 0 ? 0 : 1);
  const answer = response.slice(0, headEnd).trim();
  const sourcesLine = response.slice(splitAt).trim();
  const citations = [];
  // Strategy 1: anchored on [node_id] brackets. Each citation is the run of
  // text up to and including the next `[...]`. This is robust to commas
  // inside section titles.
  const bracketPattern = /([^\[]*?)\[([^\]]+)\]/g;
  let consumed = 0;
  let bm;
  while ((bm = bracketPattern.exec(sourcesLine)) !== null) {
    const titleRaw = bm[1].replace(/^[,;\s]+|[,;.\s]+$/g, "").trim();
    const nodeId = bm[2].trim();
    citations.push({ section: titleRaw || nodeId, node_id: nodeId, page: null });
    consumed = bm.index + bm[0].length;
  }
  // Strategy 2: page-citations like "Title p3, Title p7-8". Only fall through
  // when no bracketed citations were extracted, to avoid double-counting.
  if (citations.length === 0) {
    const items = sourcesLine.split(/[,;](?![^\[]*\])\s+/);
    for (const raw of items) {
      const item = raw.replace(/[.;]\s*$/, "").trim();
      if (!item) continue;
      const pageMatch = /(.+?)\s+(?:p|pp|pages?)\.?\s*([\d-]+)/i.exec(item);
      if (pageMatch) {
        citations.push({ section: pageMatch[1].trim(), page: pageMatch[2].trim() });
      } else {
        citations.push({ section: item, page: null });
      }
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
