// Corpus and CognitiveDB facade. The Corpus class owns the in-memory Tree
// and persists it through Storage. CognitiveDB is the public API that the
// UI talks to.

import { Storage } from "./storage.js";
import { Tree, makeNode } from "./tree.js";
import { InferenceEngine } from "./inference.js";
import { summarizeTree, loadCache, cacheStats } from "./builder.js";

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
    this.bm25 = null; // Phase 11 hook
    this.opened = false;
  }

  static onLog(fn) { LOG_HOOK.fn = fn; }

  async open() {
    try {
      this.corpus = await Corpus.open(this.name);
      this.opened = true;
      log("info", "opened corpus", this.name);
    } catch (e) {
      throw new CognitiveError(`failed to open corpus: ${e.message}`, "OPEN_FAILED", e);
    }
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
}
