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
