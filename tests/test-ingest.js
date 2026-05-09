import { run, assert, assertEq } from "./runner.js";
import { Corpus } from "../src/db.js";
import { ingestMarkdown, ingestPlainText, ingestPaged } from "../src/ingest.js";

const TEST_CORPUS = "test-ingest";

async function freshCorpus() {
  const corpus = await Corpus.open(TEST_CORPUS);
  await corpus.storage.clear();
  // Re-open to recreate the tree.
  return Corpus.open(TEST_CORPUS);
}

async function loadSample() {
  const res = await fetch("samples/carbon-policy.md");
  return await res.text();
}

export async function runIngestTests() {
  await run("ingest: markdown ingestion of carbon-policy produces 30+ nodes", async () => {
    const corpus = await freshCorpus();
    const text = await loadSample();
    const docRoot = await ingestMarkdown(corpus, { title: "Carbon Policy", text });
    const stats = corpus.tree.stats();
    assert(stats.nodeCount >= 30, `expected 30+ nodes, got ${stats.nodeCount}`);
    assert(stats.leafCount >= 15, `expected 15+ leaves, got ${stats.leafCount}`);
    assert(docRoot.level === "document", "doc root should be document level");
  });

  await run("ingest: leaf spans return original text via getRawText", async () => {
    const corpus = await freshCorpus();
    const text = await loadSample();
    await ingestMarkdown(corpus, { title: "Carbon Policy", text });
    const leaves = [];
    corpus.tree.walkLeaves((leaf) => leaves.push(leaf));
    assert(leaves.length > 5, "should have leaves");
    const sample = leaves[0];
    const got = await corpus.getRawText(sample.doc_id, sample.span);
    const direct = text.slice(sample.span[0], sample.span[1]);
    assertEq(got, direct, "raw text mismatch");
  });

  await run("ingest: docIndex registers the document", async () => {
    const corpus = await freshCorpus();
    const text = await loadSample();
    await ingestMarkdown(corpus, { title: "Carbon Policy", text });
    const docs = corpus.listDocuments();
    assertEq(docs.length, 1, "should have one document");
    assertEq(docs[0].title, "Carbon Policy");
    assert(docs[0].leafCount > 0, "leaf count should be positive");
  });

  await run("ingest: persistence survives reopening the corpus", async () => {
    const corpus = await freshCorpus();
    const text = await loadSample();
    await ingestMarkdown(corpus, { title: "Carbon Policy", text });
    const stats1 = corpus.tree.stats();
    const reopened = await Corpus.open(TEST_CORPUS);
    const stats2 = reopened.tree.stats();
    assertEq(stats2.nodeCount, stats1.nodeCount, "node count after reopen");
    assertEq(stats2.leafCount, stats1.leafCount, "leaf count after reopen");
  });

  await run("ingest: plain text produces flat leaf list under document", async () => {
    const corpus = await freshCorpus();
    const text = ("This is sentence one. ").repeat(200);
    const docRoot = await ingestPlainText(corpus, { title: "Plain", text });
    const leafCount = corpus.tree.getLeaves(docRoot.node_id).length;
    assert(leafCount >= 2, `expected 2+ leaves, got ${leafCount}`);
  });

  await run("ingest: paged document creates page-level nodes with page numbers", async () => {
    const corpus = await freshCorpus();
    const pages = [
      { page_number: 1, text: "Short page one content." },
      { page_number: 2, text: "Short page two content." },
      { page_number: 3, text: "Short page three content." },
    ];
    const docRoot = await ingestPaged(corpus, { title: "Paged Doc", pages });
    const pageNodes = corpus.tree.getChildren(docRoot.node_id);
    assertEq(pageNodes.length, 3, "three page nodes");
    assertEq(pageNodes[0].page_start, 1);
    assertEq(pageNodes[2].page_start, 3);
  });

  await run("ingest: removeDocument clears subtree and raw blob", async () => {
    const corpus = await freshCorpus();
    const text = await loadSample();
    const docRoot = await ingestMarkdown(corpus, { title: "Carbon Policy", text });
    await corpus.removeDocument(docRoot.doc_id);
    assert(corpus.tree.getNode(docRoot.node_id) === null, "subtree gone");
    assertEq(corpus.listDocuments(), [], "doc index empty");
    const blob = await corpus.storage.readBlob(`raw/${docRoot.doc_id}.txt`);
    assert(blob === null, "raw blob removed");
  });
}
