# barq-mind

A vector-free, hierarchical, LLM-navigated retrieval database that runs entirely in the browser. The Barq cognitive index, phase 0.

barq-mind is a research prototype that validates a thesis: high-quality retrieval over long documents does not require dense vector embeddings. Instead, it uses a structural tree of summaries and a small on-device language model (LFM2.5-1.2B-Instruct on WebGPU) to navigate the tree. Two LLM calls per query: one to choose the path, one to synthesize the answer from raw spans. No server, no API keys, no embeddings.

This repository is the web-first prototype that precedes a Rust core port.

## How to run

Requirements: Chrome 113+ or Edge 113+ on a machine with a WebGPU-capable GPU. Roughly 1.5 GB of free disk for the model cache on first load.

```bash
git clone https://github.com/YASSERRMD/barq-mind.git
cd barq-mind
python3 -m http.server 8080
```

Open `http://localhost:8080` in a supported browser. WebGPU requires `localhost` or HTTPS.

## Tech stack

- Vanilla JavaScript ES modules (no build step)
- Transformers.js v3 with ONNX Runtime Web for WebGPU inference
- LFM2.5-1.2B-Instruct-ONNX (Liquid AI), q4 quantization
- Origin Private File System (OPFS) for persistence
- MiniSearch for BM25 keyword fallback
- pdf.js for paginated document ingestion

## Status

Under active development. Phase 0 ships capability detection only; subsequent phases add storage, ingestion, inference, navigation, synthesis, and the full UI.

## License

MIT. See [LICENSE](LICENSE).
