// BM25 fallback index over leaf and internal-node summaries. The Navigator
// emits `bm25_fallback` actions when LLM-driven traversal can't find a path;
// db.ask() consults this index to recover candidate leaves.

import MiniSearch from "minisearch";

const BM25_FILE = "bm25";

const FIELDS = ["title", "summary", "text", "keywords"];
const STORE_FIELDS = ["node_id", "doc_id", "page_start", "page_end", "title"];

export class BM25Index {
  constructor() {
    this.ms = this._fresh();
  }

  _fresh() {
    return new MiniSearch({
      fields: FIELDS,
      storeFields: STORE_FIELDS,
      idField: "id",
      searchOptions: {
        boost: { title: 3, summary: 1.5, keywords: 2 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });
  }

  async build(tree, corpus) {
    this.ms = this._fresh();
    const records = [];
    for (const node of tree.nodesById.values()) {
      if (node.level === "corpus") continue;
      let text = "";
      if (node.is_leaf && node.span) {
        try {
          text = (await corpus.getRawText(node.doc_id, node.span)) || "";
        } catch { text = ""; }
      }
      records.push({
        id: node.node_id,
        node_id: node.node_id,
        doc_id: node.doc_id,
        title: node.title || "",
        summary: node.summary || "",
        text: text.slice(0, 4000),
        keywords: (node.keywords || []).join(" "),
        page_start: node.page_start,
        page_end: node.page_end,
      });
    }
    this.ms.addAll(records);
    return records.length;
  }

  search(query, opts = {}) {
    if (!query || (typeof query === "string" && query.trim().length === 0)) return [];
    const q = Array.isArray(query) ? query.join(" ") : query;
    const results = this.ms.search(q);
    const limit = opts.limit || 5;
    return results.slice(0, limit);
  }

  async addNode(node, text) {
    if (node.level === "corpus") return;
    const record = {
      id: node.node_id,
      node_id: node.node_id,
      doc_id: node.doc_id,
      title: node.title || "",
      summary: node.summary || "",
      text: (text || "").slice(0, 4000),
      keywords: (node.keywords || []).join(" "),
      page_start: node.page_start,
      page_end: node.page_end,
    };
    if (this.ms.has(node.node_id)) {
      this.ms.replace(record);
    } else {
      this.ms.add(record);
    }
  }

  removeNode(node_id) {
    if (this.ms.has(node_id)) {
      this.ms.discard(node_id);
    }
  }

  async save(storage) {
    const json = JSON.stringify(this.ms);
    await storage.writeJSON(BM25_FILE, { version: 1, payload: json });
  }

  async load(storage) {
    const wrapper = await storage.readJSON(BM25_FILE);
    if (!wrapper || !wrapper.payload) return false;
    try {
      this.ms = MiniSearch.loadJSON(wrapper.payload, {
        fields: FIELDS,
        storeFields: STORE_FIELDS,
        idField: "id",
        searchOptions: {
          boost: { title: 3, summary: 1.5, keywords: 2 },
          fuzzy: 0.2,
          prefix: true,
          combineWith: "OR",
        },
      });
      return true;
    } catch {
      this.ms = this._fresh();
      return false;
    }
  }

  size() {
    return this.ms.documentCount;
  }
}
