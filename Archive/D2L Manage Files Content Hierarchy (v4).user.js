// ==UserScript==
// @name         D2L Manage Files Content Hierarchy (v4)
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  Fast parallel Manage Files annotator. Discovers content hierarchy concurrently, re-annotates on any table change (sort, reorder, lazy-load), no stale DOM references.
// @match        https://brightspace.rcpi.ie/d2l/lp/manageFiles/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────

  const CFG = {
    leVersion: 'unstable',
    versionsEndpoint: '/d2l/api/le/versions/',
    rootEndpoint:            (ou, ver)          => `/d2l/api/le/${ver}/${ou}/content/root/`,
    moduleStructureEndpoint: (ou, ver, moduleId) => `/d2l/api/le/${ver}/${ou}/content/modules/${moduleId}/structure/`,
    topicEndpoint:           (ou, ver, topicId)  => `/d2l/api/le/${ver}/${ou}/content/topics/${topicId}`,

    rowCheckboxSelector: 'input[name="z_o_s"]',
    annotationAttr:      'data-d2l-content-hierarchy',
    renderAttr:          'data-d2l-content-hierarchy-rendered',

    // Parallel topic fetches. No artificial inter-request delay — browser
    // connection pooling handles back-pressure naturally.
    topicConcurrency: 12,

    // Module structure fetches are cheaper and fan out quickly; run them all
    // concurrently via Promise.all rather than serialising.

    // How long to wait after the last DOM mutation before re-annotating.
    // Keeps annotation out of mid-scroll jank.
    domDebounceMs: 80,

    debugPrefix: '[D2L-MF-HIER]',
  };

  // ─── Globals ────────────────────────────────────────────────────────────────

  const _fetch = window.fetch.bind(window);

  let cachedVersion = null;
  let ou             = null;
  let booted         = false;
  let paused         = false;
  let observer       = null;
  let observerRoot   = null;
  let domDebounce    = null;

  // pathMap:  normalised full path (lower) → hierarchy string[]
  // fileMap:  filename lower              → { path, hierarchy, topicId, title }[]
  //
  // Neither map holds DOM references — they are pure data and survive table
  // sorts / virtual-scroll replacements intact.
  const pathMap  = new Map();
  const fileMap  = new Map();

  // Topic/module dedup sets and the async topic queue.
  const queueSeen        = new Set();
  const topicsResolved   = new Set();
  const modulesResolved  = new Set();
  const topicQueue       = [];      // { topicId, trail }
  let   activeWorkers    = 0;
  let   doneDiscovering  = false;

  const stats = {
    discoveredTopics: 0,
    fetchedTopics: 0,
    fileTopics: 0,
    mappedTopics: 0,
    directPathHits: 0,
    filenameFallbackHits: 0,
    ambiguousFilenameHits: 0,
    skippedNonFileTopics: 0,
    skippedNoHtmlUrl: 0,
    moduleRequests: 0,
    annotationPasses: 0,
    domMutationBursts: 0,
    errors: [],
    topicSamples: [],
  };

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function dbg(...a)  { try { console.debug(CFG.debugPrefix, ...a); } catch (_) {} }
  function warn(...a) { try { console.warn(CFG.debugPrefix,  ...a); } catch (_) {} }

  function getOu() {
    const m1 = location.search.match(/[?&]ou=(\d+)/);
    if (m1) return m1[1];
    const m2 = location.pathname.match(/\/(\d+)(?:\/|$)/);
    return m2 ? m2[1] : null;
  }

  async function resolveVersion() {
    if (cachedVersion) return cachedVersion;
    if (CFG.leVersion && CFG.leVersion !== 'auto') {
      cachedVersion = CFG.leVersion;
      return cachedVersion;
    }
    try {
      const r   = await _fetch(CFG.versionsEndpoint, { credentials: 'include' });
      const arr = await r.json();
      const le  = Array.isArray(arr) ? (arr.find(x => x.ProductCode === 'LE') || arr[0]) : null;
      cachedVersion = (le && le.LatestVersion) || 'unstable';
    } catch (_) {
      cachedVersion = 'unstable';
    }
    return cachedVersion;
  }

  async function getJson(url) {
    const res = await _fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  function htmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Path normalisation ─────────────────────────────────────────────────────
  //
  // D2L stores topic URLs as something like:
  //   /content/enforced/12345-COURSECODE/Module1/topic.html
  // Manage Files row values look like:
  //   f_/content/enforced/12345-COURSECODE/Module1/topic.html
  //
  // We strip both prefixes down to the bare relative path so they compare
  // cleanly: "Module1/topic.html".

  function stripSchemeAndHost(p) {
    return String(p || '').split('?')[0].replace(/^https?:\/\/[^/]+/i, '');
  }

  function stripContentEnforced(p) {
    return p
      .replace(/^f_\/?/i, '')
      .replace(/^d_\/?/i, '')
      .replace(/^\/+/, '')
      .replace(/^content\/enforced\/\d+-[^/]+\//i, '')
      .replace(/^content\/enforced\/\d+\//i, '')
      .replace(/^content\/[^/]+\//i, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }

  function normalisePath(raw) {
    return stripContentEnforced(stripSchemeAndHost(raw));
  }

  function filenameFromPath(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    let last = parts.pop() || p;
    try { last = decodeURIComponent(last); } catch (_) {}
    return last;
  }

  // ─── DOM helpers (stateless — never cache tr references) ────────────────────
  //
  // Every function that needs a <tr> queries fresh from the live document.
  // This is the key fix for sort/reorder breakage: we never hold stale nodes.

  function allFileRows(root = document) {
    const rows = [];
    for (const cb of root.querySelectorAll(CFG.rowCheckboxSelector)) {
      const tr = cb.closest('tr');
      if (tr) rows.push(tr);
    }
    return rows;
  }

  function rowRawValue(tr) {
    return tr?.querySelector(CFG.rowCheckboxSelector)?.value || null;
  }

  function rowPath(tr) {
    const raw = rowRawValue(tr);
    if (!raw || !/^f_/i.test(raw)) return null;
    return normalisePath(raw);
  }

  function rowFilename(tr) {
    const raw = rowRawValue(tr);
    if (!raw) return null;
    return filenameFromPath(normalisePath(raw));
  }

  function rowIsHtml(tr) {
    const p = rowPath(tr);
    return !!(p && /\.html?$/i.test(p));
  }

  // Return the <td> that contains the file link (prefer one whose link text
  // looks like an HTML filename, fall back to first link cell).
  function rowNameCell(tr) {
    const cells = Array.from(tr.querySelectorAll('td'));
    for (const td of cells) {
      const link = td.querySelector('a[href]');
      if (link && /\.html?$/i.test((link.textContent || '').trim())) return td;
    }
    return cells.find(td => td.querySelector('a[href]')) || null;
  }

  // ─── Annotation rendering ───────────────────────────────────────────────────
  //
  // We key each rendered annotation by a deterministic hash of its content so
  // we skip the DOM write when nothing changed (idempotent re-runs on re-sort).

  function renderKey(hierarchies, mode) {
    return mode + '|' + [...hierarchies].sort().join('\x00');
  }

  function getOrCreateAnnotationHost(td) {
    let host = td.querySelector(`[${CFG.annotationAttr}="1"]`);
    if (!host) {
      host = document.createElement('div');
      host.setAttribute(CFG.annotationAttr, '1');
      td.appendChild(host);
    }
    return host;
  }

  const PUBLIC_FILES_OU = '6606';

  function isPublicFilesPage() {
    return getOu() === PUBLIC_FILES_OU;
  }

  function injectHierarchy(tr, hierarchies, mode = 'path') {
    if (!hierarchies || !hierarchies.length) return false;
    const td = rowNameCell(tr);
    if (!td) return false;

   let lines;
    if (isPublicFilesPage()) {
      // For the public files OU, show the direct file path instead of content hierarchy.
      const path = rowPath(tr);
      lines = path ? [`/shared/${path}`] : hierarchies
        .map(h => typeof h === 'string' ? h : h.hierarchy)
        .filter(Boolean);
    } else {
      lines = hierarchies
        .map(h => typeof h === 'string' ? h : h.hierarchy)
        .filter(Boolean);
    }
    if (!lines.length) return false;

    const host   = getOrCreateAnnotationHost(td);
    const newKey = renderKey(lines, mode);
    if (host.dataset.renderKey === newKey) return false; // nothing changed

    const frag = document.createDocumentFragment();
    for (const text of lines) {
      const line = document.createElement('div');
      line.style.cssText = [
        'margin:2px 0 0 22px',
        'padding:2px 6px',
        'font-size:11px',
        'line-height:1.35',
        'white-space:normal',
        'word-break:break-word',
        'border-left:2px solid ' + (mode === 'filename' ? '#d6bcfa' : '#cbd5e0'),
        'background:'            + (mode === 'filename' ? '#faf5ff' : '#f8fafc'),
        'color:#5f6b7a',
        'border-radius:2px',
      ].join(';');
     line.innerHTML =
        `<span style="font-weight:600;color:#4a5568;">` +
        `${isPublicFilesPage() ? 'Path' : `Content${mode === 'filename' ? ' (filename)' : ''}`}:</span> ` +
        `<span>${htmlEscape(text)}</span>`;
      frag.appendChild(line);
    }

    host.replaceChildren(frag);
    host.dataset.renderKey = newKey;
    tr.setAttribute(CFG.renderAttr, '1');
    return true;
  }

  function clearAnnotations() {
    for (const el of document.querySelectorAll(`[${CFG.annotationAttr}="1"]`)) {
      el.remove();
    }
    for (const tr of allFileRows()) {
      tr.removeAttribute(CFG.renderAttr);
    }
  }

  // ─── Per-row annotation logic ───────────────────────────────────────────────

  function annotateRow(tr) {
    if (isPublicFilesPage()) {
      const raw = rowRawValue(tr);
      if (!raw || !/^f_/i.test(raw)) return false;
      const displayPath = '/' + raw.replace(/^f_\/*/i, '');
      const td = rowNameCell(tr);
      if (!td) return false;
      const host = getOrCreateAnnotationHost(td);
      const newKey = 'public|' + displayPath;
      if (host.dataset.renderKey === newKey) return false;
      const line = document.createElement('div');
      line.style.cssText = [
        'margin:2px 0 0 22px',
        'padding:2px 6px',
        'font-size:11px',
        'line-height:1.35',
        'white-space:normal',
        'word-break:break-word',
        'border-left:2px solid #a3c4f3',
        'background:#f0f6ff',
        'color:#5f6b7a',
        'border-radius:2px',
      ].join(';');
      line.innerHTML = `<span>${htmlEscape(displayPath)}</span>`;
      host.replaceChildren(line);
      host.dataset.renderKey = newKey;
      tr.setAttribute(CFG.renderAttr, '1');
      return true;
    }

    const path     = rowPath(tr);
    const filename = rowFilename(tr);
    if (!path || !filename) return false;

    const pk = path.toLowerCase();
    const fk = filename.toLowerCase();

    // 1. Exact path match — most reliable.
    const byPath = pathMap.get(pk);
    if (byPath && byPath.length) {
      stats.directPathHits++;
      return injectHierarchy(tr, byPath, 'path');
    }

    // 2. Filename fallback.
    const byFile = fileMap.get(fk);
    if (!byFile || !byFile.length) return false;

    // Prefer entries whose stored path matches exactly.
    const exact = byFile.filter(x => (x.path || '').toLowerCase() === pk);
    if (exact.length) {
      stats.directPathHits++;
      return injectHierarchy(tr, exact, 'path');
    }

    // If only one entry exists for this filename it's unambiguous.
    if (byFile.length === 1) {
      stats.filenameFallbackHits++;
      return injectHierarchy(tr, byFile, 'filename');
    }

    // Multiple entries — narrow by which paths are visible in the current
    // table view (query live DOM, no stale cache).
    const visiblePaths = new Set(
      allFileRows()
        .filter(rowIsHtml)
        .map(r => (rowPath(r) || '').toLowerCase())
    );
    const candidates = byFile.filter(x => visiblePaths.has((x.path || '').toLowerCase()));
    if (candidates.length === 1) {
      stats.filenameFallbackHits++;
      return injectHierarchy(tr, candidates, 'filename');
    }

    stats.ambiguousFilenameHits++;
    return false;
  }

  // ─── Full annotation pass ───────────────────────────────────────────────────
  //
  // Called fresh on every debounced DOM mutation — no stale state, no caches
  // to invalidate.  Cheap enough to run repeatedly (pure DOM reads + map
  // lookups; no network).

  function annotateRows(root = document) {
    stats.annotationPasses++;
    for (const tr of allFileRows(root)) {
      if (isPublicFilesPage()) {
        annotateRow(tr);
      } else {
        if (!rowIsHtml(tr)) continue;
        annotateRow(tr);
      }
    }
  }

  // Re-annotate every HTML row whose filename matches a given key.  Called
  // immediately when a new topic mapping arrives so in-view rows light up
  // without waiting for the next full DOM scan.
  function annotateByFilename(fk) {
    for (const tr of allFileRows()) {
      if (!rowIsHtml(tr)) continue;
      if ((rowFilename(tr) || '').toLowerCase() === fk) annotateRow(tr);
    }
  }

  // ─── Debounced DOM scan ─────────────────────────────────────────────────────

  function scheduleDomScan() {
    if (domDebounce) clearTimeout(domDebounce);
    domDebounce = setTimeout(() => {
      domDebounce = null;
      annotateRows(document);
    }, CFG.domDebounceMs);
  }

  // ─── MutationObserver ───────────────────────────────────────────────────────
  //
  // Watch for ANY childList change inside the table container — this catches
  // lazy-loaded rows, sort-induced reorders, and virtual-scroll replacements.
  // We do NOT try to be clever about which rows changed; we just re-annotate
  // the whole table (it's fast).

  function findObserverRoot() {
    const cb = document.querySelector(CFG.rowCheckboxSelector);
    if (!cb) return document.documentElement;
    // Walk up to find the smallest ancestor that contains all rows.
    let el = cb.closest('tbody') || cb.closest('table') || cb.closest('tr')?.parentElement;
    return el || document.documentElement;
  }

  function installObserver() {
    if (observer) return;
    observerRoot = findObserverRoot();
    observer = new MutationObserver(() => {
      stats.domMutationBursts++;
      scheduleDomScan();
    });
    observer.observe(observerRoot, { childList: true, subtree: true });
    dbg('observer installed on', observerRoot.tagName || observerRoot);
  }

  // ─── Content API helpers ────────────────────────────────────────────────────

  function itemTitle(item) {
    return (
      item?.Title || item?.title || item?.ShortTitle || item?.shortTitle ||
      item?.Name  || item?.name  || item?.TopicTitle || item?.ModuleTitle || ''
    ).trim();
  }

  function itemId(item) {
    return item?.Id ?? item?.id ?? item?.TopicId ?? item?.ModuleId ?? null;
  }

  function itemType(item) {
    const t = item?.Type ?? item?.type ?? item?.TopicType ?? null;
    return typeof t === 'string' ? t.toLowerCase() : t;
  }

  function looksLikeTopic(item) {
    const t = itemType(item);
    if (typeof t === 'string') return t.includes('topic');
    return t === 1 || t === 3 || t === 4 || !!(item && ('TopicType' in item || 'Url' in item));
  }

  function looksLikeModule(item) {
    const t = itemType(item);
    if (typeof t === 'string') return t.includes('module');
    return t === 0 || !!(item && (Array.isArray(item.Modules) || Array.isArray(item.Topics) || Array.isArray(item.Items)));
  }

  function childrenOf(structure) {
    if (!structure || typeof structure !== 'object') return [];
    if (Array.isArray(structure)) return structure;
    const buckets = [
      structure.Modules, structure.Topics, structure.Items,
      structure.ContentObjects, structure.Children, structure.Structure,
      structure.modules, structure.topics, structure.items, structure.children,
    ].filter(Array.isArray);
    if (buckets.length) return buckets.flat();
    const arrays = Object.values(structure).filter(Array.isArray);
    return arrays.length ? arrays.flat() : [];
  }

  // ─── Data store ─────────────────────────────────────────────────────────────

  function addTopicMapping(topicId, title, rawPath, hierarchy) {
    const path = normalisePath(rawPath);
    const pk   = path.toLowerCase();
    const fk   = filenameFromPath(path).toLowerCase();

    if (!pathMap.has(pk)) pathMap.set(pk, []);
    const pa = pathMap.get(pk);
    if (!pa.includes(hierarchy)) pa.push(hierarchy);

    if (!fileMap.has(fk)) fileMap.set(fk, []);
    const fa = fileMap.get(fk);
    if (!fa.some(x => x.path === path && x.hierarchy === hierarchy)) {
      fa.push({ topicId, title, path, hierarchy });
    }

    // Immediately update any rows already in the DOM for this file.
    annotateByFilename(fk);
  }

  // ─── Topic worker pool ──────────────────────────────────────────────────────
  //
  // Topics are fetched concurrently up to CFG.topicConcurrency.  No artificial
  // inter-request sleep — the browser's own connection pool throttles naturally.

  function queueTopic(topicId, trail) {
    if (!topicId || queueSeen.has(topicId)) return;
    queueSeen.add(topicId);
    topicQueue.push({ topicId, trail });
    stats.discoveredTopics++;
    kickWorkers();
  }

  async function processTopic({ topicId, trail }) {
    stats.fetchedTopics++;
    let data;
    try {
      const ver = await resolveVersion();
      data = await getJson(CFG.topicEndpoint(ou, ver, topicId));
    } catch (e) {
      stats.errors.push({ where: 'topicEndpoint', topicId, error: String(e) });
      warn('topic GET failed', topicId, e);
      return;
    }

    if (stats.topicSamples.length < 20) {
      stats.topicSamples.push({
        topicId,
        title: data?.Title ?? data?.title ?? '',
        TopicType: data?.TopicType ?? data?.type ?? null,
        Url: data?.Url ?? data?.url ?? null,
      });
    }

    // TopicType 1 = file topic; everything else (links, surveys, etc.) skipped.
    if ((data?.TopicType ?? data?.type) !== 1) {
      stats.skippedNonFileTopics++;
      return;
    }

    stats.fileTopics++;

    const url = data?.Url ?? data?.url ?? null;
    if (!url || typeof url !== 'string' || !/\.html?(\?|$)/i.test(url)) {
      stats.skippedNoHtmlUrl++;
      return;
    }

    const path = normalisePath(url.split('?')[0]);
    if (!path) { stats.skippedNoHtmlUrl++; return; }

    const title     = (data?.Title ?? data?.title ?? trail[trail.length - 1] ?? '').trim();
    const hierarchy = trail.join(' > ');
    addTopicMapping(topicId, title, path, hierarchy);
    stats.mappedTopics++;
  }

  async function workerLoop() {
    while (!paused && topicQueue.length) {
      const job = topicQueue.shift();
      if (!job) return;
      if (topicsResolved.has(job.topicId)) continue;
      topicsResolved.add(job.topicId);
      await processTopic(job);
    }
  }

  function kickWorkers() {
    if (paused) return;
    while (activeWorkers < CFG.topicConcurrency && topicQueue.length > 0) {
      activeWorkers++;
      workerLoop()
        .catch(e => stats.errors.push({ where: 'workerLoop', error: String(e) }))
        .finally(() => {
          activeWorkers--;
          if (!paused && topicQueue.length > 0) kickWorkers();
          if (activeWorkers === 0 && doneDiscovering) {
            dbg('all topics resolved — final annotation pass');
            annotateRows(document);
          }
        });
    }
  }

  // ─── Content hierarchy discovery ────────────────────────────────────────────
  //
  // Key change from v3: module structure fetches are fired concurrently with
  // Promise.all rather than awaited one-by-one.  Discovery is therefore limited
  // only by network, not by sequential JavaScript.

  async function discoverItems(items, trail, ver) {
    // Split into topics (cheap, just queue them) and modules (need a fetch).
    const moduleJobs = [];

    for (const item of items) {
      const title     = itemTitle(item);
      const nextTrail = title ? [...trail, title] : [...trail];

      if (looksLikeTopic(item)) {
        const tid = itemId(item);
        if (tid) queueTopic(tid, nextTrail);
        continue;
      }

      if (looksLikeModule(item)) {
        const mid = itemId(item);
        if (!mid || modulesResolved.has(mid)) continue;
        modulesResolved.add(mid);
        stats.moduleRequests++;
        moduleJobs.push({ mid, nextTrail });
      }
    }

    if (!moduleJobs.length) return;

    // Fetch all sibling module structures in parallel.
    await Promise.all(moduleJobs.map(async ({ mid, nextTrail }) => {
      let struct;
      try {
        struct = await getJson(CFG.moduleStructureEndpoint(ou, ver, mid));
      } catch (e) {
        stats.errors.push({ where: 'moduleStructureEndpoint', moduleId: mid, error: String(e) });
        warn('module structure GET failed', mid, e);
        return;
      }
      const kids = childrenOf(struct);
      if (kids.length) await discoverItems(kids, nextTrail, ver);
    }));
  }

  async function startDiscovery() {
    const ver  = await resolveVersion();
    const root = await getJson(CFG.rootEndpoint(ou, ver));
    await discoverItems(childrenOf(root), [], ver);
    doneDiscovering = true;
    dbg('discovery complete', {
      discoveredTopics: stats.discoveredTopics,
      moduleRequests:   stats.moduleRequests,
    });
    // Kick any topics that arrived while the last worker finished.
    kickWorkers();
    // If all workers had already drained, do a final pass now.
    if (activeWorkers === 0) annotateRows(document);
  }

  // ─── Debug / console API ────────────────────────────────────────────────────

  function progress() {
    return {
      discoveredTopics:      stats.discoveredTopics,
      fetchedTopics:         stats.fetchedTopics,
      mappedTopics:          stats.mappedTopics,
      fileTopics:            stats.fileTopics,
      activeWorkers,
      queueLength:           topicQueue.length,
      pathMapSize:           pathMap.size,
      fileMapSize:           fileMap.size,
      directPathHits:        stats.directPathHits,
      filenameFallbackHits:  stats.filenameFallbackHits,
      ambiguousFilenameHits: stats.ambiguousFilenameHits,
      doneDiscovering,
      paused,
    };
  }

  function htmlRows(limit = 50) {
    return allFileRows()
      .filter(rowIsHtml)
      .slice(0, limit)
      .map(tr => ({
        raw:      rowRawValue(tr),
        path:     rowPath(tr),
        filename: rowFilename(tr),
        rendered: tr.getAttribute(CFG.renderAttr) === '1',
      }));
  }

  function matchedRows(limit = 50) {
    return allFileRows()
      .filter(rowIsHtml)
      .map(tr => {
        const path     = rowPath(tr);
        const filename = rowFilename(tr);
        return {
          raw:      rowRawValue(tr),
          path,
          filename,
          rendered: tr.getAttribute(CFG.renderAttr) === '1',
          byPath:   pathMap.get((path     || '').toLowerCase()) || [],
          byFile:   fileMap.get((filename || '').toLowerCase()) || [],
        };
      })
      .filter(x => x.byPath.length || x.byFile.length)
      .slice(0, limit);
  }

  function unmatchedRows(limit = 50) {
    return allFileRows()
      .filter(rowIsHtml)
      .map(tr => ({
        raw:      rowRawValue(tr),
        path:     rowPath(tr),
        filename: rowFilename(tr),
        rendered: tr.getAttribute(CFG.renderAttr) === '1',
      }))
      .filter(x =>
        !pathMap.has((x.path     || '').toLowerCase()) &&
        !fileMap.has((x.filename || '').toLowerCase())
      )
      .slice(0, limit);
  }

  function findMapByFilename(fragment) {
    const f = String(fragment || '').toLowerCase();
    return Array.from(fileMap.entries()).filter(([k]) => k.includes(f)).slice(0, 50);
  }

  async function fetchTopic(topicId) {
    const ver  = await resolveVersion();
    const data = await getJson(CFG.topicEndpoint(ou, ver, topicId));
    console.log(CFG.debugPrefix, 'topic', topicId, data);
    return data;
  }

  function stop()   { paused = true; }
  function resume() { paused = false; kickWorkers(); }

  function scanNow() {
    annotateRows(document);
    return progress();
  }

  async function rebuild() {
    clearAnnotations();
    paused = false;

    pathMap.clear();
    fileMap.clear();
    topicQueue.length = 0;
    queueSeen.clear();
    topicsResolved.clear();
    modulesResolved.clear();
    activeWorkers   = 0;
    doneDiscovering = false;

    Object.assign(stats, {
      discoveredTopics: 0, fetchedTopics: 0, fileTopics: 0, mappedTopics: 0,
      directPathHits: 0, filenameFallbackHits: 0, ambiguousFilenameHits: 0,
      skippedNonFileTopics: 0, skippedNoHtmlUrl: 0, moduleRequests: 0,
      annotationPasses: 0, domMutationBursts: 0, errors: [], topicSamples: [],
    });

    annotateRows(document);
    await startDiscovery();
    return progress();
  }

  // ─── Public console API ─────────────────────────────────────────────────────

  window.D2L_MF_HIER = {
    cfg: CFG,
    getOu:        () => ou,
    getVersion:   () => cachedVersion,
    getMap:       () => pathMap,
    getFileMap:   () => fileMap,
    getStats:     () => ({ ...stats }),
    progress,
    htmlRows,
    matchedRows,
    unmatchedRows,
    findMapByFilename,
    normalisePath,
    rowPath,
    rowFilename,
    rowIsHtml,
    fetchTopic,
    clearAnnotations,
    scanNow,
    stop,
    resume,
    rebuild,
  };

  // ─── Boot ───────────────────────────────────────────────────────────────────

  async function init() {
    if (booted) return;
    booted = true;

    ou = getOu();
    if (!ou) { warn('no ou detected — cannot start'); return; }

    dbg('starting, ou =', ou);

    // Annotate whatever is already in the DOM (no-op on first boot, but useful
    // after a rebuild or hot-reload).
    annotateRows(document);

    // Watch for table changes (sort, lazy-load, virtual scroll).
    installObserver();

    // Kick off parallel discovery — this populates pathMap/fileMap and triggers
    // annotateByFilename as each topic resolves.
    startDiscovery().catch(e => {
      stats.errors.push({ where: 'startDiscovery', error: String(e) });
      warn('discovery failed', e);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();