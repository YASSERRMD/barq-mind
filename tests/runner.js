// Tiny test harness used by tests.html. No dependencies, no globals.

const log = [];
let pass = 0;
let fail = 0;

function emit(line, cls) {
  const target = document.getElementById("results");
  if (target) {
    const row = document.createElement("div");
    row.className = `row ${cls}`;
    row.textContent = line;
    target.appendChild(row);
  }
  if (cls === "fail") console.error(line);
  else console.log(line);
}

function updateSummary() {
  const summary = document.getElementById("summary");
  if (summary) {
    summary.textContent = `${pass} passed, ${fail} failed`;
    summary.className = fail > 0 ? "fail" : "pass";
  }
}

export async function run(name, fn) {
  const t0 = performance.now();
  try {
    await fn();
    const ms = (performance.now() - t0).toFixed(1);
    pass++;
    log.push({ name, status: "pass", ms });
    emit(`PASS  ${name}  (${ms}ms)`, "pass");
  } catch (e) {
    const ms = (performance.now() - t0).toFixed(1);
    fail++;
    log.push({ name, status: "fail", error: e.message, ms });
    emit(`FAIL  ${name}  (${ms}ms)\n      ${e.message}`, "fail");
  }
  updateSummary();
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg || "values differ"}: expected ${e} got ${a}`);
  }
}

export function results() {
  return { pass, fail, log: log.slice() };
}

export function section(label) {
  emit(`\n--- ${label} ---`, "section");
}
