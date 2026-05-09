import { run, assert } from "./runner.js";
import {
  promptRoutingSummary,
  promptFullSummary,
  promptKeywords,
  promptNavigate,
  promptSynthesize,
  NAVIGATE_SYSTEM,
  SYNTHESIZE_SYSTEM,
} from "../src/prompts.js";

function joinContent(messages) {
  return messages.map((m) => `[${m.role}] ${m.content}`).join("\n\n");
}

export async function runPromptTests() {
  await run("prompts: routing summary contains node title and child context", () => {
    const msgs = promptRoutingSummary(
      { title: "Implementation Timeline", level: "section" },
      [
        { title: "Phase 1", snippet: "disclosure activation" },
        { title: "Phase 2", snippet: "pricing activation" },
      ]
    );
    const text = joinContent(msgs);
    assert(msgs[0].role === "system", "first must be system");
    assert(text.includes("Implementation Timeline"), "missing title");
    assert(text.includes("Phase 1"), "missing child");
    assert(text.includes("disclosure activation"), "missing snippet");
  });

  await run("prompts: full summary uses fullText for leaves", () => {
    const msgs = promptFullSummary(
      { title: "Leaf", level: "leaf" },
      [],
      "This is the body of the leaf paragraph."
    );
    const text = joinContent(msgs);
    assert(text.includes("This is the body"), "leaf text missing");
    assert(text.includes("leaf"), "leaf framing missing");
  });

  await run("prompts: keywords prompt asks for JSON array", () => {
    const msgs = promptKeywords("Some long text about carbon policy.");
    const text = joinContent(msgs);
    assert(text.includes("JSON"), "should mention JSON");
    assert(text.includes("[\"phrase one\""), "should show output format");
  });

  await run("prompts: navigate exports system schema with all four actions", () => {
    assert(NAVIGATE_SYSTEM.includes("'descend'"), "missing descend");
    assert(NAVIGATE_SYSTEM.includes("'select_leaves'"), "missing select_leaves");
    assert(NAVIGATE_SYSTEM.includes("'bm25_fallback'"), "missing bm25_fallback");
    assert(NAVIGATE_SYSTEM.includes("'widen'"), "missing widen");
  });

  await run("prompts: navigate includes query, current node, candidate ids", () => {
    const msgs = promptNavigate(
      "What is the implementation timeline?",
      {
        node_id: "doc:abc/root",
        title: "Carbon Policy",
        level: "document",
        summary: "Synthetic policy brief.",
      },
      [
        {
          node_id: "doc:abc/sec:timeline",
          title: "Implementation Timeline",
          routing_summary: "Five phases from disclosure to checkpoint review.",
          level: "section",
          is_leaf: false,
        },
        {
          node_id: "doc:abc/sec:risk",
          title: "Risk Assessment",
          routing_summary: "Six risk categories with mitigations.",
          level: "section",
          is_leaf: false,
        },
      ]
    );
    const text = joinContent(msgs);
    assert(text.includes("What is the implementation timeline?"), "missing query");
    assert(text.includes("doc:abc/sec:timeline"), "missing candidate id");
    assert(text.includes("doc:abc/sec:risk"), "missing second candidate id");
    assert(text.includes("Carbon Policy"), "missing current node title");
  });

  await run("prompts: synthesize includes excerpt blocks and pages", () => {
    assert(SYNTHESIZE_SYSTEM.includes("Insufficient evidence"), "missing fallback string");
    const msgs = promptSynthesize(
      "What is phase 2?",
      [
        {
          node_id: "leaf-1",
          title: "Phase 2: Pricing Activation",
          page_start: 4,
          page_end: 4,
          text: "Year 2 introduces the graduated carbon adjustment fee at the entry rate of 12 synthetic units per ton.",
        },
      ],
      [{ title: "Implementation Timeline" }]
    );
    const text = joinContent(msgs);
    assert(text.includes("Phase 2: Pricing Activation"), "missing leaf title");
    assert(text.includes("p4"), "missing page reference");
    assert(text.includes("Sources:"), "missing sources instruction");
    assert(text.includes("What is phase 2?"), "missing query");
  });

  await run("prompts: synthesize falls back to node_id when no pages", () => {
    const msgs = promptSynthesize(
      "Q",
      [{ node_id: "node-x", title: "Some Section", page_start: null, text: "body" }],
      []
    );
    const text = joinContent(msgs);
    assert(text.includes("[node-x]"), "missing node_id fallback in citation");
  });
}
