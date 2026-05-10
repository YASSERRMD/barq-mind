// WebGPU inference engine wrapping Transformers.js v3 and LFM2.5-1.2B-Instruct.
// Loads the model on demand, exposes chat/chatStream with the model's recommended
// generation defaults (temperature=0.1, top_k=50, repetition_penalty=1.05).

import { AutoModelForCausalLM, AutoTokenizer, TextStreamer } from "@huggingface/transformers";
import { profiler } from "./profiler.js";

export class InferenceError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "InferenceError";
    this.code = code;
    this.cause = cause;
  }
}

// In transformers.js v3 the tokenizer/generator returned plain JS arrays.
// In v4 they return ORT-backed Tensor instances (with BigInt token ids).
// These helpers normalize both shapes to a flat Array<number> of generated
// token ids that the tokenizer.decode() accepts.

function inputLenOf(inputIds) {
  if (Array.isArray(inputIds)) {
    return Array.isArray(inputIds[0]) ? inputIds[0].length : inputIds.length;
  }
  if (inputIds && Array.isArray(inputIds.dims) && inputIds.dims.length >= 2) {
    return Number(inputIds.dims[inputIds.dims.length - 1]);
  }
  return 0;
}

function sliceGenerated(output, inputLen) {
  // v3 array shape: number[][] or number[]
  if (Array.isArray(output)) {
    const row = Array.isArray(output[0]) ? output[0] : output;
    return row.slice(inputLen).map(Number);
  }
  // v4 Tensor: prefer .tolist() (matches ORT typing); fall back to .data
  if (output && typeof output.tolist === "function") {
    const list = output.tolist();
    const row = Array.isArray(list[0]) ? list[0] : list;
    return row.slice(inputLen).map(Number);
  }
  if (output && output.data) {
    const arr = Array.from(output.data, (v) => Number(v));
    return arr.slice(inputLen);
  }
  return [];
}

const DEFAULT_MODEL_ID = "LiquidAI/LFM2.5-1.2B-Instruct-ONNX";
const DEFAULT_GEN = {
  max_new_tokens: 512,
  temperature: 0.1,
  top_k: 50,
  repetition_penalty: 1.05,
  do_sample: false,
};

export class InferenceEngine {
  constructor(opts = {}) {
    this.modelId = opts.modelId || DEFAULT_MODEL_ID;
    this.model = null;
    this.tokenizer = null;
    this.ready = false;
    this.dtype = null;
    this.totalCalls = 0;
    this.totalGeneratedTokens = 0;
    this.totalDurationMs = 0;
  }

  async load(opts = {}) {
    if (this.ready) return;
    if (!("gpu" in navigator)) {
      throw new InferenceError("WebGPU not available in this browser", "NO_WEBGPU");
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new InferenceError("No WebGPU adapter available", "NO_ADAPTER");
    }
    const supportsFp16 = adapter.features.has("shader-f16");
    const dtype = opts.dtype || (supportsFp16 ? "q4f16" : "q4");

    try {
      this.tokenizer = await AutoTokenizer.from_pretrained(this.modelId, {
        progress_callback: (p) => this._onProgress(opts.onProgress, p),
      });
      this.model = await AutoModelForCausalLM.from_pretrained(this.modelId, {
        device: "webgpu",
        dtype,
        progress_callback: (p) => this._onProgress(opts.onProgress, p),
      });
      this.dtype = dtype;
      this.ready = true;
    } catch (e) {
      throw new InferenceError(`model load failed: ${e.message}`, "LOAD_FAILED", e);
    }
    if (opts.warmup !== false) {
      // Throwaway generation primes the WebGPU pipelines so the first user
      // query does not pay the one-time JIT cost.
      try {
        await this.chat([{ role: "user", content: "Hi" }], { max_new_tokens: 4 });
      } catch {
        // ignore warmup errors
      }
    }
  }

  _onProgress(cb, p) {
    if (typeof cb !== "function") return;
    try {
      // Transformers.js v3 reported progress as 0..1; v4 reports 0..100 and adds
      // a `progress_total` aggregate event. Normalize to 0..1 so the public
      // contract stays the same regardless of upstream version.
      let pct = typeof p.progress === "number" ? p.progress : 0;
      if (pct > 1) pct = pct / 100;
      if (pct < 0) pct = 0;
      if (pct > 1) pct = 1;
      // Prefer per-file label; fall back to the aggregate status when v4
      // emits `progress_total` with the repo name (not file-shaped).
      let label = p.file || "";
      if (!label) {
        if (p.status === "progress_total" || p.status === "download") {
          label = "downloading";
        } else if (p.status === "ready" || p.status === "done") {
          label = "ready";
        } else {
          label = p.name || "";
        }
      }
      cb(pct, label);
    } catch {
      // swallow callback errors
    }
  }

  _ensureReady() {
    if (!this.ready) {
      throw new InferenceError("InferenceEngine not loaded; call load() first", "NOT_READY");
    }
  }

  async chat(messages, opts = {}) {
    this._ensureReady();
    const t0 = performance.now();
    const span = profiler.start("inference.chat", { tokens: opts.max_new_tokens });
    const genOpts = { ...DEFAULT_GEN, ...opts };
    const inputs = this.tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    });
    let stoppedAt = "natural";
    let output;
    const signal = opts.signal;
    if (signal && signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    try {
      output = await this.model.generate({
        ...inputs,
        max_new_tokens: genOpts.max_new_tokens,
        temperature: genOpts.temperature,
        top_k: genOpts.top_k,
        repetition_penalty: genOpts.repetition_penalty,
        do_sample: genOpts.do_sample,
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (e.name === "AbortError") {
        stoppedAt = "abort";
        throw e;
      }
      throw new InferenceError(`generate failed: ${e.message}`, "GEN_FAILED", e);
    }
    const inputLen = inputLenOf(inputs.input_ids);
    const generated = sliceGenerated(output, inputLen);
    const text = this.tokenizer.decode(generated, { skip_special_tokens: true });
    const duration = performance.now() - t0;
    this.totalCalls++;
    this.totalGeneratedTokens += generated.length;
    this.totalDurationMs += duration;
    profiler.end(span, { tokens_out: generated.length });
    return {
      text,
      raw_tokens: Array.isArray(generated) ? generated.length : 0,
      stopped_at: stoppedAt,
      duration_ms: duration,
    };
  }

  async chatStream(messages, opts, onToken) {
    this._ensureReady();
    const t0 = performance.now();
    const genOpts = { ...DEFAULT_GEN, ...opts };
    const inputs = this.tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    });
    let buffered = "";
    const streamer = new TextStreamer(this.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        buffered += chunk;
        if (typeof onToken === "function") onToken(chunk, false);
      },
    });
    const signal = opts && opts.signal;
    if (signal && signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    try {
      await this.model.generate({
        ...inputs,
        max_new_tokens: genOpts.max_new_tokens,
        temperature: genOpts.temperature,
        top_k: genOpts.top_k,
        repetition_penalty: genOpts.repetition_penalty,
        do_sample: genOpts.do_sample,
        streamer,
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new InferenceError(`stream generate failed: ${e.message}`, "STREAM_FAILED", e);
    }
    if (typeof onToken === "function") onToken("", true);
    const duration = performance.now() - t0;
    this.totalCalls++;
    this.totalDurationMs += duration;
    return { text: buffered, duration_ms: duration };
  }

  stats() {
    const tokensPerSec =
      this.totalDurationMs > 0
        ? (this.totalGeneratedTokens / (this.totalDurationMs / 1000)).toFixed(2)
        : "n/a";
    return {
      ready: this.ready,
      modelId: this.modelId,
      dtype: this.dtype,
      totalCalls: this.totalCalls,
      avgTokensPerSec: tokensPerSec,
    };
  }
}
