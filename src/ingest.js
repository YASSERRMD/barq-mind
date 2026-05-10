// Document ingestion. Converts chunk trees from chunker.js into NodeRecord
// subtrees attached to the Corpus. Summaries remain empty until Phase 7.

import { chunkMarkdown, chunkPlainText, chunkPagedDocument } from "./chunker.js";
import { makeNode, nodeId } from "./tree.js";
import { extractPdfPages } from "./pdf-loader.js";

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
  const idParts = isLeaf
    ? { doc: docId, leaf: nextLeafIndex(corpus, docId) }
    : { doc: docId, sec: nextSectionPath(corpus, docId, depth) };
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

// Per-doc monotonic section counter. The previous (parentId, depth) keying
// produced "${depth}.${counter}" strings that collided across cousins
// (e.g. the first H3 under H2-A and the first H3 under H2-B both returned
// "3.1"), and upsertNode silently overwrote one with the other. Using a
// single counter per doc gives every section a unique identifier while
// preserving depth as a hint in the returned string.
const sectionCounters = new Map();
function nextSectionPath(corpus, docId, depth) {
  const key = `${corpus.name}:${docId}`;
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

export async function ingestPlainText(corpus, opts) {
  const { title, text } = opts;
  const docId = opts.docId || genDocId();
  const leaves = chunkPlainText(text);
  const docRootId = nodeId({ doc: docId, root: "root" });

  const childIds = [];
  for (const leaf of leaves) {
    const id = nodeId({ doc: docId, leaf: nextLeafIndex(corpus, docId) });
    const node = makeNode({
      node_id: id,
      doc_id: docId,
      parent_id: docRootId,
      title: leaf.title || "Untitled",
      level: "leaf",
      child_ids: [],
      span: [leaf.char_start, leaf.char_end],
      is_leaf: true,
    });
    corpus.tree.upsertNode(node);
    childIds.push(id);
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

export async function ingestPaged(corpus, opts) {
  const { title, pages } = opts;
  const docId = opts.docId || genDocId();
  const concatenated = pages.map((p) => p.text || "").join("\n");
  const pageNodes = chunkPagedDocument(pages);
  const docRootId = nodeId({ doc: docId, root: "root" });

  const pageIds = [];
  for (const pageChunk of pageNodes) {
    const pageId = nodeId({ doc: docId, page: pageChunk.page_start });
    const leafIds = [];
    if (pageChunk.children && pageChunk.children.length > 0) {
      for (const leaf of pageChunk.children) {
        const lid = nodeId({ doc: docId, page: pageChunk.page_start, leaf: nextLeafIndex(corpus, docId) });
        const leafNode = makeNode({
          node_id: lid,
          doc_id: docId,
          parent_id: pageId,
          title: leaf.title || "Untitled",
          level: "leaf",
          child_ids: [],
          span: [leaf.char_start, leaf.char_end],
          page_start: leaf.page_start,
          page_end: leaf.page_end,
          is_leaf: true,
        });
        corpus.tree.upsertNode(leafNode);
        leafIds.push(lid);
      }
    } else {
      const lid = nodeId({ doc: docId, page: pageChunk.page_start, leaf: nextLeafIndex(corpus, docId) });
      const leafNode = makeNode({
        node_id: lid,
        doc_id: docId,
        parent_id: pageId,
        title: pageChunk.title,
        level: "leaf",
        child_ids: [],
        span: [pageChunk.char_start, pageChunk.char_end],
        page_start: pageChunk.page_start,
        page_end: pageChunk.page_end,
        is_leaf: true,
      });
      corpus.tree.upsertNode(leafNode);
      leafIds.push(lid);
    }
    const pageNode = makeNode({
      node_id: pageId,
      doc_id: docId,
      parent_id: docRootId,
      title: pageChunk.title,
      level: "page",
      child_ids: leafIds,
      page_start: pageChunk.page_start,
      page_end: pageChunk.page_end,
      is_leaf: false,
    });
    corpus.tree.upsertNode(pageNode);
    pageIds.push(pageId);
  }

  const docRoot = makeNode({
    node_id: docRootId,
    doc_id: docId,
    parent_id: corpus.tree.rootId,
    title,
    level: "document",
    child_ids: pageIds,
    is_leaf: false,
  });
  corpus.tree.upsertNode(docRoot);

  await corpus.addDocument({
    docId,
    title,
    subtreeRoot: docRoot,
    rawText: concatenated,
  });
  return docRoot;
}

export async function ingestPDF(corpus, opts) {
  const { title, content, onProgress } = opts;
  if (!(content instanceof ArrayBuffer) && !ArrayBuffer.isView(content)) {
    throw new Error("ingestPDF: content must be ArrayBuffer");
  }
  const buffer = content instanceof ArrayBuffer ? content : content.buffer;
  const pages = await extractPdfPages(buffer, { onProgress });
  return ingestPaged(corpus, {
    docId: opts.docId,
    title,
    pages,
  });
}
