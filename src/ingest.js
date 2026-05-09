// Document ingestion. Converts chunk trees from chunker.js into NodeRecord
// subtrees attached to the Corpus. Summaries remain empty until Phase 7.

import { chunkMarkdown } from "./chunker.js";
import { makeNode, nodeId } from "./tree.js";

let counter = 0;
function genDocId() {
  counter++;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

function chunkLevelFor(depth, isLeaf) {
  if (isLeaf) return "leaf";
  if (depth <= 1) return "section";
  if (depth === 2) return "subsection";
  return "subsection";
}

function attachChunk(corpus, docId, parentId, chunk, depth) {
  const isLeaf = !chunk.children || chunk.children.length === 0;
  const isSection = !isLeaf;
  const idParts = isLeaf
    ? { doc: docId, leaf: nextLeafIndex(corpus, docId) }
    : { doc: docId, sec: sectionPath(parentId, depth) };
  const id = nodeId(idParts);

  const childIds = [];
  if (!isLeaf) {
    for (const child of chunk.children) {
      const cid = attachChunk(corpus, docId, id, child, depth + 1);
      childIds.push(cid);
    }
  }

  const node = makeNode({
    node_id: id,
    doc_id: docId,
    parent_id: parentId,
    title: chunk.title || "Untitled",
    level: isLeaf ? "leaf" : chunkLevelFor(depth, false),
    child_ids: childIds,
    span: isLeaf ? [chunk.char_start, chunk.char_end] : null,
    page_start: chunk.page_start ?? null,
    page_end: chunk.page_end ?? null,
    is_leaf: isLeaf,
  });
  corpus.tree.upsertNode(node);
  return id;
}

const leafCounters = new Map();
function nextLeafIndex(corpus, docId) {
  const key = `${corpus.name}:${docId}`;
  const next = (leafCounters.get(key) || 0) + 1;
  leafCounters.set(key, next);
  return String(next);
}

const sectionCounters = new Map();
function sectionPath(parentId, depth) {
  const key = `${parentId}:${depth}`;
  const next = (sectionCounters.get(key) || 0) + 1;
  sectionCounters.set(key, next);
  return `${depth}.${next}`;
}

export async function ingestMarkdown(corpus, opts) {
  const { title, text } = opts;
  const docId = opts.docId || genDocId();
  const root = chunkMarkdown(text, { defaultTitle: title });

  const docRootId = nodeId({ doc: docId, root: "root" });
  const childIds = [];
  for (const child of root.children) {
    const cid = attachChunk(corpus, docId, docRootId, child, 1);
    childIds.push(cid);
  }
  const docRoot = makeNode({
    node_id: docRootId,
    doc_id: docId,
    parent_id: corpus.tree.rootId,
    title,
    level: "document",
    child_ids: childIds,
    is_leaf: false,
  });
  corpus.tree.upsertNode(docRoot);

  await corpus.addDocument({
    docId,
    title,
    subtreeRoot: docRoot,
    rawText: text,
  });
  return docRoot;
}
