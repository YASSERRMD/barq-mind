// OPFS storage wrapper. Each Storage instance is scoped to a corpus directory
// under /corpora/<name>/ in the Origin Private File System. All ops use the
// async API; sync access handles are reserved for a future worker.

export class StorageError extends Error {
  constructor(message, op, name, cause) {
    super(`${op}(${name}): ${message}`);
    this.name = "StorageError";
    this.op = op;
    this.fileName = name;
    this.cause = cause;
  }
}

function sanitize(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new StorageError("name must be a non-empty string", "validate", String(name));
  }
  if (name.includes("..") || name.startsWith("/")) {
    throw new StorageError("invalid name", "validate", name);
  }
  return name;
}

export class Storage {
  constructor() {
    this.root = null;
    this.dir = null;
    this.corpusName = null;
  }

  async open(corpusName) {
    sanitize(corpusName);
    try {
      this.root = await navigator.storage.getDirectory();
      const corpora = await this.root.getDirectoryHandle("corpora", { create: true });
      this.dir = await corpora.getDirectoryHandle(corpusName, { create: true });
      this.corpusName = corpusName;
      return this;
    } catch (e) {
      throw new StorageError(e.message, "open", corpusName, e);
    }
  }

  _ensureOpen(op, name) {
    if (!this.dir) {
      throw new StorageError("storage not open", op, name);
    }
  }

  async _resolvePath(name, { create } = {}) {
    sanitize(name);
    const segments = name.split("/").filter(Boolean);
    const file = segments.pop();
    let dir = this.dir;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: !!create });
    }
    return { dir, file };
  }

  async writeJSON(name, obj) {
    this._ensureOpen("writeJSON", name);
    try {
      const { dir, file } = await this._resolvePath(`${name}.json`, { create: true });
      const fh = await dir.getFileHandle(file, { create: true });
      const writable = await fh.createWritable();
      await writable.write(JSON.stringify(obj));
      await writable.close();
    } catch (e) {
      throw new StorageError(e.message, "writeJSON", name, e);
    }
  }

  async readJSON(name) {
    this._ensureOpen("readJSON", name);
    try {
      const { dir, file } = await this._resolvePath(`${name}.json`, { create: false });
      const fh = await dir.getFileHandle(file, { create: false });
      const f = await fh.getFile();
      const text = await f.text();
      return JSON.parse(text);
    } catch (e) {
      if (e.name === "NotFoundError") return null;
      throw new StorageError(e.message, "readJSON", name, e);
    }
  }

  async writeBlob(name, blob) {
    this._ensureOpen("writeBlob", name);
    try {
      const { dir, file } = await this._resolvePath(name, { create: true });
      const fh = await dir.getFileHandle(file, { create: true });
      const writable = await fh.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (e) {
      throw new StorageError(e.message, "writeBlob", name, e);
    }
  }

  async readBlob(name) {
    this._ensureOpen("readBlob", name);
    try {
      const { dir, file } = await this._resolvePath(name, { create: false });
      const fh = await dir.getFileHandle(file, { create: false });
      return await fh.getFile();
    } catch (e) {
      if (e.name === "NotFoundError") return null;
      throw new StorageError(e.message, "readBlob", name, e);
    }
  }

  async exists(name) {
    this._ensureOpen("exists", name);
    try {
      const candidates = [name, `${name}.json`];
      for (const candidate of candidates) {
        try {
          const { dir, file } = await this._resolvePath(candidate, { create: false });
          await dir.getFileHandle(file, { create: false });
          return true;
        } catch (e) {
          if (e.name !== "NotFoundError") throw e;
        }
      }
      return false;
    } catch (e) {
      throw new StorageError(e.message, "exists", name, e);
    }
  }

  async delete(name) {
    this._ensureOpen("delete", name);
    try {
      const candidates = [name, `${name}.json`];
      for (const candidate of candidates) {
        try {
          const { dir, file } = await this._resolvePath(candidate, { create: false });
          await dir.removeEntry(file);
          return;
        } catch (e) {
          if (e.name !== "NotFoundError") throw e;
        }
      }
    } catch (e) {
      throw new StorageError(e.message, "delete", name, e);
    }
  }

  async list(prefix = "") {
    this._ensureOpen("list", prefix);
    try {
      const out = [];
      await this._collect(this.dir, "", out);
      return out
        .map((n) => (n.endsWith(".json") ? n.slice(0, -5) : n))
        .filter((n) => n.startsWith(prefix))
        .sort();
    } catch (e) {
      throw new StorageError(e.message, "list", prefix, e);
    }
  }

  async _collect(dir, base, out) {
    for await (const [entryName, handle] of dir.entries()) {
      const path = base ? `${base}/${entryName}` : entryName;
      if (handle.kind === "file") {
        out.push(path);
      } else if (handle.kind === "directory") {
        await this._collect(handle, path, out);
      }
    }
  }

  async clear() {
    this._ensureOpen("clear", this.corpusName);
    try {
      const corpora = await this.root.getDirectoryHandle("corpora", { create: false });
      await corpora.removeEntry(this.corpusName, { recursive: true });
      this.dir = await corpora.getDirectoryHandle(this.corpusName, { create: true });
    } catch (e) {
      throw new StorageError(e.message, "clear", this.corpusName, e);
    }
  }

  async usage() {
    this._ensureOpen("usage", this.corpusName);
    try {
      let total = 0;
      await this._sum(this.dir, (size) => { total += size; });
      return total;
    } catch (e) {
      throw new StorageError(e.message, "usage", this.corpusName, e);
    }
  }

  async _sum(dir, add) {
    for await (const [, handle] of dir.entries()) {
      if (handle.kind === "file") {
        const f = await handle.getFile();
        add(f.size);
      } else if (handle.kind === "directory") {
        await this._sum(handle, add);
      }
    }
  }
}
