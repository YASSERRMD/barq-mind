import { run, assert, assertEq } from "./runner.js";
import { Tree, makeNode, nodeId, sha256 } from "../src/tree.js";

function buildSampleTree() {
  // 3-level tree: corpus root -> 2 documents -> 3 sections each -> 1-2 leaves each.
  // Total: 1 root + 2 docs + 6 sections + 8 leaves = 17 nodes.
  const tree = new Tree("corpus:default/root", new Map(), { corpusName: "default" });

  const root = makeNode({
    node_id: "corpus:default/root",
    doc_id: "_corpus",
    parent_id: null,
    title: "Corpus Root",
    level: "corpus",
    child_ids: ["doc:a/root", "doc:b/root"],
    is_leaf: false,
  });
  tree.upsertNode(root);

  for (const docKey of ["a", "b"]) {
    const docRoot = makeNode({
      node_id: `doc:${docKey}/root`,
      doc_id: docKey,
      parent_id: "corpus:default/root",
      title: `Document ${docKey}`,
      level: "document",
      child_ids: [`doc:${docKey}/sec:1`, `doc:${docKey}/sec:2`, `doc:${docKey}/sec:3`],
      is_leaf: false,
    });
    tree.upsertNode(docRoot);

    for (let s = 1; s <= 3; s++) {
      const leafCount = s === 2 ? 2 : 1;
      const leafIds = [];
      for (let l = 0; l < leafCount; l++) {
        leafIds.push(`doc:${docKey}/sec:${s}/leaf:${l}`);
      }
      const sec = makeNode({
        node_id: `doc:${docKey}/sec:${s}`,
        doc_id: docKey,
        parent_id: `doc:${docKey}/root`,
        title: `Section ${s}`,
        level: "section",
        child_ids: leafIds,
        is_leaf: false,
      });
      tree.upsertNode(sec);

      for (let l = 0; l < leafCount; l++) {
        const leaf = makeNode({
          node_id: `doc:${docKey}/sec:${s}/leaf:${l}`,
          doc_id: docKey,
          parent_id: `doc:${docKey}/sec:${s}`,
          title: `Leaf ${s}.${l}`,
          level: "leaf",
          child_ids: [],
          span: [0, 100],
          is_leaf: true,
        });
        tree.upsertNode(leaf);
      }
    }
  }
  return tree;
}

export async function runTreeTests() {
  await run("tree: nodeId builds deterministic ID with key:value segments", () => {
    assertEq(nodeId({ doc: "abc", sec: "1.2" }), "doc:abc/sec:1.2");
    assertEq(nodeId({ doc: "abc" }), "doc:abc");
  });

  await run("tree: nodeId sanitizes slashes in values", () => {
    assertEq(nodeId({ doc: "a/b" }), "doc:a_b");
  });

  await run("tree: makeNode validates required fields", () => {
    let threw = false;
    try {
      makeNode({ node_id: "", doc_id: "x", title: "t", level: "leaf" });
    } catch {
      threw = true;
    }
    assert(threw, "expected throw on empty node_id");
  });

  await run("tree: makeNode rejects invalid level", () => {
    let threw = false;
    try {
      makeNode({ node_id: "x", doc_id: "y", title: "t", level: "bogus" });
    } catch {
      threw = true;
    }
    assert(threw, "expected throw on invalid level");
  });

  await run("tree: makeNode infers is_leaf from child_ids", () => {
    const n = makeNode({ node_id: "x", doc_id: "y", title: "t", level: "leaf" });
    assert(n.is_leaf === true, "no children should be leaf");
    const m = makeNode({ node_id: "p", doc_id: "y", title: "t", level: "section", child_ids: ["x"] });
    assert(m.is_leaf === false, "with children should be non-leaf");
  });

  await run("tree: 17-node sample tree builds and stats are correct", () => {
    const tree = buildSampleTree();
    const s = tree.stats();
    assertEq(s.nodeCount, 17, "node count");
    assertEq(s.leafCount, 8, "leaf count");
    assertEq(s.maxDepth, 3, "max depth");
  });

  await run("tree: walk visits all nodes in DFS order", () => {
    const tree = buildSampleTree();
    const visited = [];
    tree.walk((node) => visited.push(node.node_id));
    assertEq(visited.length, 17, "visit count");
    assertEq(visited[0], "corpus:default/root", "first should be root");
  });

  await run("tree: walkLeaves visits only leaves", () => {
    const tree = buildSampleTree();
    const leaves = [];
    tree.walkLeaves((node) => leaves.push(node));
    assertEq(leaves.length, 8, "leaf count via walk");
    assert(leaves.every((l) => l.is_leaf), "all should be leaves");
  });

  await run("tree: getPath from leaf returns root-to-leaf chain", () => {
    const tree = buildSampleTree();
    const path = tree.getPath("doc:a/sec:2/leaf:1");
    assertEq(path.length, 4, "path length");
    assertEq(path[0].node_id, "corpus:default/root", "starts at root");
    assertEq(path[3].node_id, "doc:a/sec:2/leaf:1", "ends at leaf");
  });

  await run("tree: getLeaves(parentId) returns descendant leaves", () => {
    const tree = buildSampleTree();
    const leaves = tree.getLeaves("doc:a/root");
    assertEq(leaves.length, 4, "doc a leaf count");
  });

  await run("tree: getChildren returns ordered children", () => {
    const tree = buildSampleTree();
    const ch = tree.getChildren("doc:a/root").map((n) => n.node_id);
    assertEq(ch, ["doc:a/sec:1", "doc:a/sec:2", "doc:a/sec:3"]);
  });

  await run("tree: JSON roundtrip is identity", () => {
    const tree = buildSampleTree();
    const json = tree.toJSON();
    const restored = Tree.fromJSON(json);
    assertEq(restored.toJSON(), json, "roundtrip mismatch");
    assertEq(restored.stats().nodeCount, 17, "restored count");
  });

  await run("tree: removeSubtree drops node and descendants", () => {
    const tree = buildSampleTree();
    tree.removeSubtree("doc:a/sec:2");
    assert(tree.getNode("doc:a/sec:2") === null, "sec gone");
    assert(tree.getNode("doc:a/sec:2/leaf:0") === null, "leaf gone");
    const parent = tree.getNode("doc:a/root");
    assert(!parent.child_ids.includes("doc:a/sec:2"), "parent updated");
  });

  await run("tree: sha256 returns 64-char hex", async () => {
    const h = await sha256("hello");
    assertEq(h.length, 64, "hex length");
    assertEq(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
}
