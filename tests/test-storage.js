import { run, assert, assertEq } from "./runner.js";
import { Storage, StorageError } from "../src/storage.js";

const TEST_CORPUS = "test-storage";

async function freshStorage() {
  const s = await new Storage().open(TEST_CORPUS);
  await s.clear();
  return s;
}

export async function runStorageTests() {
  await run("storage: open returns instance and creates corpus dir", async () => {
    const s = await new Storage().open(TEST_CORPUS);
    assert(s instanceof Storage, "expected Storage instance");
    assertEq(s.corpusName, TEST_CORPUS, "corpus name preserved");
  });

  await run("storage: write/read JSON roundtrip", async () => {
    const s = await freshStorage();
    const obj = { hello: "world", n: 42, arr: [1, 2, 3], nested: { ok: true } };
    await s.writeJSON("doc1", obj);
    const got = await s.readJSON("doc1");
    assertEq(got, obj, "roundtrip mismatch");
  });

  await run("storage: readJSON returns null for missing file", async () => {
    const s = await freshStorage();
    const got = await s.readJSON("does-not-exist");
    assert(got === null, `expected null, got ${JSON.stringify(got)}`);
  });

  await run("storage: exists before and after write", async () => {
    const s = await freshStorage();
    assert((await s.exists("foo")) === false, "should not exist before write");
    await s.writeJSON("foo", { a: 1 });
    assert((await s.exists("foo")) === true, "should exist after write");
  });

  await run("storage: list returns names without .json suffix and supports prefix", async () => {
    const s = await freshStorage();
    await s.writeJSON("alpha", { x: 1 });
    await s.writeJSON("alphabet", { x: 2 });
    await s.writeJSON("beta", { x: 3 });
    const all = await s.list();
    assert(all.includes("alpha"), "missing alpha");
    assert(all.includes("alphabet"), "missing alphabet");
    assert(all.includes("beta"), "missing beta");
    const prefixed = await s.list("alpha");
    assertEq(prefixed.sort(), ["alpha", "alphabet"], "prefix list mismatch");
  });

  await run("storage: delete removes file and is idempotent", async () => {
    const s = await freshStorage();
    await s.writeJSON("temp", { x: 1 });
    assert((await s.exists("temp")) === true, "should exist before delete");
    await s.delete("temp");
    assert((await s.exists("temp")) === false, "should not exist after delete");
    await s.delete("temp");
  });

  await run("storage: blob roundtrip preserves bytes", async () => {
    const s = await freshStorage();
    const blob = new Blob(["binary content here"], { type: "text/plain" });
    await s.writeBlob("raw/sample.bin", blob);
    const got = await s.readBlob("raw/sample.bin");
    assert(got !== null, "blob missing");
    const text = await got.text();
    assertEq(text, "binary content here", "blob content mismatch");
  });

  await run("storage: clear removes all entries", async () => {
    const s = await freshStorage();
    await s.writeJSON("a", { x: 1 });
    await s.writeJSON("b", { x: 2 });
    await s.writeBlob("c.bin", new Blob(["c"]));
    await s.clear();
    const all = await s.list();
    assertEq(all, [], "clear should leave empty list");
  });

  await run("storage: usage is non-zero after writes", async () => {
    const s = await freshStorage();
    await s.writeJSON("u", { payload: "x".repeat(500) });
    const used = await s.usage();
    assert(used > 100, `expected non-trivial usage, got ${used}`);
  });

  await run("storage: writeJSON wraps unexpected errors as StorageError", async () => {
    const s = await new Storage().open(TEST_CORPUS);
    let threw = null;
    try {
      await s.writeJSON("../../escape", { x: 1 });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof StorageError, `expected StorageError, got ${threw && threw.constructor.name}`);
  });
}
