# Sample Corpus

This folder ships test material that the prototype loads on demand from the UI. Everything here is fully synthetic. None of these documents are factual, and none should be cited as evidence outside of testing barq-mind itself.

## carbon-policy.md

A 2,000-word fictional policy brief structured around six top-level sections (Executive Summary, Background, Policy Recommendations, Implementation Timeline, Risk Assessment, Monitoring and Evaluation, Conclusion) with H3 subsections, lists, and inline references.

The document is designed to give the chunker, summarizer, and navigator something realistic to work with: clear hierarchy, distinguishable sections, repeated terminology, multiple tables of contents the navigator can fail on, and a few near-duplicate phrases that test BM25 fallback discrimination.

The sample is deliberately self-flagging: every section disclaims that the figures and stakeholders are invented.

## eval-set.json

17 hand-authored questions over `carbon-policy.md`, each with `expected_phrases` that any correct answer must contain. The format is documented in [../docs/EVAL.md](../docs/EVAL.md).

The harness consumes this file via `fetch("samples/eval-set.json")`. To add new items:

1. Read the source document and pick a sentence with unambiguous meaning.
2. Write a question that only that sentence can answer.
3. Add 1-3 substring phrases that any correct answer must mention.
4. Run the eval to confirm the item is reachable.

## Adding new sample documents

The UI's **Sample** button only loads `carbon-policy.md`. To add another fixed sample, drop a Markdown file here and either:

- Use **Upload** in the UI to ingest it, or
- Wire a new button in `src/app.js` that fetches it.

For PDFs, **Upload** handles them via pdf.js. Keep them under 10 MB for the prototype.
