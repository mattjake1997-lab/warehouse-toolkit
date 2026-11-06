/* Warehouse Toolkit runtime.
   The tools were first built to run on claude.ai, which gave them three things: a small database, file downloads and
   (in the MFN Renamer) Claude reading. This file gives the same calls a home in the browser instead:

   - Saved data (daily log, exceptions, reasons, settings...) lives in this browser (IndexedDB) by default, or, once
     someone picks one, as JSON files in a folder on their computer or the shared drive (File System Access API,
     Edge/Chrome). One file per record: <folder>/<collection>/<id>.json
   - Downloads are normal browser downloads.
   - Claude reading is off: use("sample") answers null, and the renamer falls back to asking a person.

   Nothing here talks to any server. */
(function () {
  "use strict";
  if (window.toolkitRuntime) return;

  /* ---------- small helpers ---------- */
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  function checkPath(path, wantDoc) {
    const parts = String(path).split("/");
    if (parts.some((p) => !SEG.test(p) || p === "." || p === "..")) throw new TypeError(`Bad path: ${path}`);
    if (wantDoc && parts.length % 2 !== 0) throw new TypeError(`A document path needs an even number of segments: ${path}`);
    if (!wantDoc && parts.length % 2 !== 1) throw new TypeError(`A collection path needs an odd number of segments: ${path}`);
    return parts;
  }
  const collOf = (docPath) => docPath.slice(0, docPath.lastIndexOf("/"));
  const idOf = (docPath) => docPath.slice(docPath.lastIndexOf("/") + 1);
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

  /* ---------- IndexedDB (this browser) ---------- */
  let idbP = null;
  function idb() {
    if (!idbP)
      idbP = new Promise((res, rej) => {
        const r = indexedDB.open("warehouse-toolkit", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("docs"); r.result.createObjectStore("meta"); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    return idbP;
  }
  async function tx(store, mode, fn) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const metaGet = (k) => tx("meta", "readonly", (s) => s.get(k));
  const metaSet = (k, v) => tx("meta", "readwrite", (s) => { s.put(v, k); });
  const metaDel = (k) => tx("meta", "readwrite", (s) => { s.delete(k); });
  async function idbAll() {
    const db = await idb();
    return new Promise((res, rej) => {
      const out = new Map(), t = db.transaction("docs", "readonly"), c = t.objectStore("docs").openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out.set(cur.key, cur.value); cur.continue(); } };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  }
  const browserStore = {
    kind: "browser",
    label: "This browser",
    loadAll: idbAll,
    put: (path, data) => tx("docs", "readwrite", (s) => { s.put(data, path); }),
    del: (path) => tx("docs", "readwrite", (s) => { s.delete(path); }),
  };

  /* ---------- A folder (File System Access) ---------- */
  const fileName = (id) => encodeURIComponent(id) + ".json";
  const idFromFile = (name) => decodeURIComponent(name.replace(/\.json$/, ""));
  function folderStore(root) {
    const seen = new Map(); // path -> lastModified, to notice other people's changes
    async function dirFor(coll, create) {
      let d = root;
      for (const p of coll.split("/")) d = await d.getDirectoryHandle(p, { create });
      return d;
    }
    async function walk(dir, prefix, out, stamps) {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === "directory") { await walk(h, prefix ? prefix + "/" + name : name, out, stamps); continue; }
        if (!prefix || !name.endsWith(".json")) continue;
        const path = prefix + "/" + idFromFile(name);
        try {
          const f = await h.getFile();
          stamps.set(path, f.lastModified);
          if (seen.get(path) === f.lastModified && out.has(path)) continue;
          out.set(path, JSON.parse(await f.text()));
        } catch (e) { /* half-written or unreadable file: skip it this time */ }
      }
    }
    return {
      kind: "folder",
      label: root.name,
      handle: root,
      async loadAll(prev) {
        const out = new Map(prev || []), stamps = new Map();
        await walk(root, "", out, stamps);
        for (const k of [...out.keys()]) if (!stamps.has(k)) out.delete(k);
        seen.clear(); for (const [k, v] of stamps) seen.set(k, v);
        return out;
      },
      async put(path, data) {
        const dir = await dirFor(collOf(path), true);
        const fh = await dir.getFileHandle(fileName(idOf(path)), { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(data, null, 1));
        await w.close();
        try { seen.set(path, (await fh.getFile()).lastModified); } catch (e) {}
      },
      async del(path) {
        try { const dir = await dirFor(collOf(path), false); await dir.removeEntry(fileName(idOf(path))); } catch (e) {}
        seen.delete(path);
      },
    };
  }

  /* ---------- The in-memory copy everyone reads from ---------- */
  const mem = new Map(); // "collection/id" -> data
  let store = browserStore;
  const listeners = new Set();
  const status = { kind: "browser", label: "This browser", needsPermission: false, folderName: null, error: null };
  const statusListeners = new Set();
  const setStatus = (p) => { Object.assign(status, p); statusListeners.forEach((f) => { try { f({ ...status }); } catch (e) {} }); };

  function notify(changedPaths) {
    for (const l of listeners) {
      if (changedPaths && !changedPaths.some((p) => l.touches(p))) continue;
      try { l.fire(); } catch (e) { console.error(e); }
    }
  }
  let writeChain = Promise.resolve();
  function persist(fn) {
    writeChain = writeChain.then(fn).catch((e) => {
      console.error(e);
      setStatus({ error: "Couldn't save to " + status.label + ". " + (e && e.message ? e.message : "") });
      throw err("unavailable", "Couldn't save");
    });
    return writeChain;
  }

  /* ---------- Queries ---------- */
  const OPS = {
    "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, "<=": (a, b) => a <= b,
    ">": (a, b) => a > b, ">=": (a, b) => a >= b, in: (a, b) => b.includes(a), "not-in": (a, b) => !b.includes(a),
    "array-contains": (a, b) => Array.isArray(a) && a.includes(b),
  };
  function runQuery(q) {
    let rows = [];
    const pre = q.coll + "/";
    for (const [k, v] of mem) if (k.startsWith(pre) && !k.slice(pre.length).includes("/")) rows.push({ id: k.slice(pre.length), data: v });
    for (const [f, op, val] of q.where) rows = rows.filter((r) => OPS[op] && OPS[op](r.data[f], val));
    if (q.order) {
      const [f, dir] = q.order, s = dir === "desc" ? -1 : 1;
      rows.sort((a, b) => {
        const x = a.data[f], y = b.data[f];
        if (x === undefined) return 1; if (y === undefined) return -1;
        return x < y ? -s : x > y ? s : 0;
      });
    } else rows.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (q.limit) rows = rows.slice(0, q.limit);
    return rows;
  }
  const docSnap = (id, data) => ({ id, exists: data !== undefined, data: () => clone(data), metadata: { fromCache: false, hasPendingWrites: false } });
  function querySnap(rows) {
    const docs = rows.map((r) => docSnap(r.id, r.data));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } };
  }

  function makeQuery(coll, where, order, limit) {
    const q = { coll, where, order, limit };
    return {
      where: (f, op, v) => makeQuery(coll, [...where, [f, op, clone(v)]], order, limit),
      orderBy: (f, dir) => makeQuery(coll, where, [f, dir || "asc"], limit),
      limit: (n) => makeQuery(coll, where, order, n),
      get: async () => { await ready; return querySnap(runQuery(q)); },
      onSnapshot(next, error) {
        let live = true;
        const l = { touches: (p) => collOf(p) === coll, fire: () => live && next(querySnap(runQuery(q))) };
        listeners.add(l);
        ready.then(() => l.fire(), (e) => error && error(err("unavailable", String(e))));
        return () => { live = false; listeners.delete(l); };
      },
    };
  }
  function deepMerge(base, patch) {
    const out = isObj(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) {
      if (isObj(v) && v.__delete__ === true) delete out[k];
      else if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  function makeDoc(path) {
    checkPath(path, true);
    const id = idOf(path);
    async function write(data) {
      await ready;
      mem.set(path, data);
      notify([path]);
      await persist(() => store.put(path, data));
    }
    return {
      id, path,
      get: async () => { await ready; return docSnap(id, mem.get(path)); },
      async set(data) {
        if (!isObj(data)) throw err("invalid_argument", "A document must be an object");
        await write(clone(data));
      },
      async update(data) {
        await ready;
        if (!isObj(data)) throw err("invalid_argument", "A document must be an object");
        if (!mem.has(path)) throw err("invalid_argument", "That document doesn't exist yet");
        await write(deepMerge(mem.get(path), clone(data)));
      },
      async delete() {
        await ready;
        mem.delete(path);
        notify([path]);
        await persist(() => store.del(path));
      },
      acquire: async () => ({ acquired: true, version: 1, expiresAt: new Date(Date.now() + 30000).toISOString() }),
      onSnapshot(next, error) {
        let live = true;
        const l = { touches: (p) => p === path, fire: () => live && next(docSnap(id, mem.get(path))) };
        listeners.add(l);
        ready.then(() => l.fire(), (e) => error && error(err("unavailable", String(e))));
        return () => { live = false; listeners.delete(l); };
      },
      collection: (p) => makeColl(path + "/" + p),
    };
  }
  function makeColl(path) {
    checkPath(path, false);
    const q = makeQuery(path, [], null, 0);
    q.path = path;
    q.doc = (id) => makeDoc(path + "/" + (id === undefined ? newId() : id));
    q.add = async (data) => { const d = makeDoc(path + "/" + newId()); await d.set(data); return d; };
    return q;
  }
  const db = Object.freeze({ doc: makeDoc, collection: makeColl });

  /* ---------- Downloads ---------- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : String(data ?? "")]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename || "download"; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: "saved" };
    },
  });

  /* ---------- Who's using it (no accounts: one id per browser) ---------- */
  function localId() {
    try {
      let id = localStorage.getItem("toolkit.userId");
      if (!id) { id = "u_" + newId(); localStorage.setItem("toolkit.userId", id); }
      return id;
    } catch (e) { return "u_local"; }
  }
  const user = Object.freeze({
    id: async () => localId(),
    can: async () => true,
    canEdit: async () => true,
    isOwner: async () => true,
    profile: async () => null,
  });

  /* ---------- Starting up: browser storage, or the folder picked last time ---------- */
  async function loadFrom(s) {
    const all = await s.loadAll(s.kind === "folder" ? mem : null);
    mem.clear();
    for (const [k, v] of all) mem.set(k, v);
    store = s;
  }
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  (async () => {
    try {
      const h = await metaGet("folder");
      if (h && h.queryPermission) {
        const p = await h.queryPermission({ mode: "readwrite" });
        if (p === "granted") {
          await loadFrom(folderStore(h));
          setStatus({ kind: "folder", label: h.name, folderName: h.name, needsPermission: false });
        } else {
          // The browser wants a click before it opens the folder again; until then nothing is shown or saved.
          setStatus({ kind: "folder", label: h.name, folderName: h.name, needsPermission: true });
          await new Promise((r) => { pendingReconnect = r; });
          await loadFrom(folderStore(h));
          setStatus({ needsPermission: false });
        }
      } else {
        await loadFrom(browserStore);
      }
    } catch (e) {
      console.error(e);
      try { await loadFrom(browserStore); } catch (e2) {}
      setStatus({ kind: "browser", label: "This browser", error: "Couldn't open the data folder, so this browser's storage is being used." });
    }
    resolveReady();
  })();
  let pendingReconnect = null;

  // Someone else saving to a shared folder: look for their changes every 30 seconds.
  setInterval(async () => {
    if (store.kind !== "folder" || status.needsPermission || document.hidden) return;
    try {
      const before = new Map(mem);
      const all = await store.loadAll(mem);
      const changed = [];
      for (const [k, v] of all) if (!before.has(k) || JSON.stringify(before.get(k)) !== JSON.stringify(v)) changed.push(k);
      for (const k of before.keys()) if (!all.has(k)) changed.push(k);
      if (!changed.length) return;
      mem.clear(); for (const [k, v] of all) mem.set(k, v);
      notify(changed);
    } catch (e) { /* folder briefly unavailable (VPN, sleep): try again next time */ }
  }, 30000);

  /* ---------- Data settings (used by the toolkit page's Data panel) ---------- */
  const runtime = {
    ready,
    status: () => ({ ...status }),
    onStatus: (f) => { statusListeners.add(f); return () => statusListeners.delete(f); },
    folderSupported: typeof window.showDirectoryPicker === "function",
    async reconnect() {
      const h = await metaGet("folder");
      if (!h) return false;
      const p = await h.requestPermission({ mode: "readwrite" });
      if (p !== "granted") return false;
      if (pendingReconnect) { pendingReconnect(); pendingReconnect = null; }
      return true;
    },
    // Pick a folder. Returns what's there so the page can ask before mixing data.
    async pickFolder() {
      const h = await window.showDirectoryPicker({ id: "warehouse-toolkit-data", mode: "readwrite" });
      const s = folderStore(h);
      const there = await s.loadAll();
      return { handle: h, name: h.name, count: there.size };
    },
    // copy: put what this browser has saved into the folder (only into an empty one).
    async useFolder(handle, copy) {
      await ready;
      const s = folderStore(handle);
      if (copy) for (const [k, v] of mem) await s.put(k, v);
      await metaSet("folder", handle);
    },
    async useBrowser() { await metaDel("folder"); },
    async exportAll() {
      await ready;
      return { app: "warehouse-toolkit", version: 1, savedAt: new Date().toISOString(), docs: Object.fromEntries(mem) };
    },
    async importAll(backup, { replace } = {}) {
      await ready;
      if (!backup || backup.app !== "warehouse-toolkit" || !isObj(backup.docs)) throw new Error("That isn't a Warehouse Toolkit backup file.");
      if (replace) for (const k of [...mem.keys()]) { mem.delete(k); await store.del(k); }
      for (const [k, v] of Object.entries(backup.docs)) { checkPath(k, true); mem.set(k, v); await store.put(k, v); }
      notify(null);
      return Object.keys(backup.docs).length;
    },
    // Company details (sites, addresses, names, weights...) imported from a settings file; {} until one is imported.
    settings: () => clone(mem.get("settings/company") || {}),
    async saveSettings(obj) { await makeDoc("settings/company").set(obj); },
    db, downloads, user,
  };
  window.toolkitRuntime = runtime;

  // The same shape the tools already call: claude.use("db"), claude.use("downloads"), ...
  window.claude = Object.freeze({
    __toolkit: true,
    use: async (name) => {
      if (name === "db") { await ready; return db; }
      if (name === "downloads") return downloads;
      if (name === "user") return user;
      return null; // "sample" (Claude reading) and anything else: not available in this version
    },
  });
})();
