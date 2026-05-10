// barq-mind UI controller. Wires the CognitiveDB facade to the three-pane
// HTML shell and renders user interactions via the ui modules.

import { db, CognitiveDB } from "./db.js";
import { renderStats, setStatusDot } from "./ui/stats.js";
import { renderDocList } from "./ui/doc-list.js";
import {
  appendUser,
  appendSystem,
  appendAnswer,
  appendTrace,
} from "./ui/conversation.js";
import { renderTreeView } from "./ui/tree-view.js";
import { EvalHarness } from "./eval.js";
import { profiler } from "./profiler.js";

const $ = (id) => document.getElementById(id);

const ui = {
  stats: $("stats"),
  modelProgress: $("model-progress"),
  docList: $("doc-list"),
  treeView: $("tree-view"),
  conversation: $("conversation"),
  composer: $("composer"),
  composerInput: $("composer-input"),
  btnAsk: $("btn-ask"),
  btnLoadModel: $("btn-load-model"),
  btnUpload: $("btn-upload"),
  btnPaste: $("btn-paste"),
  btnSample: $("btn-load-sample"),
  btnExport: $("btn-export"),
  btnImport: $("btn-import"),
  btnReset: $("btn-reset"),
  fileInput: $("file-input"),
  optTrace: $("opt-trace"),
  optBM25: $("opt-bm25"),
  optDepth: $("opt-depth"),
  optBranch: $("opt-branch"),
  pasteDialog: $("paste-dialog"),
  pasteTitle: $("paste-title"),
  pasteType: $("paste-type"),
  pasteBody: $("paste-body"),
};

let busy = false;
let pathHighlight = new Set();

function setBusy(v, label) {
  busy = v;
  if (v) setStatusDot("busy", label || "working");
  else setStatusDot(db.inference.ready ? "ready" : "idle", db.inference.ready ? "ready" : "idle");
  for (const btn of [
    ui.btnAsk, ui.btnLoadModel, ui.btnUpload, ui.btnPaste,
    ui.btnSample, ui.btnExport, ui.btnImport, ui.btnReset,
  ]) {
    if (btn) btn.disabled = v;
  }
  if (!v && db.inference.ready) ui.btnAsk.disabled = false;
  if (!v && !db.inference.ready) ui.btnAsk.disabled = true;
}

async function refresh() {
  const stats = await db.stats();
  renderStats(ui.stats, stats);
  renderDocList(ui.docList, db.listDocuments(), removeDoc);
  renderTreeView(ui.treeView, db.corpus.tree, { highlightIds: Array.from(pathHighlight) });
}

function showTourIfFirstVisit() {
  try {
    if (localStorage.getItem("barq-mind:tour-seen")) return;
    const dlg = $("tour-dialog");
    if (dlg) {
      dlg.showModal();
      localStorage.setItem("barq-mind:tour-seen", "1");
    }
  } catch { /* localStorage unavailable */ }
}

async function bootstrap() {
  setStatusDot("idle", "idle");
  if (!("gpu" in navigator)) {
    const fallback = document.createElement("div");
    fallback.className = "fallback-banner";
    fallback.innerHTML = `
      <h3>WebGPU is not available</h3>
      <p>barq-mind needs WebGPU to run the on-device model. Use Chrome 113+ or Edge 113+ on a machine with a WebGPU-capable GPU. The page must be served over <code>http://localhost</code> or HTTPS.</p>
    `;
    document.querySelector(".center-pane").prepend(fallback);
    appendSystem(ui.conversation,
      "WebGPU is not available in this browser. The model cannot run.",
      "warn"
    );
    setStatusDot("err", "no webgpu");
    return;
  }
  try {
    await db.open();
    await refresh();
    appendSystem(ui.conversation,
      `Corpus opened. ${db.listDocuments().length} document(s) indexed. Load the model and ingest a document to begin.`,
      "info"
    );
    showTourIfFirstVisit();
  } catch (e) {
    appendSystem(ui.conversation, `Open failed: ${e.message}`, "warn");
    setStatusDot("err", "open failed");
  }
  CognitiveDB.onLog((level, ...args) => {
    if (level === "error") console.error(...args);
  });
}

ui.btnLoadModel.addEventListener("click", async () => {
  setBusy(true, "loading model");
  ui.modelProgress.textContent = "starting...";
  try {
    await db.loadModel({
      onProgress: (pct, file) => {
        ui.modelProgress.textContent = `${file || "loading"}: ${(pct * 100).toFixed(1)}%`;
      },
    });
    ui.modelProgress.textContent = `ready (${db.inference.dtype})`;
    appendSystem(ui.conversation, `Model ready: ${db.inference.modelId} (${db.inference.dtype})`, "ok");
  } catch (e) {
    ui.modelProgress.textContent = `error: ${e.message}`;
    appendSystem(ui.conversation, `Model load failed: ${e.message}`, "warn");
  } finally {
    setBusy(false);
    await refresh();
  }
});

async function ingestFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  const title = file.name.replace(/\.[^.]+$/, "");
  const sizeKB = (file.size / 1024).toFixed(1);
  appendSystem(ui.conversation, `Reading ${file.name} (${sizeKB} KB, type=${mime || "unknown"})...`, "info");
  setBusy(true, `ingesting ${file.name}`);
  try {
    let result;
    const isPdf = ext === "pdf" || mime === "application/pdf";
    const isMd = ext === "md" || ext === "markdown" || mime === "text/markdown";
    const isJson = ext === "json" || mime === "application/json";
    if (isPdf) {
      const buf = await file.arrayBuffer();
      result = await db.ingest({ type: "pdf", title, content: buf });
    } else if (isMd) {
      const text = await file.text();
      result = await db.ingest({ type: "markdown", title, content: text });
    } else if (isJson) {
      const json = JSON.parse(await file.text());
      await db.importJSON(json);
      appendSystem(ui.conversation, "Imported corpus JSON", "ok");
      await refresh();
      return;
    } else {
      const text = await file.text();
      result = await db.ingest({ type: "text", title, content: text });
    }
    appendSystem(ui.conversation, `Ingested "${title}" (${result.leafCount} leaves).`, "ok");
  } catch (e) {
    console.error("Ingest failed:", e);
    appendSystem(ui.conversation, `Ingest failed for ${file.name}: ${e.message}`, "warn");
  } finally {
    setBusy(false);
    await refresh();
  }
}

ui.btnUpload.addEventListener("click", () => {
  if (busy) {
    appendSystem(ui.conversation, "Busy — wait for the current operation to finish before uploading.", "warn");
    return;
  }
  ui.fileInput.click();
});
ui.fileInput.addEventListener("change", async (ev) => {
  const files = Array.from(ev.target.files || []);
  if (files.length === 0) {
    appendSystem(ui.conversation, "No file selected.", "info");
    return;
  }
  for (const file of files) {
    await ingestFile(file);
  }
  ev.target.value = "";
});

// Drag-and-drop onto the body lets users drop md/txt/pdf files anywhere.
const ACCEPTED = new Set(["md", "markdown", "txt", "pdf", "json"]);
document.body.addEventListener("dragover", (ev) => {
  if (!ev.dataTransfer || !ev.dataTransfer.types.includes("Files")) return;
  ev.preventDefault();
  document.body.classList.add("drag-active");
});
document.body.addEventListener("dragleave", (ev) => {
  if (ev.target === document.body) document.body.classList.remove("drag-active");
});
document.body.addEventListener("drop", async (ev) => {
  if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
  ev.preventDefault();
  document.body.classList.remove("drag-active");
  for (const file of ev.dataTransfer.files) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ACCEPTED.has(ext)) {
      appendSystem(ui.conversation, `Skipped ${file.name}: unsupported type`, "warn");
      continue;
    }
    await ingestFile(file);
  }
});

ui.btnPaste.addEventListener("click", () => {
  ui.pasteTitle.value = "";
  ui.pasteBody.value = "";
  ui.pasteDialog.showModal();
});

ui.pasteDialog.addEventListener("close", async () => {
  if (ui.pasteDialog.returnValue !== "ok") return;
  const title = ui.pasteTitle.value.trim();
  const text = ui.pasteBody.value;
  const type = ui.pasteType.value;
  if (!title || !text) return;
  setBusy(true, "ingesting pasted content");
  try {
    const result = await db.ingest({ type, title, content: text });
    appendSystem(ui.conversation, `Ingested "${title}" (${result.leafCount} leaves).`, "ok");
  } catch (e) {
    appendSystem(ui.conversation, `Ingest failed: ${e.message}`, "warn");
  } finally {
    setBusy(false);
    await refresh();
  }
});

ui.btnSample.addEventListener("click", async () => {
  setBusy(true, "loading sample");
  try {
    const res = await fetch("samples/carbon-policy.md");
    const text = await res.text();
    const result = await db.ingest({ type: "markdown", title: "Carbon Policy (sample)", content: text });
    appendSystem(ui.conversation, `Sample ingested (${result.leafCount} leaves). Load the model and try a question.`, "ok");
  } catch (e) {
    appendSystem(ui.conversation, `Sample load failed: ${e.message}`, "warn");
  } finally {
    setBusy(false);
    await refresh();
  }
});

async function removeDoc(docId) {
  setBusy(true, "removing");
  try {
    await db.removeDocument(docId);
    appendSystem(ui.conversation, `Removed ${docId}`, "info");
  } catch (e) {
    appendSystem(ui.conversation, `Remove failed: ${e.message}`, "warn");
  } finally {
    setBusy(false);
    await refresh();
  }
}

ui.btnExport.addEventListener("click", async () => {
  try {
    const json = await db.exportJSON();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `barq-mind-${db.name}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    appendSystem(ui.conversation, `Export failed: ${e.message}`, "warn");
  }
});

ui.btnImport.addEventListener("click", () => ui.fileInput.click());

ui.btnReset.addEventListener("click", async () => {
  if (!confirm("Reset will erase the entire corpus. Continue?")) return;
  setBusy(true, "resetting");
  try {
    await db.reset();
    appendSystem(ui.conversation, "Corpus reset.", "info");
  } finally {
    setBusy(false);
    await refresh();
  }
});

ui.composer.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (busy) return;
  const q = ui.composerInput.value.trim();
  if (!q) return;
  if (!db.inference.ready) {
    appendSystem(ui.conversation, "Load the model first.", "warn");
    return;
  }
  ui.composerInput.value = "";
  appendUser(ui.conversation, q);
  pathHighlight = new Set();
  setBusy(true, "thinking");
  try {
    const result = await db.ask(q, {
      maxDepth: parseInt(ui.optDepth.value, 10) || 4,
      branchFactor: parseInt(ui.optBranch.value, 10) || 1,
      enableBM25Fallback: ui.optBM25.checked,
      onTrace: (ev) => {
        for (const c of ev.candidates) {
          // no-op, kept for future highlighting
        }
        if (ev.action.action === "descend") {
          for (const id of ev.action.child_ids || []) pathHighlight.add(id);
        }
      },
    });
    if (ui.optTrace.checked && result.trace && result.trace.length) {
      appendTrace(ui.conversation, result.trace);
    }
    appendAnswer(ui.conversation, result);
    for (const id of result.selectedLeaves || []) pathHighlight.add(id);
  } catch (e) {
    appendSystem(ui.conversation, `Ask failed: ${e.message}`, "warn");
  } finally {
    setBusy(false);
    await refresh();
  }
});

// Eval harness wiring.
const evalUi = {
  pane: $("eval-pane"),
  btnRun: $("btn-eval-run"),
  btnBaseline: $("btn-eval-baseline"),
  btnExport: $("btn-eval-export"),
};
let lastEvalReport = null;

async function loadEvalSet() {
  const res = await fetch("samples/eval-set.json");
  if (!res.ok) throw new Error("eval-set.json not found");
  return await res.json();
}

function renderEvalSummary(report, mode) {
  const s = report.summary;
  evalUi.pane.innerHTML = `
    <div class="eval-mode">${mode}</div>
    <div class="eval-grid">
      <span>items</span><b>${s.itemCount}</b>
      <span>doc</span><b>${(s.avgDocRecall * 100).toFixed(0)}%</b>
      <span>leaf</span><b>${(s.avgLeafRecall * 100).toFixed(0)}%</b>
      <span>pages</span><b>${(s.avgPageRecall * 100).toFixed(0)}%</b>
      <span>phrases</span><b>${(s.avgPhrasesPresent * 100).toFixed(0)}%</b>
      <span>cite</span><b>${(s.citationRate * 100).toFixed(0)}%</b>
      <span>p50</span><b>${s.latencyP50.toFixed(0)}ms</b>
      <span>p95</span><b>${s.latencyP95.toFixed(0)}ms</b>
    </div>
  `;
}

if (evalUi.btnRun) {
  evalUi.btnRun.addEventListener("click", async () => {
    if (!db.inference.ready) {
      appendSystem(ui.conversation, "Load the model first.", "warn");
      return;
    }
    setBusy(true, "running eval");
    try {
      const set = await loadEvalSet();
      const harness = new EvalHarness(db);
      lastEvalReport = await harness.run(set, {
        maxDepth: parseInt(ui.optDepth.value, 10) || 4,
        branchFactor: parseInt(ui.optBranch.value, 10) || 1,
      });
      renderEvalSummary(lastEvalReport, "tree+LLM");
      appendSystem(ui.conversation, `Eval complete: ${lastEvalReport.summary.itemCount} items.`, "ok");
    } catch (e) {
      appendSystem(ui.conversation, `Eval failed: ${e.message}`, "warn");
    } finally {
      setBusy(false);
    }
  });
}

if (evalUi.btnBaseline) {
  evalUi.btnBaseline.addEventListener("click", async () => {
    setBusy(true, "running baseline");
    try {
      const set = await loadEvalSet();
      const harness = new EvalHarness(db);
      lastEvalReport = await harness.runBaselineBM25(set);
      renderEvalSummary(lastEvalReport, "BM25 only");
    } catch (e) {
      appendSystem(ui.conversation, `Baseline failed: ${e.message}`, "warn");
    } finally {
      setBusy(false);
    }
  });
}

if (evalUi.btnExport) {
  evalUi.btnExport.addEventListener("click", () => {
    if (!lastEvalReport) {
      appendSystem(ui.conversation, "Run eval first.", "warn");
      return;
    }
    const harness = new EvalHarness(db);
    const md = harness.toMarkdown(lastEvalReport);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `barq-mind-eval-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// Profile waterfall view.
const profileUi = {
  pane: $("profile-pane"),
  toggle: $("opt-profile"),
};
let unsubProfiler = null;

function renderProfile() {
  const report = profiler.report();
  const recent = profiler.recent(8);
  const max = recent.reduce((m, s) => Math.max(m, s.durationMs), 1);
  const rows = recent
    .map((s) => {
      const w = Math.max(2, (s.durationMs / max) * 100);
      return `<div class="prof-row"><span class="prof-name">${s.name}</span><div class="prof-bar" style="width:${w}%"></div><span class="prof-ms">${Math.round(s.durationMs)}ms</span></div>`;
    })
    .join("");
  const summary = Object.entries(report)
    .map(([name, r]) => `<tr><td>${name}</td><td>${r.count}</td><td>${Math.round(r.p50)}</td><td>${Math.round(r.p95)}</td></tr>`)
    .join("");
  profileUi.pane.innerHTML = `
    <div class="prof-list">${rows || '<div class="muted">no spans yet</div>'}</div>
    <table class="prof-summary"><thead><tr><th>span</th><th>n</th><th>p50</th><th>p95</th></tr></thead><tbody>${summary}</tbody></table>
  `;
}

if (profileUi.toggle) {
  profileUi.toggle.addEventListener("change", () => {
    if (profileUi.toggle.checked) {
      renderProfile();
      unsubProfiler = profiler.on(() => renderProfile());
    } else {
      if (unsubProfiler) unsubProfiler();
      unsubProfiler = null;
      profileUi.pane.innerHTML = '<div class="hint">enable to record spans</div>';
    }
  });
}

bootstrap();
