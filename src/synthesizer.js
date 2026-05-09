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
