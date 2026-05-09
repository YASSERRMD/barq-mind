// Corpus and CognitiveDB facade. The Corpus class owns the in-memory Tree
// and persists it through Storage. CognitiveDB will grow into the public API
// in Phase 8.

import { Storage } from "./storage.js";
import { Tree, makeNode } from "./tree.js";

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
