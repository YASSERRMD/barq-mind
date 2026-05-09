# Prompt Catalog

Every LLM call in barq-mind goes through a template defined in `src/prompts.js`. This document records each template, its inputs, and the expected output shape. Reviewers and tuners should treat this file as the canonical reference.

All templates are pure functions: identical inputs always produce identical message arrays. The functions return `[{role, content}, ...]` ready for `InferenceEngine.chat()`.

## promptRoutingSummary(node, childContext)

Produces the 50-token routing summary that drives table-of-contents-style navigation decisions.

Inputs:

- `node`: the section being summarized. Must have `title`, `level`.
- `childContext`: array of `{title, snippet}` from already-summarized children.

Output: 1 to 3 sentences of plain prose. No bullets. No quoted framing. Around 50 tokens.

Example output: `"Outlines the proposed regional emissions trading system, declining cap, allocation method, and revenue use during phase 4 of implementation."`

## promptFullSummary(node, childContext, fullText)

Produces the longer chapter-style summary attached to internal nodes (and leaves, when leaf text is provided).

Inputs:

- `node`: section or leaf with `title`, `level`.
- `childContext`: array of `{title, snippet}` for internal nodes.
- `fullText`: the leaf text (when summarizing a leaf). Truncated to 6000 chars in the prompt.

Output: 200 to 300 tokens of plain prose covering scope, key claims, and notable specifics. No headings, no bullet lists.

## promptKeywords(text)

Extracts 3 to 8 distinctive keyword phrases from the given text.

Inputs:

- `text`: source text. Truncated to 4000 chars in the prompt.

Output: a JSON array of 1- to 4-word strings. Example: `["carbon adjustment fee", "facility-level disclosure", "modal-shift incentive"]`

## promptNavigate(query, currentNode, childOptions)

The phase-1 navigation call. Returns an action that the navigator parses.

Inputs:

- `query`: user question.
- `currentNode`: the node we are currently descending from (`node_id`, `title`, `summary`, `level`).
- `childOptions`: array of `{node_id, title, routing_summary, level, is_leaf}`.

Output: a single JSON object matching one of:

```json
{ "action": "descend", "child_ids": ["..."], "reason": "..." }
{ "action": "select_leaves", "leaf_ids": ["..."], "reason": "..." }
{ "action": "bm25_fallback", "query_terms": ["..."], "reason": "..." }
{ "action": "widen", "reason": "..." }
```

The system message is exported as `NAVIGATE_SYSTEM` so navigator.js can reuse it for retry prompts.

## promptSynthesize(query, leaves, navPath)

The phase-2 synthesis call. Produces the final answer plus a citation line.

Inputs:

- `query`: user question.
- `leaves`: array of `{node_id, title, page_start, page_end, text}`. The user-visible excerpt is truncated at 1500 chars per leaf in the prompt.
- `navPath`: array of `{title}` or strings tracing the root-to-frontier path; rendered as a breadcrumb.

Output: 2 to 4 sentences ending with a single `Sources:` line listing section titles with pages (or node_ids when pages are absent). If excerpts are insufficient, the model must respond with `"Insufficient evidence in the indexed sources."`.

The system message is exported as `SYNTHESIZE_SYSTEM` for reuse.

## Editing prompts

When changing a template:

1. Update the function in `src/prompts.js`.
2. Update this file with the new contract.
3. Update or add a snapshot test in `tests/test-prompts.js` that proves the rendered messages contain the structural elements (system role, schema language, IDs, query text).
