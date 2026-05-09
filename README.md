# barq-mind

A vector-free, hierarchical, LLM-navigated retrieval database that runs entirely in the browser. The Barq cognitive index, phase 0.

## What it is

barq-mind is a research prototype that validates one specific thesis: high-quality retrieval over long documents does not require dense vector embeddings. Instead, it builds a structural tree of LLM-written summaries (one line, one paragraph, per node) and lets a small on-device language model navigate that tree two calls at a time. No server, no API keys, no embeddings, no similarity scores. Just structure and a careful agent.

The whole stack runs in your browser tab. WebGPU runs the inference (Liquid AI's LFM2.5-1.2B-Instruct, around 700 MB, q4 quantized), OPFS persists the corpus and summary cache, and a tiny BM25 index handles fallback when the LLM cannot find a path. The first load is slow because the model has to download. After that, queries take a few seconds end-to-end on a modern laptop GPU, and the corpus survives reloads.

This repository ships v0.1.0 of the prototype: 16 phases of incremental, fully tested work. If the validation holds, the core moves to Rust. If it does not, this repository tells the story of why.

## Prerequisites

- Chrome 113+ or Edge 113+ on a machine with a WebGPU-capable GPU (most laptops from 2020 onwards qualify; integrated graphics work but are slower)
- Roughly 1.5 GB of free disk for the model cache (browser-managed)
- A static file server. The page must be served from `http://localhost` or HTTPS; WebGPU and OPFS will not work from `file://`

## Try it

```bash
git clone https://github.com/YASSERRMD/barq-mind.git
cd barq-mind
python3 -m http.server 8080
```

Then open `http://localhost:8080` and follow these steps:

1. Click **Load Model**. First run pulls ~700 MB; later runs are seconds.
2. Click **Sample**. Loads `samples/carbon-policy.md` (about 2,000 words of synthetic policy text).
3. Wait for summarization to complete (you'll see progress in the console).
4. Ask a question, for example: *"What is the implementation timeline?"* or *"How does the brief address economic risk?"*
5. Toggle **show trace** in the toolbar to see the navigation path the model chose.

Drag-and-drop also works for `.md`, `.txt`, `.pdf`, and `.json` (corpus exports) files.

## Architecture at a glance

```
Query
  │
  ▼ phase 1: navigate (LLM call)
  Tree of NodeRecord summaries  ──▶  selected leaves
  │
  ▼ phase 2: synthesize (LLM call)
  Raw text spans  ──▶  answer + citations
```

For the full design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For prompt contracts, [docs/PROMPTS.md](docs/PROMPTS.md). For how to grade changes, [docs/EVAL.md](docs/EVAL.md).

## Tech stack

- Vanilla JavaScript ES modules, no build step, no bundler
- [Transformers.js v3](https://github.com/huggingface/transformers.js) with ONNX Runtime Web for WebGPU inference
- [LFM2.5-1.2B-Instruct-ONNX](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX) (Liquid AI), q4 quantized
- Origin Private File System (OPFS) for persistence
- [MiniSearch](https://github.com/lucaong/minisearch) for BM25 keyword fallback
- [pdf.js](https://mozilla.github.io/pdf.js/) for PDF text extraction
- A 200-line in-house test harness, no Jest, no Mocha

## Roadmap

v0.1.0 (this release):

- [x] Phases 0–14: storage, tree, chunker, ingestion, inference, prompts, summarization, facade, navigator, synthesizer, BM25, PDF, UI shell, eval
- [x] Phase 15: architecture and demo polish
- [ ] Phase 16: profiling pass

After v0.1.0:

- Vision-native ingestion (page rasterization plus a visual LLM tree builder)
- LATTICE-style calibrated path relevance
- GraphRAG-style hierarchical community detection
- A Rust core port (the long-term destination)

## Foundations

barq-mind builds on prior work. None of it implements any of these papers directly, but each shaped the design:

- RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval (Sarthi et al., 2024)
- MemWalker: Walking Down the Memory Maze (Chen et al., 2023)
- GraphRAG (Microsoft, 2024)
- LATTICE: Calibrated retrieval (2024)
- PageIndex (TIFIN, 2024)
- Andrej Karpathy's "LLM Wiki" thread (2024)

## License

MIT. See [LICENSE](LICENSE).
