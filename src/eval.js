// Evaluation harness. Runs an eval set (question + expected leaves/pages/phrases)
// through the full ask pipeline, computes per-item and aggregate metrics, and
// renders a markdown report.

function intersectionSize(a, b) {
  const setB = b instanceof Set ? b : new Set(b);
  let n = 0;
  for (const x of a) if (setB.has(x)) n++;
  return n;
}

function recall(predicted, expected) {
  if (!expected || expected.length === 0) return 1;
  return intersectionSize(predicted, expected) / expected.length;
}

function phrasesPresent(answer, phrases) {
  if (!phrases || phrases.length === 0) return { matched: 0, total: 0, present: true };
  const lower = (answer || "").toLowerCase();
  let matched = 0;
  for (const p of phrases) {
    if (lower.includes((p || "").toLowerCase())) matched++;
  }
  return { matched, total: phrases.length, present: matched === phrases.length };
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx];
}

export class EvalHarness {
  constructor(db) { this.db = db; }

  async run(evalSet, opts = {}) {
    const items = [];
    const latencies = [];
    for (const item of evalSet) {
      const t0 = performance.now();
      let result;
      try {
        result = await this.db.ask(item.question, opts);
      } catch (e) {
        items.push({ ...item, error: e.message, durationMs: performance.now() - t0 });
        continue;
      }
      const ms = performance.now() - t0;
      latencies.push(ms);
      const predicted = result.selectedLeaves || [];
      const expected = item.expected_leaf_ids || [];
      const docs = new Set(predicted.map((id) => idDoc(id)));
      const expectedDoc = item.expected_doc_id;
      const docRecall = expectedDoc ? (docs.has(expectedDoc) ? 1 : 0) : 1;
      const leafRecall = recall(predicted, expected);
      const expectedPages = (item.expected_pages || []).map(String);
      const predictedPages = (result.citations || [])
        .map((c) => c.page)
        .filter((p) => p != null)
        .map(String);
      const pageRecall = expectedPages.length === 0
        ? 1
        : recall(predictedPages, expectedPages);
      const phrases = phrasesPresent(result.answer, item.expected_phrases);
      const hasCitations = (result.citations || []).length > 0;
      items.push({
        question: item.question,
        expected_doc_id: expectedDoc,
        predicted_leaves: predicted,
        expected_leaves: expected,
        answer: result.answer,
        citations: result.citations,
        metrics: {
          docRecall,
          leafRecall,
          pageRecall,
          phrasesPresent: phrases.present,
          phrasesMatched: phrases.matched,
          phrasesTotal: phrases.total,
          hasCitations,
        },
        durationMs: ms,
        fallback: !!result.fallback,
      });
    }
    const avg = (k) =>
      items.length === 0
        ? 0
        : items.reduce((s, it) => s + (it.metrics ? it.metrics[k] : 0), 0) / items.length;
    const summary = {
      itemCount: items.length,
      avgDocRecall: avg("docRecall"),
      avgLeafRecall: avg("leafRecall"),
      avgPageRecall: avg("pageRecall"),
      avgPhrasesPresent: items.length === 0 ? 0 : items.filter((it) => it.metrics?.phrasesPresent).length / items.length,
      citationRate: items.length === 0 ? 0 : items.filter((it) => it.metrics?.hasCitations).length / items.length,
      latencyP50: quantile(latencies, 0.5),
      latencyP95: quantile(latencies, 0.95),
    };
    return { items, summary };
  }

  toMarkdown(report) {
    const lines = ["# barq-mind eval report", ""];
    const s = report.summary;
    lines.push(`Total items: ${s.itemCount}`);
    lines.push(`Doc recall avg: ${s.avgDocRecall.toFixed(2)}`);
    lines.push(`Leaf recall avg: ${s.avgLeafRecall.toFixed(2)}`);
    lines.push(`Page recall avg: ${s.avgPageRecall.toFixed(2)}`);
    lines.push(`Phrases present: ${(s.avgPhrasesPresent * 100).toFixed(0)}%`);
    lines.push(`Citation rate: ${(s.citationRate * 100).toFixed(0)}%`);
    lines.push(`Latency p50: ${s.latencyP50.toFixed(0)}ms, p95: ${s.latencyP95.toFixed(0)}ms`);
    lines.push("", "| # | Question | Doc | Leaf | Pages | Phrases | Cite | ms |", "|---|----------|-----|------|-------|---------|------|----|");
    let i = 1;
    for (const it of report.items) {
      const m = it.metrics || {};
      lines.push(
        `| ${i++} | ${esc(it.question)} | ${(m.docRecall ?? 0).toFixed(2)} | ${(m.leafRecall ?? 0).toFixed(2)} | ${(m.pageRecall ?? 0).toFixed(2)} | ${m.phrasesMatched ?? 0}/${m.phrasesTotal ?? 0} | ${m.hasCitations ? "y" : "n"} | ${Math.round(it.durationMs)} |`
      );
    }
    return lines.join("\n");
  }
}

function idDoc(nodeId) {
  const m = /^doc:([^/]+)\//.exec(nodeId || "");
  return m ? m[1] : null;
}

function esc(s) {
  return String(s || "").replace(/\|/g, "\\|").slice(0, 70);
}
