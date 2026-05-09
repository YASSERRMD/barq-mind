import { run, assert, assertEq } from "./runner.js";
import { Corpus } from "../src/db.js";
import { Tree, makeNode, nodeId } from "../src/tree.js";
import { summarizeTree, loadCache, cacheStats } from "../src/builder.js";

const TEST_CORPUS = "test-builder";

class MockInference {
  constructor(modelId = "mock-model") {
    this.modelId = modelId;
    this.calls = 0;
  }
  async chat(messages, opts) {
    this.calls++;
    const userMsg = messages.find((m) => m.role === "user")?.content || "";
    if (userMsg.includes("JSON array")) {
      return { text: '["alpha", "beta"]', raw_tokens: 10, stopped_at: "natural", duration_ms: 1 };
    }
    if (userMsg.includes("table of contents")) {
      return { text: "A short routing summary.", raw_tokens: 6, stopped_at: "natural", duration_ms: 1 };
    }
    return { text: "A longer summary describing the contents.", raw_tokens: 8, stopped_at: "natural", duration_ms: 1 };
  }
}

async function freshCorpus() {
  const corpus = await Corpus.open(TEST_CORPUS);
  await corpus.storage.clear();
  return Corpus.open(TEST_CORPUS);
}

function buildSmallSubtree(corpus) {
  const docId = "small";
  const docRootId = nodeId({ doc: docId, root: "root" });
  const sec1 = nodeId({ doc: docId, sec: "1" });
  const sec2 = nodeId({ doc: docId, sec: "2" });
  const leafA = nodeId({ doc: docId, leaf: "a" });
  const leafB = nodeId({ doc: docId, leaf: "b" });
  const leafC = nodeId({ doc: docId, leaf: "c" });

  const corpusRoot = corpus.tree.getRoot();
  corpusRoot.child_ids.push(docRootId);

  const docRoot = makeNode({
    node_id: docRootId,
    doc_id: docId,
    parent_id: corpus.tree.rootId,
    title: "Small Doc",
    level: "document",
    child_ids: [sec1, sec2],
    is_leaf: false,
  });
  const s1 = makeNode({
    node_id: sec1,
    doc_id: docId,
    parent_id: docRootId,
    title: "Section 1",
    level: "section",
    child_ids: [leafA, leafB],
    is_leaf: false,
  });
  const s2 = makeNode({
    node_id: sec2,
    doc_id: docId,
    parent_id: docRootId,
    title: "Section 2",
    level: "section",
    child_ids: [leafC],
    is_leaf: false,
  });
  const la = makeNode({
    node_id: leafA,
    doc_id: docId,
    parent_id: sec1,
    title: "Leaf A",
    level: "leaf",
    span: [0, 20],
    is_leaf: true,
  });
  const lb = makeNode({
    node_id: leafB,
    doc_id: docId,
    parent_id: sec1,
    title: "Leaf B",
    level: "leaf",
    span: [21, 40],
    is_leaf: true,
  });
  const lc = makeNode({
    node_id: leafC,
    doc_id: docId,
    parent_id: sec2,
    title: "Leaf C",
    level: "leaf",
    span: [41, 60],
    is_leaf: true,
  });
  for (const n of [docRoot, s1, s2, la, lb, lc]) corpus.tree.upsertNode(n);
  corpus.tree.docIndex[docId] = { title: "Small Doc", root_id: docRootId, ingested_at: Date.now() };
  return docRoot;
}

export async function runBuilderTests() {
  await run("builder: summarizeTree fills routing_summary, summary, keywords on every node", async () => {
    const corpus = await freshCorpus();
    buildSmallSubtree(corpus);
    const rawText = "alpha leaf one body. beta leaf two body. gamma leaf three body. extra";
    await corpus.storage.writeBlob("raw/small.txt", new Blob([rawText]));
    const mock = new MockInference();
    await summarizeTree(corpus.tree, corpus, mock);
    let allSet = true;
    corpus.tree.walk((node) => {
      if (node.level === "corpus") return;
      if (!node.routing_summary || !node.summary) {
        allSet = false;
      }
    });
    assert(allSet, "all non-corpus nodes should have routing+summary");
  });

  await run("builder: re-running with cache hits makes zero LLM calls", async () => {
    const corpus = await freshCorpus();
    buildSmallSubtree(corpus);
    const rawText = "alpha leaf one body. beta leaf two body. gamma leaf three body. extra";
    await corpus.storage.writeBlob("raw/small.txt", new Blob([rawText]));
    const mock = new MockInference();
    await summarizeTree(corpus.tree, corpus, mock);
    const firstCalls = mock.calls;
    assert(firstCalls > 0, "first run should call");
    await summarizeTree(corpus.tree, corpus, mock);
    assertEq(mock.calls, firstCalls, "second run should hit cache, no extra calls");
  });

  await run("builder: cache survives across corpus reopen", async () => {
    const corpus = await freshCorpus();
    buildSmallSubtree(corpus);
    const rawText = "alpha leaf one body. beta leaf two body. gamma leaf three body. extra";
    await corpus.storage.writeBlob("raw/small.txt", new Blob([rawText]));
    const mock = new MockInference();
    await summarizeTree(corpus.tree, corpus, mock);
    const cache = await loadCache(corpus.storage, mock.modelId);
    const stats = cacheStats(cache);
    assert(stats.entryCount > 0, "cache should have entries");
    const reopened = await Corpus.open(TEST_CORPUS);
    const cache2 = await loadCache(reopened.storage, mock.modelId);
    assertEq(Object.keys(cache2.entries).length, stats.entryCount, "cache count after reopen");
  });

  await run("builder: cache invalidates on model change", async () => {
    const corpus = await freshCorpus();
    buildSmallSubtree(corpus);
    const rawText = "alpha leaf one body. beta leaf two body. gamma leaf three body. extra";
    await corpus.storage.writeBlob("raw/small.txt", new Blob([rawText]));
    await summarizeTree(corpus.tree, corpus, new MockInference("mock-A"));
    const cacheB = await loadCache(corpus.storage, "mock-B");
    assertEq(Object.keys(cacheB.entries).length, 0, "different model ID should yield empty cache");
  });
}
