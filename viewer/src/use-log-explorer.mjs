import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { EXPLORER_LIMITS, headerIndex, limiter, memoryDirectory, scanTree } from './log-explorer.mjs';
import { memoryFolderStore, openFolderStore } from './folder-store.mjs';

export function folderSupport(win = typeof window === 'undefined' ? undefined : window) {
  if (!win) return 'none';
  if (typeof win.showDirectoryPicker === 'function' && win.isSecureContext !== false) return 'picker';
  if (win.HTMLInputElement && 'webkitdirectory' in win.HTMLInputElement.prototype) return 'input';
  return 'none';
}
export const nodeKey = (folderId, path = '') => `${folderId}:${path}`;
const permission = async handle => { try { return handle.queryPermission ? await handle.queryPermission({ mode: 'read' }) : 'granted'; } catch { return 'prompt'; } };
const statusOf = state => state === 'granted' ? 'ready' : state === 'denied' ? 'denied' : 'prompt';
const listingError = error => error?.name === 'NotFoundError' ? 'missing' : ['NotAllowedError', 'SecurityError'].includes(error?.name) ? 'prompt' : null;
const NOT_REMEMBERED = 'This browser can’t remember folders; they stay listed until reload.';
const newId = () => globalThis.crypto?.randomUUID?.() ?? String(Date.now() + Math.random());

// Plain controller (testable without React). State snapshots are replaced on every change.
export class LogExplorerController {
  constructor({ limits = EXPLORER_LIMITS, openStore = openFolderStore, support = folderSupport(), picker = () => window.showDirectoryPicker({ id: 'network-log-lab', mode: 'read' }), progressMs = 150, clock = () => Date.now() } = {}) {
    Object.assign(this, { limits: { ...EXPLORER_LIMITS, ...limits }, openStore, support, picker, progressMs, clock });
    // Tree nodes and sections default open; only user-collapsed keys are kept (shared by the nav and the sheet).
    this.state = { folders: [], listings: {}, collapsed: new Set(), shown: {}, notice: '', storageNotice: '', focusId: null, durable: null };
    this.listeners = new Set(); this.scans = new Map(); this.heads = limiter(this.limits.concurrency); this.store = null; this.disposed = false;
    this.subscribe = this.subscribe.bind(this); this.getState = () => this.state;
    for (const name of ['init', 'toggle', 'showMore', 'addFolder', 'addFiles', 'remove', 'refresh', 'reconnect', 'clearFocus']) this[name] = this[name].bind(this);
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  _set(patch) { if (this.disposed) return; const next = typeof patch === 'function' ? patch(this.state) : patch; this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener(); }
  _folder(id) { return this.state.folders.find(f => f.id === id); }
  _setFolder(id, patch) { this._set(s => ({ folders: s.folders.map(f => f.id === id ? { ...f, ...patch } : f) })); }

  // Resolves once the store is known; inserts wait for it so persistence never races startup.
  init() {
    this.ready ??= (async () => {
      let store, durable = true;
      try { store = await this.openStore(); } catch { store = memoryFolderStore(); durable = false; }
      if (this.disposed) { store.close(); return; }
      this.store = store;
      this._set({ durable, storageNotice: durable || this.support !== 'picker' ? '' : NOT_REMEMBERED });
      let records = [];
      try { records = await store.list(); } catch {}
      const restored = await Promise.all(records.filter(r => r?.handle).map(async r => ({ id: r.id, name: r.name || r.handle.name, handle: r.handle, added: r.added, persisted: durable, status: statusOf(await permission(r.handle)) })));
      const added = restored.filter(r => !this.state.folders.some(f => f.id === r.id));
      this._set(s => ({ folders: [...added, ...s.folders] }));
      // Restored folders scan one after another; head reads are also bounded across folders by this.heads.
      (async () => { for (const folder of added) if (folder.status === 'ready' && this._folder(folder.id)) await this.load(folder.id, folder.handle); })();
    })();
    return this.ready;
  }
  dispose() { this.disposed = true; for (const scan of this.scans.values()) scan.abort(); this.scans.clear(); this.store?.close(); this.store = null; }

  _abort(prefix) { for (const [key, scan] of this.scans) if (key.startsWith(prefix)) { scan.abort(); this.scans.delete(key); } }
  // One bounded recursive scan per folder; a newer scan, Refresh or Remove aborts the previous one.
  async load(folderId, handle) {
    const key = nodeKey(folderId), controller = new AbortController();
    this.scans.get(key)?.abort(); this.scans.set(key, controller);
    // The previous tree stays visible while a refresh scans.
    const previous = headerIndex(this.state.listings[key]?.entries);
    this._set(s => ({ listings: { ...s.listings, [key]: { ...s.listings[key], state: 'loading', progress: '' } } }));
    const current = () => this.scans.get(key) === controller && !controller.signal.aborted && !!this._folder(folderId);
    let shown = 0;
    const onProgress = (found, read) => {
      const at = this.clock(); if (at - shown < this.progressMs || !current()) return; shown = at;
      const progress = read == null ? `${found} logs` : `${read}/${found} logs`;
      this._set(s => s.listings[key]?.state === 'loading' ? { listings: { ...s.listings, [key]: { ...s.listings[key], progress } } } : {});
    };
    try {
      const result = await scanTree(handle, { limits: this.limits, signal: controller.signal, onProgress, limit: this.heads, previous });
      if (!current()) return;
      this.scans.delete(key);
      // A snapshot capped while it was built is reported like a scan that hit the entry limit.
      this._set(s => ({ listings: { ...s.listings, [key]: { state: 'ready', ...result, truncated: result.truncated || !!handle.truncated, at: this.clock() } } }));
      if (this._folder(folderId)?.status !== 'ready') this._setFolder(folderId, { status: 'ready' });
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      this.scans.delete(key);
      this._set(s => ({ listings: { ...s.listings, [key]: { state: 'error', error: error?.message || 'Folder could not be read' } } }));
      const status = listingError(error);
      if (status) this._setFolder(folderId, { status });
    }
  }
  toggle(key, open) {
    const { collapsed } = this.state;
    if (collapsed.has(key) === !open) return;
    const next = new Set(collapsed); open ? next.delete(key) : next.add(key); this._set({ collapsed: next });
  }
  // Rendered logs per folder level grow a page at a time.
  showMore(key) { this._set(s => ({ shown: { ...s.shown, [key]: (s.shown[key] ?? this.limits.pageLogs) + this.limits.pageLogs } })); }
  async _insert(handle, remember) {
    for (const folder of this.state.folders) {
      try { if (folder.handle === handle || await folder.handle.isSameEntry?.(handle)) { this._set({ focusId: folder.id, notice: `${folder.name}/ is already listed.` }); return folder.id; } } catch {}
    }
    if (this.state.folders.length >= this.limits.maxFolders) { this._set({ notice: `Remove a folder first; up to ${this.limits.maxFolders} folders can be listed.` }); return null; }
    const folder = { id: newId(), name: handle.name, handle, added: this.clock(), persisted: false, status: 'ready' };
    if (remember) {
      await this.init();
      if (this.state.durable) {
        try { await this.store.put(folder); folder.persisted = true; } catch { this._set({ storageNotice: NOT_REMEMBERED }); }
      }
    }
    if (this.disposed) return null;
    this._set(s => ({ folders: [...s.folders, folder], collapsed: new Set([...s.collapsed].filter(key => key !== 'machine')), focusId: folder.id }));
    this.load(folder.id, handle);
    return folder.id;
  }
  async addFolder() {
    this._set({ notice: '' });
    let handle;
    try { handle = await this.picker(); }
    catch (error) { if (error?.name !== 'AbortError') this._set({ notice: `Folder not added: ${error?.message || 'access was not granted'}` }); return null; }
    return this._insert(handle, true);
  }
  addFiles(fileList) {
    this._set({ notice: '' });
    const handle = memoryDirectory(fileList, { maxFiles: this.limits.maxScanned });
    if (!handle.count) { this._set({ notice: 'The chosen folder has no .ndjson logs.' }); return Promise.resolve(null); }
    return this._insert(handle, false);
  }
  async remove(id) {
    const folder = this._folder(id); if (!folder) return false;
    // Persist first so the row only disappears once a reload would agree.
    if (folder.persisted) {
      try { await this.store.delete(id); }
      catch (error) { this._set({ notice: `Couldn’t remove ${folder.name}/: ${error?.message || 'storage error'}` }); return false; }
    }
    this._abort(id + ':');
    const own = key => key.startsWith(id + ':');
    this._set(s => ({ folders: s.folders.filter(f => f.id !== id), listings: Object.fromEntries(Object.entries(s.listings).filter(([key]) => !own(key))), collapsed: new Set([...s.collapsed].filter(key => !own(key))), shown: Object.fromEntries(Object.entries(s.shown).filter(([key]) => !own(key))), notice: `Removed ${folder.name}/ from the explorer. Files on disk are unchanged.` }));
    return true;
  }
  refresh(id) {
    const folder = this._folder(id); if (!folder || folder.status !== 'ready') return;
    this.load(id, folder.handle);
  }
  async reconnect(id) {
    const folder = this._folder(id); if (!folder) return;
    let state;
    try { state = folder.handle.requestPermission ? await folder.handle.requestPermission({ mode: 'read' }) : 'granted'; }
    catch (error) { this._set({ notice: `Access not granted: ${error?.message || 'try again'}` }); return; }
    const status = statusOf(state);
    if (!this._folder(id)) return;
    this._setFolder(id, { status });
    if (status === 'ready') { this._set(s => ({ collapsed: new Set([...s.collapsed].filter(key => key !== nodeKey(id))) })); this.load(id, folder.handle); }
  }
  clearFocus(id) { if (this.state.focusId && (id === undefined || this.state.focusId === id)) this._set({ focusId: null }); }
}

// Explorer state lives in App so the nav and the mobile sheet render one shared tree.
export function useLogExplorer(options) {
  const ref = useRef(null);
  ref.current ??= new LogExplorerController(options);
  const controller = ref.current;
  useEffect(() => { controller.init(); return () => controller.dispose(); }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  // Stable actions let memoized folder rows skip renders caused by other folders' progress.
  const actions = useMemo(() => ({ nodeKey, limits: controller.limits, toggle: controller.toggle, showMore: controller.showMore, remove: controller.remove, refresh: controller.refresh, reconnect: controller.reconnect }), [controller]);
  return useMemo(() => ({ ...state, ...actions, actions, support: controller.support, addFolder: controller.addFolder, addFiles: controller.addFiles, clearFocus: controller.clearFocus }), [state, actions, controller]);
}
