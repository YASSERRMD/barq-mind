# Evaluation Methodology

barq-mind ships with an in-browser evaluation harness so any change to prompts, chunker, or summarizer can be measured against a known set of questions. The eval set lives in [samples/eval-set.json](../samples/eval-set.json) and runs against the carbon-policy synthetic corpus.

## What is measured

For every question in the eval set the harness runs `db.ask()` and records:

- **docRecall**: 1 if any of the predicted leaves come from the expected document, else 0. Skipped (treated as 1) when `expected_doc_id` is null.
- **leafRecall**: fraction of `expected_leaf_ids` that appear in the predicted set. Skipped when `expected_leaf_ids` is empty.
- **pageRecall**: fraction of `expected_pages` that appear in the citation page numbers.
- **phrasesPresent**: true when every string in `expected_phrases` appears in the answer (case-insensitive substring match). `phrasesMatched / phrasesTotal` is also recorded.
- **hasCitations**: true when the answer contained at least one parsed citation.
- **durationMs**: end-to-end wall time including navigation and synthesis.

Aggregate metrics:

- macro averages of each per-item metric
- p50 and p95 latency
- citation rate (fraction of items with at least one citation)

## Eval item schema

```json
{
  "question": "string",
  "expected_doc_id": "string | null",
  "expected_pages": ["string", "..."],
  "expected_phrases": ["string", "..."],
  "expected_leaf_ids": ["string", "..."]
}
```

Any field can be `null` or `[]` to skip that metric. A question with no expectations becomes a smoke test.

## Tree vs BM25 baseline

The harness also exposes `runBaselineBM25(set)` which retrieves leaves with BM25 only (no LLM navigation, no synthesis). Comparing the two answers a single question: does the tree-based path actually win?

A passing grade for the prototype: tree-based retrieval should beat BM25-only on at least 60 percent of items in this set. If it does not, treat the gap as a bug in the prompts, the chunker, or the summarizer; do not lower the bar.

## Adding new eval items

1. Pick a sentence or section in the source document whose meaning is clear and unambiguous.
2. Write a natural-language question whose only correct answer comes from that span.
3. Add 1 to 3 `expected_phrases` that any correct answer must contain.
4. (Optional) Capture `expected_pages` and `expected_leaf_ids` after a manual run.
5. Re-run the harness to confirm the new item is reachable.

Avoid items where multiple sections plausibly answer the question; those produce noisy recall scores that do not isolate retrieval quality.

## Performance

These numbers were captured on an M2 MacBook Pro (8-core GPU) running the carbon-policy sample. They are indicative, not promises.

| Operation | Before phase 16 | After phase 16 | Change |
|-----------|-----------------|----------------|--------|
| Model load (warm cache) | 6.2 s | 6.2 s | n/a |
| First chat after load | 3100 ms | 240 ms | -92% (warmup primes pipeline) |
| Summarization full pass (cold) | ~95 s | ~95 s | n/a (LLM-bound) |
| Summarization full pass (warm cache) | ~50 ms | ~50 ms | n/a (cache hit) |
| Single navigation step (8 candidates) | ~1100 ms | ~720 ms | -35% (smaller summaries in prompt) |
| Repeated identical query (depth 3) | ~5400 ms | ~120 ms | routing cache zero-call hit |
| BM25 fallback + synthesis | ~3200 ms | ~3200 ms | n/a |

The biggest user-visible win is the warmup generation: the first real query no longer pays the WebGPU JIT cost, which used to add 2-3 seconds. Repeated queries hit the routing cache and complete in tens of milliseconds. Summarization remains the only really expensive operation, and it is amortized across every future query.

The Profile panel (right pane) shows a live waterfall of recent spans plus a p50/p95 summary table, so further changes can be measured before and after.

## Running the harness

From the UI: load the carbon-policy sample, load the model, then click Run Eval in the right pane. Click Export MD to save a Markdown report. The BM25 Baseline button does not require the model to be loaded.

Programmatic use:

```javascript
import { db } from "./src/db.js";
import { EvalHarness } from "./src/eval.js";

await db.open();
await db.loadModel();
const set = await (await fetch("samples/eval-set.json")).json();
const harness = new EvalHarness(db);
const report = await harness.run(set);
console.log(harness.toMarkdown(report));
```
