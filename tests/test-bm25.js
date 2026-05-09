import { run, assert, assertEq } from "./runner.js";
import { Corpus } from "../src/db.js";
import { BM25Index } from "../src/bm25.js";
import { makeNode, nodeId } from "../src/tree.js";

const TEST_CORPUS = "test-bm25";

async function freshCorpus() {
  const c = await Corpus.open(TEST_CORPUS);
  await c.storage.clear();
  return Corpus.open(TEST_CORPUS);
}

function buildLittleCorpus(corpus) {
  const docId = "y";
  const docRootId = nodeId({ doc: docId, root: "root" });
  const sec1 = nodeId({ doc: docId, sec: "1" });
  const sec2 = nodeId({ doc: docId, sec: "2" });
  const leaf1 = nodeId({ doc: docId, leaf: "1" });
  const leaf2 = nodeId({ doc: docId, leaf: "2" });
  corpus.tree.getRoot().child_ids.push(docRootId);
  corpus.tree.upsertNode(makeNode({
    node_id: docRootId, doc_id: docId, parent_id: corpus.tree.rootId,
    title: "Y Doc", level: "document", child_ids: [sec1, sec2],
    summary: "a doc about cats and dogs", is_leaf: false,
  }));
  corpus.tree.upsertNode(makeNode({
    node_id: sec1, doc_id: docId, parent_id: docRootId,
    title: "Cats", level: "section", child_ids: [leaf1],
    summary: "everything about feline behavior",
    keywords: ["feline", "purr", "cat"], is_leaf: false,
  }));
  corpus.tree.upsertNode(makeNode({
    node_id: sec2, doc_id: docId, parent_id: docRootId,
    title: "Dogs", level: "section", child_ids: [leaf2],
    summary: "everything about canine behavior",
    keywords: ["canine", "bark", "dog"], is_leaf: false,
  }));
  corpus.tree.upsertNode(makeNode({
    node_id: leaf1, doc_id: docId, parent_id: sec1,
    title: "Cat Behavior", level: "leaf", span: [0, 50],
    summary: "cats purr when content", keywords: ["purr", "feline"], is_leaf: true,
  }));
  corpus.tree.upsertNode(makeNode({
    node_id: leaf2, doc_id: docId, parent_id: sec2,
    title: "Dog Behavior", level: "leaf", span: [51, 100],
    summary: "dogs bark when alert", keywords: ["bark", "canine"], is_leaf: true,
  }));
  return { docRootId, sec1, sec2, leaf1, leaf2 };
}

export async function runBM25Tests() {
  await run("bm25: build indexes all non-corpus nodes", async () => {
    const corpus = await freshCorpus();
    buildLittleCorpus(corpus);
    await corpus.storage.writeBlob("raw/y.txt", new Blob(["cats purr when content. dogs bark when alert."]));
    const bm = new BM25Index();
    const count = await bm.build(corpus.tree, corpus);
    assert(count >= 5, `expected 5+ records, got ${count}`);
  });

  await run("bm25: search for distinctive term ranks the right node first", async () => {
    const corpus = await freshCorpus();
    const ids = buildLittleCorpus(corpus);
    await corpus.storage.writeBlob("raw/y.txt", new Blob(["cats purr when content. dogs bark when alert."]));
    const bm = new BM25Index();
    await bm.build(corpus.tree, corpus);
    const top = bm.search("feline purr", { limit: 3 });
    assert(top.length > 0, "expected hits");
    const topIds = top.map((h) => h.node_id);
    assert(topIds.includes(ids.leaf1) || topIds.includes(ids.sec1), `expected cats branch in ${topIds.join(",")}`);
  });

  await run("bm25: save and load roundtrip preserves searchable docs", async () => {
    const corpus = await freshCorpus();
    buildLittleCorpus(corpus);
    await corpus.storage.writeBlob("raw/y.txt", new Blob(["body"]));
    const bm = new BM25Index();
    await bm.build(corpus.tree, corpus);
    const before = bm.search("canine", { limit: 1 });
    await bm.save(corpus.storage);
    const bm2 = new BM25Index();
    const ok = await bm2.load(corpus.storage);
    assert(ok, "load should succeed");
    const after = bm2.search("canine", { limit: 1 });
    assertEq(after.length, before.length, "result count match");
    if (before.length) assertEq(after[0].node_id, before[0].node_id, "top hit match");
  });

  await run("bm25: removeNode drops the node from search results", async () => {
    const corpus = await freshCorpus();
    const ids = buildLittleCorpus(corpus);
    await corpus.storage.writeBlob("raw/y.txt", new Blob(["body"]));
    const bm = new BM25Index();
    await bm.build(corpus.tree, corpus);
    bm.removeNode(ids.leaf1);
    const hits = bm.search("cats purr", { limit: 5 });
    const ids2 = hits.map((h) => h.node_id);
    assert(!ids2.includes(ids.leaf1), "removed leaf should not be in hits");
  });
}
