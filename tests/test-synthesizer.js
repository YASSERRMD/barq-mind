import { run, assert, assertEq } from "./runner.js";
import { Corpus } from "../src/db.js";
import { Synthesizer, extractCitations, trimToBudget } from "../src/synthesizer.js";
import { makeNode, nodeId } from "../src/tree.js";

const TEST_CORPUS = "test-synth";

class CannedInference {
  constructor(text) { this.text = text; this.modelId = "canned"; this.ready = true; this.calls = 0; }
  async chat() {
    this.calls++;
    return { text: this.text, raw_tokens: 1, stopped_at: "natural", duration_ms: 1 };
  }
}

async function freshCorpus() {
  const c = await Corpus.open(TEST_CORPUS);
  await c.storage.clear();
  return Corpus.open(TEST_CORPUS);
}

async function setupLeaves(corpus) {
  const docId = "z";
  const docRootId = nodeId({ doc: docId, root: "root" });
  const leaf1 = nodeId({ doc: docId, leaf: "1" });
  const leaf2 = nodeId({ doc: docId, leaf: "2" });
  const text = "first leaf body content here. second leaf body content here.";
  await corpus.storage.writeBlob("raw/z.txt", new Blob([text]));

  corpus.tree.getRoot().child_ids.push(docRootId);
  corpus.tree.upsertNode(makeNode({
    node_id: docRootId, doc_id: docId, parent_id: corpus.tree.rootId,
    title: "Z", level: "document", child_ids: [leaf1, leaf2], is_leaf: false,
  }));
  corpus.tree.upsertNode(makeNode({
    node_id: leaf1, doc_id: docId, parent_id: docRootId,
    title: "First Leaf", level: "leaf", span: [0, 30], page_start: 1, page_end: 1, is_leaf: true,
  }));
  corpus.tree.upsertNode(makeNode({
    node_id: leaf2, doc_id: docId, parent_id: docRootId,
    title: "Second Leaf", level: "leaf", span: [31, 60], page_start: 2, page_end: 2, is_leaf: true,
  }));
  return { leaf1, leaf2 };
}

export async function runSynthesizerTests() {
  await run("synthesizer: extractCitations parses page-based sources", () => {
    const r = "The answer is 42.\n\nSources: Section A p3, Section B p7-8";
    const { answer, citations } = extractCitations(r);
    assertEq(answer, "The answer is 42.");
    assertEq(citations.length, 2);
    assertEq(citations[0].section, "Section A");
    assertEq(citations[0].page, "3");
    assertEq(citations[1].page, "7-8");
  });

  await run("synthesizer: extractCitations parses node_id sources", () => {
    const r = "Answer.\n\nSources: Some Title [doc:abc/leaf:5]";
    const { citations } = extractCitations(r);
    assertEq(citations.length, 1);
    assertEq(citations[0].node_id, "doc:abc/leaf:5");
  });

  await run("synthesizer: extractCitations returns empty when no Sources line", () => {
    const r = "Just an answer with no citations.";
    const { answer, citations } = extractCitations(r);
    assertEq(answer, "Just an answer with no citations.");
    assertEq(citations, []);
  });

  await run("synthesizer: trimToBudget caps total chars across leaves", () => {
    const big = "x".repeat(2000);
    const leaves = [
      { node_id: "a", text: big },
      { node_id: "b", text: big },
      { node_id: "c", text: big },
    ];
    const trimmed = trimToBudget(leaves, 4000);
    let total = 0;
    for (const l of trimmed) total += l.text.length;
    assert(total <= 4200, `expected <=4200 chars, got ${total}`);
  });

  await run("synthesizer: synthesize returns Insufficient evidence on empty leaves", async () => {
    const corpus = await freshCorpus();
    const inf = new CannedInference("ignored");
    const synth = new Synthesizer({ corpus }, inf);
    const result = await synth.synthesize("query", [], []);
    assert(result.answer.includes("Insufficient evidence"), "should be insufficient");
    assertEq(inf.calls, 0, "should not call inference");
  });

  await run("synthesizer: synthesize returns answer + citations", async () => {
    const corpus = await freshCorpus();
    const { leaf1, leaf2 } = await setupLeaves(corpus);
    const inf = new CannedInference(
      "Both leaves agree.\n\nSources: First Leaf p1, Second Leaf p2"
    );
    const synth = new Synthesizer({ corpus }, inf);
    const result = await synth.synthesize("q", [leaf1, leaf2], []);
    assert(result.answer.includes("Both leaves agree"), "answer captured");
    assertEq(result.citations.length, 2);
    assertEq(result.citations[0].section, "First Leaf");
    assertEq(result.citations[0].page, "1");
  });
}
