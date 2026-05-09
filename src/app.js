// barq-mind main entry. Capability detection plus CognitiveDB bootstrap.
// The full UI shell arrives in Phase 13.

import { db } from "./db.js";

const statusEl = document.getElementById("status");

function row(label, value, ok) {
  const cls = ok ? "ok" : "warn";
  return `<tr><td>${label}</td><td class="${cls}">${value}</td></tr>`;
}

async function detect() {
  const hasWebGPU = "gpu" in navigator;
  const hasOPFS =
    "storage" in navigator &&
    typeof navigator.storage.getDirectory === "function";

  let adapter = null;
  let hasFp16 = false;
  let adapterInfo = "n/a";
  if (hasWebGPU) {
    try {
      adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        hasFp16 = adapter.features.has("shader-f16");
        const info = adapter.info ?? {};
        adapterInfo =
          [info.vendor, info.architecture, info.device]
            .filter(Boolean)
            .join(" / ") || "available";
      }
    } catch (e) {
      adapterInfo = `error: ${e.message}`;
    }
  }

  let quotaText = "n/a";
  if ("storage" in navigator && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usedMB = ((est.usage ?? 0) / 1024 / 1024).toFixed(1);
      const quotaMB = ((est.quota ?? 0) / 1024 / 1024).toFixed(0);
      quotaText = `${usedMB} MB used of ~${quotaMB} MB`;
    } catch {
      quotaText = "estimate failed";
    }
  }

  return { hasWebGPU, hasOPFS, hasFp16, adapterInfo, quotaText };
}

function render(caps) {
  const html = `
    <table class="status-table">
      <tbody>
        ${row("WebGPU", caps.hasWebGPU ? "available" : "missing", caps.hasWebGPU)}
        ${row("Adapter", caps.adapterInfo, caps.hasWebGPU)}
        ${row("shader-f16", caps.hasFp16 ? "yes" : "no", caps.hasFp16)}
        ${row("OPFS", caps.hasOPFS ? "available" : "missing", caps.hasOPFS)}
        ${row("Storage", caps.quotaText, caps.hasOPFS)}
        ${row("User Agent", navigator.userAgent, true)}
      </tbody>
    </table>
    <p class="hint">Phase 0 build. Phase 1 introduces the OPFS storage wrapper.</p>
  `;
  statusEl.innerHTML = html;
}

(async () => {
  try {
    const caps = await detect();
    render(caps);
    if (caps.hasOPFS) {
      try {
        await db.open();
        const stats = await db.stats();
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = `Corpus "${stats.corpus}" opened. ${stats.docCount} documents, ${stats.tree.nodeCount} nodes.`;
        statusEl.appendChild(note);
      } catch (e) {
        const note = document.createElement("p");
        note.className = "hint warn";
        note.textContent = `corpus open failed: ${e.message}`;
        statusEl.appendChild(note);
      }
    }
  } catch (e) {
    statusEl.textContent = `detection failed: ${e.message}`;
  }
})();
