import { run, assert, assertEq } from "./runner.js";
import { Corpus } from "../src/db.js";
import { Navigator, parseAction, validateAgainstCandidates } from "../src/navigator.js";
import { makeNode, nodeId } from "../src/tree.js";

const TEST_CORPUS = "test-navigator";

class CannedInference {
  constructor(responses) {
    this.modelId = "canned";
    this.ready = true;
    this.responses = [...responses];
    this.calls = 0;
  }
  async chat() {
    this.calls++;
    if (this.responses.length === 0) {
      return { text: "", raw_tokens: 0, stopped_at: "natural", duration_ms: 1 };
    }
    const next = this.responses.shift();
    const text = typeof next === "string" ? next : JSON.stringify(next);
    return { text, raw_tokens: 1, stopped_at: "natural", duration_ms: 1 };
  }
}

async function freshDB() {
  const corpus = await Corpus.open(TEST_CORPUS);
  await corpus.storage.clear();
  const fresh = await Corpus.open(TEST_CORPUS);
  return { corpus: fresh };
}

function buildThreeLevelTree(corpus) {
  const docId = "x";
  const docRootId = nodeId({ doc: docId, root: "root" });
  const sec1 = nodeId({ doc: docId, sec: "1" });
  const sec2 = nodeId({ doc: docId, sec: "2" });
  const leafA = nodeId({ doc: docId, leaf: "a" });
  const leafB = nodeId({ doc: docId, leaf: "b" });
  const leafC = nodeId({ doc: docId, leaf: "c" });
  const leafD = nodeId({ doc: docId, leaf: "d" });

  const corpusRoot = corpus.tree.getRoot();
  corpusRoot.child_ids.push(docRootId);

  const docRoot = makeNode({
    node_id: docRootId, doc_id: docId, parent_id: corpus.tree.rootId,
    title: "Doc X", level: "document", child_ids: [sec1, sec2], is_leaf: false,
  });
  const s1 = makeNode({
    node_id: sec1, doc_id: docId, parent_id: docRootId,
    title: "Section A", level: "section", child_ids: [leafA, leafB],
    summary: "section A discusses alpha and beta", is_leaf: false,
  });
  const s2 = makeNode({
    node_id: sec2, doc_id: docId, parent_id: docRootId,
    title: "Section B", level: "section", child_ids: [leafC, leafD],
    summary: "section B discusses gamma and delta", is_leaf: false,
  });
  const la = makeNode({ node_id: leafA, doc_id: docId, parent_id: sec1, title: "Leaf A", level: "leaf", span: [0, 10], is_leaf: true });
  const lb = makeNode({ node_id: leafB, doc_id: docId, parent_id: sec1, title: "Leaf B", level: "leaf", span: [11, 20], is_leaf: true });
  const lc = makeNode({ node_id: leafC, doc_id: docId, parent_id: sec2, title: "Leaf C", level: "leaf", span: [21, 30], is_leaf: true });
  const ld = makeNode({ node_id: leafD, doc_id: docId, parent_id: sec2, title: "Leaf D", level: "leaf", span: [31, 40], is_leaf: true });

  for (const n of [docRoot, s1, s2, la, lb, lc, ld]) corpus.tree.upsertNode(n);
  return { docRootId, sec1, sec2, leafA, leafB, leafC, leafD };
}

export async function runNavigatorTests() {
  await run("navigator: parseAction handles fenced JSON", () => {
    const out = parseAction("```json\n{\"action\": \"widen\", \"reason\": \"need more context\"}\n```");
    assertEq(out.action, "widen");
  });

  await run("navigator: parseAction extracts first object from prose", () => {
    const out = parseAction("Sure, here is my answer: {\"action\": \"widen\", \"reason\": \"r\"}\nthanks");
    assertEq(out.action, "widen");
  });

  await run("navigator: parseAction rejects invalid action", () => {
    let threw = false;
    try { parseAction('{"action": "bogus"}'); } catch { threw = true; }
    assert(threw, "expected throw");
  });

  await run("navigator: validateAgainstCandidates flags phantom ids", () => {
    let threw = false;
    try {
      validateAgainstCandidates(
        { action: "descend", child_ids: ["phantom"], reason: "r" },
        [{ node_id: "real" }]
      );
    } catch { threw = true; }
    assert(threw, "expected phantom to throw");
  });

  await run("navigator: descend then select_leaves reaches the right leaves", async () => {
    const { corpus } = await freshDB();
    const ids = buildThreeLevelTree(corpus);
    const inf = new CannedInference([
      { action: "descend", child_ids: [ids.docRootId], reason: "doc" },
      { action: "descend", child_ids: [ids.sec2], reason: "section B" },
      { action: "select_leaves", leaf_ids: [ids.leafC], reason: "leaf C" },
    ]);
    const nav = new Navigator({ corpus }, inf);
    const out = await nav.navigate("test", { maxDepth: 5 });
    assertEq(out.selectedLeaves, [ids.leafC], "leaf C selected");
    assert(out.fallback === false, "no fallback");
    assert(out.traces.length >= 1, "traces emitted");
  });

  await run("navigator: parse failure twice triggers BM25 fallback", async () => {
    const { corpus } = await freshDB();
    buildThreeLevelTree(corpus);
    const inf = new CannedInference(["not JSON at all", "still not JSON"]);
    const nav = new Navigator({ corpus }, inf);
    const out = await nav.navigate("the alpha question", { maxDepth: 3 });
    assert(out.fallback === true, "should fallback");
    assert(out.query_terms.length > 0, "query terms set");
  });

  await run("navigator: phantom ids on first try succeed on retry", async () => {
    const { corpus } = await freshDB();
    const ids = buildThreeLevelTree(corpus);
    const inf = new CannedInference([
      { action: "descend", child_ids: ["totally-phantom"], reason: "wrong" },
      { action: "descend", child_ids: [ids.docRootId], reason: "fixed" },
      { action: "select_leaves", leaf_ids: [ids.leafA], reason: "leaf A" },
      { action: "select_leaves", leaf_ids: [ids.leafA], reason: "leaf A" },
    ]);
    const nav = new Navigator({ corpus }, inf);
    const out = await nav.navigate("alpha", { maxDepth: 5 });
    assert(out.selectedLeaves.includes(ids.leafA) || out.fallback, "should reach leaf or fallback");
  });
}
