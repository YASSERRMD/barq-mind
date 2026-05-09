// Phase-1 navigation call. Parses, validates, and retries the LLM's structured
// action output. Falls back to BM25 search after two parse failures.

import { promptNavigate, NAVIGATE_SYSTEM } from "./prompts.js";

const ALLOWED_ACTIONS = new Set(["descend", "select_leaves", "bm25_fallback", "widen"]);

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
