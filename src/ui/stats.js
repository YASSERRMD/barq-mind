// Renders the left-pane stats block from CognitiveDB.stats() output.

function fmt(n) { return typeof n === "number" ? n.toLocaleString() : n; }

function fmtBytes(b) {
  if (typeof b !== "number") return String(b);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function renderStats(target, stats) {
  if (!stats) {
    target.textContent = "no stats yet";
    return;
  }
  target.innerHTML = `
    <table class="stat-table">
      <tbody>
        <tr><td>corpus</td><td>${stats.corpus}</td></tr>
        <tr><td>documents</td><td>${fmt(stats.docCount)}</td></tr>
        <tr><td>nodes</td><td>${fmt(stats.tree.nodeCount)}</td></tr>
        <tr><td>leaves</td><td>${fmt(stats.tree.leafCount)}</td></tr>
        <tr><td>max depth</td><td>${fmt(stats.tree.maxDepth)}</td></tr>
        <tr><td>storage</td><td>${fmtBytes(stats.usageBytes)}</td></tr>
        <tr><td>model</td><td>${stats.inference.ready ? `ready (${stats.inference.dtype})` : "not loaded"}</td></tr>
        <tr><td>cache</td><td>${fmt(stats.cache.entryCount)} entries</td></tr>
      </tbody>
    </table>
  `;
}

export function setStatusDot(level, text) {
  const dot = document.getElementById("status-dot");
  const txt = document.getElementById("status-text");
  if (!dot || !txt) return;
  dot.className = `status-dot ${level}`;
  dot.title = text;
  txt.textContent = text;
}
