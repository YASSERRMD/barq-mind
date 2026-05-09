// Corpus and CognitiveDB facade. The Corpus class owns the in-memory Tree
// and persists it through Storage. CognitiveDB is the public API that the
// UI talks to.

import { Storage } from "./storage.js";
import { Tree, makeNode } from "./tree.js";
import { InferenceEngine } from "./inference.js";
import { summarizeTree, loadCache, cacheStats } from "./builder.js";
import { ingestMarkdown, ingestPlainText } from "./ingest.js";
import { Navigator } from "./navigator.js";
import { Synthesizer } from "./synthesizer.js";
import { BM25Index } from "./bm25.js";

const TREE_FILE = "tree";
const RAW_PREFIX = "raw";

export class Corpus {
  constructor(name, storage, tree) {
    this.name = name;
    this.storage = storage;
    this.tree = tree;
  }

  static async open(name = "default") {
    const storage = await new Storage().open(name);
    const json = await storage.readJSON(TREE_FILE);
    let tree;
    if (json) {
      tree = Tree.fromJSON(json);
    } else {
      tree = new Tree(`corpus:${name}/root`, new Map(), { corpusName: name });
      const root = makeNode({
        node_id: `corpus:${name}/root`,
        doc_id: "_corpus",
        parent_id: null,
        title: `Corpus: ${name}`,
        level: "corpus",
        child_ids: [],
      });
      tree.upsertNode(root);
    }
    return new Corpus(name, storage, tree);
  }

  async save() {
    await this.storage.writeJSON(TREE_FILE, this.tree.toJSON());
  }

  async addDocument({ docId, title, subtreeRoot, rawText, ingestedAt = Date.now() }) {
    if (!docId || !subtreeRoot) {
      throw new Error("addDocument: docId and subtreeRoot required");
    }
    if (this.tree.getNode(subtreeRoot.node_id)) {
      throw new Error(`addDocument: node ${subtreeRoot.node_id} already exists`);
    }
    const corpusRoot = this.tree.getRoot();
    if (!corpusRoot.child_ids.includes(subtreeRoot.node_id)) {
      corpusRoot.child_ids.push(subtreeRoot.node_id);
    }
    this.tree.docIndex[docId] = {
      title,
      root_id: subtreeRoot.node_id,
      ingested_at: ingestedAt,
    };
    if (rawText !== undefined) {
      const blob = new Blob([rawText], { type: "text/plain" });
      await this.storage.writeBlob(`${RAW_PREFIX}/${docId}.txt`, blob);
    }
    await this.save();
  }

  async removeDocument(docId) {
    const meta = this.tree.docIndex[docId];
    if (!meta) return;
    this.tree.removeSubtree(meta.root_id);
    delete this.tree.docIndex[docId];
    await this.storage.delete(`${RAW_PREFIX}/${docId}.txt`);
    await this.save();
  }

  listDocuments() {
    const out = [];
    for (const [docId, meta] of Object.entries(this.tree.docIndex)) {
      const subtreeRoot = this.tree.getNode(meta.root_id);
      const leafCount = subtreeRoot ? this.tree.getLeaves(meta.root_id).length : 0;
      out.push({
        docId,
        title: meta.title,
        ingestedAt: meta.ingested_at,
        leafCount,
      });
    }
    return out.sort((a, b) => b.ingestedAt - a.ingestedAt);
  }

  async getRawText(docId, span) {
    const blob = await this.storage.readBlob(`${RAW_PREFIX}/${docId}.txt`);
    if (!blob) return null;
    const text = await blob.text();
    if (!span) return text;
    return text.slice(span[0], span[1]);
  }
}

export class CognitiveError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "CognitiveError";
    this.code = code;
    this.cause = cause;
  }
}

const LOG_HOOK = { fn: null };

function log(level, ...args) {
  if (typeof LOG_HOOK.fn === "function") {
    try { LOG_HOOK.fn(level, ...args); } catch { /* ignore */ }
  }
  if (level === "error") console.error("[barq-mind]", ...args);
  else console.log("[barq-mind]", ...args);
}

export class CognitiveDB {
  constructor(name = "default") {
    this.name = name;
    this.corpus = null;
    this.inference = new InferenceEngine();
    this.bm25 = new BM25Index();
    this._bm25Loaded = false;
    this.opened = false;
  }

  static onLog(fn) { LOG_HOOK.fn = fn; }

  async open() {
    try {
      this.corpus = await Corpus.open(this.name);
      this.opened = true;
      this._bm25Loaded = await this.bm25.load(this.corpus.storage);
      log("info", "opened corpus", this.name, "bm25_loaded:", this._bm25Loaded);
    } catch (e) {
      throw new CognitiveError(`failed to open corpus: ${e.message}`, "OPEN_FAILED", e);
    }
  }

  async _ensureBM25() {
    if (this._bm25Loaded && this.bm25.size() > 0) return;
    log("info", "building BM25 index");
    await this.bm25.build(this.corpus.tree, this.corpus);
    await this.bm25.save(this.corpus.storage);
    this._bm25Loaded = true;
  }

  _ensureOpen() {
    if (!this.opened) throw new CognitiveError("CognitiveDB not opened; call open() first", "NOT_OPEN");
  }

  async loadModel(opts = {}) {
    this._ensureOpen();
    try {
      await this.inference.load(opts);
      log("info", "model loaded", this.inference.modelId, this.inference.dtype);
    } catch (e) {
      throw new CognitiveError(`failed to load model: ${e.message}`, "MODEL_LOAD_FAILED", e);
    }
  }

  listDocuments() {
    this._ensureOpen();
    return this.corpus.listDocuments();
  }

  async ingest(input) {
    this._ensureOpen();
    if (!input || typeof input !== "object") {
      throw new CognitiveError("ingest: input object required", "BAD_INPUT");
    }
    const { type, title, content } = input;
    if (!type || !title || content === undefined) {
      throw new CognitiveError("ingest: type, title, content required", "BAD_INPUT");
    }
    let docRoot;
    try {
      if (type === "markdown") {
        docRoot = await ingestMarkdown(this.corpus, { title, text: content });
      } else if (type === "text") {
        docRoot = await ingestPlainText(this.corpus, { title, text: content });
      } else if (type === "pdf") {
        throw new CognitiveError("PDF ingestion arrives in Phase 12", "NOT_YET");
      } else {
        throw new CognitiveError(`unknown ingest type: ${type}`, "BAD_INPUT");
      }
    } catch (e) {
      if (e instanceof CognitiveError) throw e;
      throw new CognitiveError(`ingest failed: ${e.message}`, "INGEST_FAILED", e);
    }
    log("info", "ingested", docRoot.doc_id, title);
    let summarizationStarted = false;
    if (this.inference.ready) {
      summarizationStarted = true;
      summarizeTree(this.corpus.tree, this.corpus, this.inference, {
        onProgress: (done, total, t) => log("info", `summarize ${done}/${total}: ${t}`),
      }).catch((e) => log("error", "summarization failed", e));
    }
    const leafCount = this.corpus.tree.getLeaves(docRoot.node_id).length;
    return { docId: docRoot.doc_id, leafCount, summarizationStarted };
  }

  async removeDocument(docId) {
    this._ensureOpen();
    const meta = this.corpus.tree.docIndex[docId];
    const subtreeNodeIds = [];
    if (meta) {
      const root = this.corpus.tree.getNode(meta.root_id);
      if (root) {
        const stack = [root];
        while (stack.length) {
          const cur = stack.pop();
          subtreeNodeIds.push(cur.node_id);
          for (const cid of cur.child_ids) {
            const c = this.corpus.tree.getNode(cid);
            if (c) stack.push(c);
          }
        }
      }
    }
    await this.corpus.removeDocument(docId);
    for (const id of subtreeNodeIds) this.bm25.removeNode(id);
    if (this._bm25Loaded) await this.bm25.save(this.corpus.storage);
    log("info", "removed document", docId);
  }

  async navigate(query, opts = {}) {
    this._ensureOpen();
    if (!this.inference.ready) {
      throw new CognitiveError("model not loaded; call loadModel() first", "MODEL_NOT_LOADED");
    }
    const nav = new Navigator(this, this.inference);
    return await nav.navigate(query, opts);
  }

  async ask(query, opts = {}) {
    this._ensureOpen();
    if (!this.inference.ready) {
      throw new CognitiveError("model not loaded; call loadModel() first", "MODEL_NOT_LOADED");
    }
    const t0 = performance.now();
    const navResult = await this.navigate(query, opts);
    let leafIds = navResult.selectedLeaves;
    let path = navResult.path;
    if (navResult.fallback) {
      log("info", "BM25 fallback path", navResult.query_terms);
      await this._ensureBM25();
      const hits = this.bm25.search(navResult.query_terms.join(" "), { limit: 5 });
      leafIds = hits.map((h) => h.node_id);
    }
    const synth = new Synthesizer(this, this.inference);
    const result = await synth.synthesize(query, leafIds, path);
    return {
      answer: result.answer,
      citations: result.citations,
      raw_response: result.raw_response,
      durationMs: performance.now() - t0,
      trace: navResult.traces,
      fallback: navResult.fallback || false,
      selectedLeaves: leafIds,
    };
  }

  async stats() {
    this._ensureOpen();
    const tree = this.corpus.tree.stats();
    const usage = await this.corpus.storage.usage();
    let cache = { entryCount: 0, model: null };
    try {
      const c = await loadCache(this.corpus.storage, this.inference.modelId);
      cache = cacheStats(c);
    } catch { /* ignore */ }
    return {
      corpus: this.name,
      tree,
      usageBytes: usage,
      docCount: this.listDocuments().length,
      inference: this.inference.stats(),
      cache,
    };
  }

  async exportJSON() {
    this._ensureOpen();
    const tree = this.corpus.tree.toJSON();
    const rawTexts = {};
    for (const docId of Object.keys(this.corpus.tree.docIndex)) {
      const blob = await this.corpus.storage.readBlob(`${RAW_PREFIX}/${docId}.txt`);
      if (blob) rawTexts[docId] = await blob.text();
    }
    let cache = null;
    try {
      cache = await loadCache(this.corpus.storage, this.inference.modelId);
    } catch { /* ignore */ }
    return { version: 1, corpus: this.name, tree, rawTexts, cache };
  }

  async importJSON(json) {
    this._ensureOpen();
    if (!json || json.version !== 1 || !json.tree) {
      throw new CognitiveError("import: invalid JSON shape", "BAD_INPUT");
    }
    await this.corpus.storage.clear();
    this.corpus = await Corpus.open(this.name);
    this.corpus.tree = Tree.fromJSON(json.tree);
    for (const [docId, text] of Object.entries(json.rawTexts || {})) {
      await this.corpus.storage.writeBlob(`${RAW_PREFIX}/${docId}.txt`, new Blob([text]));
    }
    if (json.cache) {
      await this.corpus.storage.writeJSON("summary-cache", json.cache);
    }
    await this.corpus.save();
    log("info", "imported corpus", this.name);
  }

  async reset() {
    this._ensureOpen();
    await this.corpus.storage.clear();
    this.corpus = await Corpus.open(this.name);
    log("info", "reset corpus", this.name);
  }
}

export const db = new CognitiveDB();
