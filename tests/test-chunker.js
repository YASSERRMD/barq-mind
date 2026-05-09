import { run, assert, assertEq } from "./runner.js";
import {
  chunkMarkdown,
  chunkPlainText,
  chunkPagedDocument,
  estimateTokens,
  splitBySentences,
} from "../src/chunker.js";

function flattenChildren(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.shift();
    out.push(node);
    for (const c of node.children || []) stack.push(c);
  }
  return out;
}

export async function runChunkerTests() {
  await run("chunker: estimateTokens approximates char/4", () => {
    assertEq(estimateTokens("aaaa"), 1);
    assertEq(estimateTokens("a".repeat(20)), 5);
    assertEq(estimateTokens(""), 0);
  });

  await run("chunker: splitBySentences groups under target size", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const out = splitBySentences(text, 100, 200);
    assert(out.length >= 1, "should produce at least one chunk");
    assert(out.join(" ").includes("First sentence"), "preserves content");
  });

  await run("chunker: markdown with H1, H2, H3 produces 3-level tree", () => {
    const md = `# Title\n\nIntro paragraph here.\n\n## Section A\n\nA body.\n\n### Sub A1\n\nSub body.\n\n## Section B\n\nB body.\n`;
    const root = chunkMarkdown(md);
    // root has H1 child, H1 has Section A, Section B; Section A has Sub A1.
    assert(root.children.length >= 1, "root should have an H1 child");
    const h1 = root.children[0];
    assertEq(h1.title, "Title", "h1 title");
    const sectionTitles = h1.children.filter((c) => c.level === 2).map((c) => c.title);
    assertEq(sectionTitles, ["Section A", "Section B"]);
  });

  await run("chunker: markdown without headings produces flat leaves", () => {
    const md = "Just some text.\n\nAnother paragraph.\n\nA third paragraph.";
    const root = chunkMarkdown(md);
    const all = flattenChildren(root);
    const leaves = all.filter((n) => n.level === "leaf");
    assertEq(leaves.length, 3, "three paragraph leaves");
  });

  await run("chunker: leaf char offsets match original text", () => {
    const md = "# A\n\nFirst paragraph here.\n\n## B\n\nSecond paragraph here.\n";
    const root = chunkMarkdown(md);
    const leaves = flattenChildren(root).filter((n) => n.level === "leaf");
    for (const leaf of leaves) {
      const slice = md.slice(leaf.char_start, leaf.char_end);
      assertEq(slice, leaf.text, `mismatch at ${leaf.char_start}-${leaf.char_end}`);
    }
  });

  await run("chunker: plain text 5000 chars produces multiple chunks under budget", () => {
    const text = ("Sentence number X is here. ").repeat(180);
    const chunks = chunkPlainText(text, { targetChars: 1600, maxChars: 3200 });
    assert(chunks.length >= 2, `expected 2+ chunks, got ${chunks.length}`);
    for (const c of chunks) {
      assert(c.text.length <= 3500, `chunk too large: ${c.text.length}`);
    }
  });

  await run("chunker: page-aware preserves page numbers per chunk", () => {
    const pages = [
      { page_number: 1, text: "Short page one." },
      { page_number: 2, text: "Short page two." },
    ];
    const chunks = chunkPagedDocument(pages);
    assertEq(chunks.length, 2, "two page nodes");
    assertEq(chunks[0].page_start, 1);
    assertEq(chunks[0].page_end, 1);
    assertEq(chunks[1].page_start, 2);
  });

  await run("chunker: page-aware splits oversized pages into leaves", () => {
    const big = ("This is a sentence that fills the page. ").repeat(150);
    const pages = [{ page_number: 5, text: big }];
    const chunks = chunkPagedDocument(pages, { targetChars: 800, maxChars: 1600 });
    assertEq(chunks.length, 1, "one page node");
    const page = chunks[0];
    assert(page.children.length >= 2, `expected leaf split, got ${page.children.length}`);
    for (const leaf of page.children) {
      assertEq(leaf.page_start, 5);
      assertEq(leaf.page_end, 5);
    }
  });
}
