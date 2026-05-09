// WebGPU inference engine wrapping Transformers.js v3 and LFM2.5-1.2B-Instruct.
// Loads the model on demand, exposes chat/chatStream with the model's recommended
// generation defaults (temperature=0.1, top_k=50, repetition_penalty=1.05).

import { AutoModelForCausalLM, AutoTokenizer, TextStreamer } from "@huggingface/transformers";

export class InferenceError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = "InferenceError";
    this.code = code;
    this.cause = cause;
  }
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
  }

  _onProgress(cb, p) {
    if (typeof cb !== "function") return;
    try {
      const pct = typeof p.progress === "number" ? p.progress : 0;
      cb(pct, p.file || p.name || "");
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
    const genOpts = { ...DEFAULT_GEN, ...opts };
    const inputs = this.tokenizer.apply_chat_template(messages, {
      add_generation_prompt: true,
      return_dict: true,
    });
    let stoppedAt = "natural";
    let output;
    try {
      output = await this.model.generate({
        ...inputs,
        max_new_tokens: genOpts.max_new_tokens,
        temperature: genOpts.temperature,
        top_k: genOpts.top_k,
        repetition_penalty: genOpts.repetition_penalty,
        do_sample: genOpts.do_sample,
      });
    } catch (e) {
      if (e.name === "AbortError") {
        stoppedAt = "abort";
        throw e;
      }
      throw new InferenceError(`generate failed: ${e.message}`, "GEN_FAILED", e);
    }
    const inputLen = Array.isArray(inputs.input_ids[0])
      ? inputs.input_ids[0].length
      : inputs.input_ids.dims?.[1] || 0;
    const generated = Array.isArray(output[0])
      ? output[0].slice(inputLen)
      : output;
    const text = this.tokenizer.decode(generated, { skip_special_tokens: true });
    const duration = performance.now() - t0;
    this.totalCalls++;
    this.totalGeneratedTokens += Array.isArray(generated) ? generated.length : 0;
    this.totalDurationMs += duration;
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
    try {
      await this.model.generate({
        ...inputs,
        max_new_tokens: genOpts.max_new_tokens,
        temperature: genOpts.temperature,
        top_k: genOpts.top_k,
        repetition_penalty: genOpts.repetition_penalty,
        do_sample: genOpts.do_sample,
        streamer,
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
