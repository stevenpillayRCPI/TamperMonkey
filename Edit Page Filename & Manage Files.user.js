// ==UserScript==
// @name         Edit Page Filename & Manage Files
// @namespace    http://tampermonkey.net/
// @version      6.4
// @description  On existing pages: reads the topic id from the URL, GETs the documented content-topic endpoint, and shows the real backend filename from its Url. The "Manage Files" button hands the target path to the companion Locator script via localStorage, then opens the Manage Files popup. v6.1: self-heals the label when the Lit title component re-renders/swaps during load (fixes flash-then-vanish), and dedupes inside the host's shadow root. No sniffing, no base64.
// @match        https://brightspace.rcpi.ie/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // CONFIG  — if D2L changes something, this is the only place to edit
  // ============================================================
  const CFG = {
    // documented LE API. 'unstable' matches what this instance's UI uses;
    // pin to a number (e.g. '1.74') if you ever want it fixed.
    leVersion: 'unstable',
    versionsEndpoint: '/d2l/api/le/versions/',
    topicEndpoint: (ou, ver, topicId) =>
      `/d2l/api/le/${ver}/${ou}/content/topics/${topicId}`,

    titleHostSelector: 'd2l-input-text#content-title',
    titleLabelPrefix: 'page title',           // guards against grabbing the wrong input
    editorSelector: 'd2l-activity-content-editor',

    idResolveTimeoutMs: 6000,                  // fail loud after this if no id found
    genericNames: [
      'untitled', 'summary', 'overview', 'introduction', 'intro',
      'page', 'content', 'new-page', 'topic', 'lesson', 'module',
    ],
  };

  // Shared with the companion "Manage Files Locator" script. Must match there.
  const HANDOFF_KEY = 'd2l-mf-target';

  // ============================================================
  // STATE
  // ============================================================
  let state = null;
  function freshState() {
    return {
      ou: null,
      topicId: null,
      filename: null,
      path: null,         // full enforced path incl. folders, handed to Manage Files
      fetchedFor: null,   // topicId we already looked up (dedupe)
    };
  }
// ============================================================
// GUARD — skip new-page contexts where no topic file exists yet
// ============================================================
function isNewPageContext() {
  // 1) URL flag — D2L sets this when creating a brand-new topic
  if (/[?&]isNew=true/i.test(location.search)) return true;

  // 2) "New Page" heading — present when the editor opens for a
  //    not-yet-saved HTML page. We avoid fragile IDs/classes and
  //    instead walk the shadow DOM to find the <h1> inside the
  //    navigation component, then test its text content.
  const navHost = deepQuerySelector(document, 'd2l-labs-navigation-immersive');
  if (navHost) {
    // The h1 may be in light DOM children or inside a shadow slot
    const h1 = navHost.querySelector('h1')
      ?? (navHost.shadowRoot && navHost.shadowRoot.querySelector('h1'));
    if (h1 && h1.textContent.trim() === 'New Page') return true;
  }
  return false;
}
  // ============================================================
  // URL / ID RESOLUTION
  // ============================================================
  function getOu() {
    const m = location.href.match(/[?&]ou=(\d+)/);
    if (m) return m[1];
    const m2 = location.pathname.match(/\/lessons\/(\d+)\//);
    if (m2) return m2[1];
    const m3 = location.pathname.match(/\/(\d+)\//);
    return m3 ? m3[1] : null;
  }

  // topic id from the URL. Two shapes, both reliable:
  //   content view: /lessons/{ou}/topics/{id}
  //   edit view:    /lessons/{ou}/edit/{activityId}/loadActivity/file/{topicId}
  // The trailing file/{id} IS the topic id (confirmed: /topics/57361 == file/57361).
  function topicIdFromLocation() {
    const edit = location.pathname.match(/\/loadActivity\/file\/(\d+)/);
    if (edit) return edit[1];
    const view = location.pathname.match(/\/topics?\/(\d+)(?:$|\/|\?)/);
    return view ? view[1] : null;
  }

  function isEditableContext() {
    if (document.querySelector(CFG.editorSelector)) return true;
    return /\/(topics?|edit)\//.test(location.pathname);
  }

  // ============================================================
  // We keep a private, un-wrappable reference to the real fetch so our
  // own GET can't be intercepted or broken by the SPA reassigning fetch.
  // ============================================================
  const _fetch = window.fetch.bind(window);

  // ============================================================
  // AUTHORITATIVE LOOKUP: documented GET → Url → filename
  // ============================================================
  let cachedVersion = null;
  async function resolveVersion() {
    if (cachedVersion) return cachedVersion;
    if (CFG.leVersion && CFG.leVersion !== 'auto') { cachedVersion = CFG.leVersion; return cachedVersion; }
    try {
      const r = await _fetch(CFG.versionsEndpoint, { credentials: 'include' });
      const arr = await r.json();
      const le = Array.isArray(arr) ? arr.find(x => x.ProductCode === 'LE') || arr[0] : null;
      cachedVersion = (le && le.LatestVersion) || 'unstable';
    } catch (_) {
      cachedVersion = 'unstable';
    }
    return cachedVersion;
  }

  function parseTopic(data) {
    if (!data || typeof data !== 'object') return null;
    // 1) classic ContentObject — the clean, plaintext path
    if (typeof data.Url === 'string' && /\.(html?|htm)(\?|$)/i.test(data.Url)) {
      return fromPath(data.Url);
    }
    // 2) content-service shape — name is plaintext; path is a bonus only
    if (data.properties && data.properties.name) {
      return { filename: data.properties.name, path: data.properties.name };
    }
    // 3) last resort: scan for any .html path
    const hit = scanForHtml(data);
    return hit ? fromPath(hit) : null;
  }

  function fromPath(rawPath) {
    const clean = String(rawPath).split('?')[0];
    let last = clean.split('/').filter(Boolean).pop() || clean;
    try { last = decodeURIComponent(last); } catch (_) { /* keep raw */ }
    return { filename: last, path: clean };
  }

  function scanForHtml(obj, depth = 0) {
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && /\.(html?|htm)(\?|$)/i.test(v)) return v;
      if (v && typeof v === 'object') {
        const r = scanForHtml(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  async function runDetection() {
    if (!state || !state.ou || !state.topicId) return;
    if (state.fetchedFor === state.topicId) return;   // already done/in-flight
    state.fetchedFor = state.topicId;

    try {
      const ver = await resolveVersion();
      const url = CFG.topicEndpoint(state.ou, ver, state.topicId);
      const res = await _fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) { showError(`lookup failed (HTTP ${res.status})`); return; }
      const parsed = parseTopic(await res.json());
      if (parsed) {
        state.filename = parsed.filename;
        state.path = parsed.path;
        injectLabel();
      } else {
        showError('filename not in response');
      }
    } catch (e) {
      showError('lookup error');
    }
  }

  // ============================================================
  // DOM — label injection
  // ============================================================
  function deepQuerySelector(root, selector) {
    const found = root.querySelector(selector);
    if (found) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const r = deepQuerySelector(el.shadowRoot, selector);
        if (r) return r;
      }
    }
    return null;
  }

  // Same traversal, but collect every match across open shadow roots.
  function deepQuerySelectorAll(root, selector, acc = []) {
    for (const el of root.querySelectorAll(selector)) acc.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepQuerySelectorAll(el.shadowRoot, selector, acc);
    }
    return acc;
  }

  function labelMatches(el) {
    return (el.getAttribute('label') || '').toLowerCase().startsWith(CFG.titleLabelPrefix);
  }

  // Defense-in-depth: id and label are robust against DIFFERENT failures, so we
  // try them in confidence order rather than requiring both.
  //   1) id + label agree            → original strict match, most confident
  //   2) label-only (any input)      → survives the #content-title id being renamed
  //   3) id-only                     → survives the label changing / a non-English instance
  function getTitleHost() {
    const tag = CFG.titleHostSelector.split('#')[0];   // 'd2l-input-text'
    const byId = deepQuerySelector(document, CFG.titleHostSelector);

    if (byId && labelMatches(byId)) return byId;                 // 1
    const byLabel = deepQuerySelectorAll(document, tag).find(labelMatches);
    if (byLabel) return byLabel;                                 // 2
    return byId || null;                                         // 3
  }

  function isGeneric(name) {
    return CFG.genericNames.some(w => name.toLowerCase().includes(w));
  }
  function isDateSlug(name) { return /\d{8}/.test(name); }

  function stripPrefix(p, fallback) {
    const s = String(p || fallback || '')
      .split('?')[0]
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^.*\/enforced\/\d+-[^/]+\//, '')
      .replace(/^.*\/enforced\/\d+\//, '')
      .replace(/^\/content\/[^/]+\//, '');
    return s || fallback;
  }

  // Remove every label we may have placed — in BOTH the light DOM and the title
  // host's shadow root. The label lives INSIDE the component's shadow root, so a
  // plain document.querySelectorAll misses it (that was a real dedupe blind spot).
  function removeAllLabels(host) {
    document.querySelectorAll('#d2l-filename-display').forEach(el => el.remove());
    const root = host && host.getRootNode && host.getRootNode();
    if (root && root !== document && root.querySelectorAll) {
      root.querySelectorAll('#d2l-filename-display').forEach(el => el.remove());
    }
  }

  // Idempotent: clears any existing label (incl. shadow-root orphans) and
  // recreates exactly one as the LIVE host's next sibling, in the host's own
  // document so it lands in the correct (shadow) tree.
  function ensureContainer() {
    const host = getTitleHost();
    if (!host) return null;
    removeAllLabels(host);
    const el = (host.ownerDocument || document).createElement('div');
    el.id = 'd2l-filename-display';
    host.insertAdjacentElement('afterend', el);
    return el;
  }

  // ============================================================
  // KEEP-ALIVE — the title component <d2l-activity-content-editor-title> is
  // re-rendered/replaced during load (confirmed via lifecycle diagnostic), which
  // destroys its shadow root and any label we injected into it. A one-shot inject
  // loses that race → the label flashes and vanishes. So we watch the DOM and
  // re-attach the resolved label whenever it goes missing from the LIVE host's
  // root. Existence check is cheap and prevents needless churn.
  // ============================================================
  function labelHealthy() {
    const host = getTitleHost();
    if (!host) return true;                  // no host yet → nothing to maintain
    const root = host.getRootNode();
    return !!(root && root.querySelector && root.querySelector('#d2l-filename-display'));
  }

  function maintainLabel() {
    if (labelHealthy()) return;
    if (state && state.filename) injectLabel();   // restore the resolved label
    else if (state) showLoading();                // or the placeholder, pre-resolution
  }

  let maintainScheduled = false;
  function scheduleMaintain() {
    if (maintainScheduled) return;
    maintainScheduled = true;
    setTimeout(() => { maintainScheduled = false; maintainLabel(); }, 120);
  }

  function installKeepAlive() {
    if (installKeepAlive.done) return;            // once per page
    installKeepAlive.done = true;
    new MutationObserver(scheduleMaintain)
      .observe(document.documentElement, { childList: true, subtree: true });
  }

  function baseStyle(el, bg, fg, border) {
    el.style.cssText = `
      font-size:0.75rem;font-family:inherit;margin-top:5px;padding:3px 8px;
      border-radius:4px;display:inline-flex;align-items:center;gap:6px;
      background:${bg};color:${fg};border:1px solid ${border};
      user-select:text;flex-wrap:wrap;`;
  }

  function showLoading() {
    // never replace an already-resolved label with a placeholder
    if (state && state.filename) return;
    const el = ensureContainer();
    if (!el) return;
    baseStyle(el, '#f8f8f8', '#888', '#e0e0e0');
    el.textContent = '📄 detecting filename…';
  }

  function showError(msg) {
    try { console.warn('[D2L-FN]', msg, '|', location.href); } catch (_) {}
    const el = ensureContainer();
    if (!el) return;
    baseStyle(el, '#fdecea', '#a33', '#f5c2c0');
    el.textContent = `⚠️ ${msg}`;
  }

  function injectLabel() {
    const host = getTitleHost();
    if (!host || !state || !state.filename) return;
    const el = ensureContainer();
    if (!el) return;

    const name = state.filename;
    const warn = isGeneric(name) && !isDateSlug(name);
    const display = stripPrefix(state.path, name);
    baseStyle(el, warn ? '#fff3cd' : '#f0f4f8', warn ? '#856404' : '#4a5568', warn ? '#ffc107' : '#cbd5e0');
    el.title = state.path || name;

    el.innerHTML = `
      <span>${warn ? '⚠️' : '📄'}</span>
      <span><strong style="font-weight:600">filename:</strong>
        <span style="font-family:monospace">${escapeHtml(display)}</span></span>
      ${warn ? `<span style="font-size:0.7rem;opacity:0.75">(generic name)</span>` : ''}
      <a href="#" id="d2l-manage-files-link" title="Open Manage Files and highlight this file"
        style="margin-left:6px;padding:2px 7px;border-radius:3px;
        background:${warn ? '#fff0b3' : '#e2e8f0'};color:${warn ? '#7c5a00' : '#2b4a7a'};
        border:1px solid ${warn ? '#f0c040' : '#a0aec0'};font-size:0.7rem;
        text-decoration:none;white-space:nowrap;">🗂️ Manage Files</a>
      <a href="#" id="d2l-public-files-link" title="Open Public Files"
        style="margin-left:4px;padding:2px 7px;border-radius:3px;
        background:#e6ffed;color:#1a5c2e;
        border:1px solid #7bc99a;font-size:0.7rem;
        text-decoration:none;white-space:nowrap;">🌐 Public Files</a>`;

    el.querySelector('#d2l-manage-files-link').addEventListener('click', e => {
      e.preventDefault();
      openManageFiles(name, state.path || name);
    });
      el.querySelector('#d2l-public-files-link').addEventListener('click', e => {
      e.preventDefault();
      const url = 'https://brightspace.rcpi.ie/d2l/lp/manageFiles/main.d2l?g=1&ou=6606';
      const w = 1100, h = 700;
      const left = Math.round((screen.width - w) / 2);
      const top = Math.round((screen.height - h) / 2);
      const popup = window.open(url, 'd2l_public_files_popup',
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
      if (!popup) window.open(url, '_blank');
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================
  // HANDOFF — write the target, open the popup. The companion Locator
  // script (matched on the Manage Files URL) reads the target on load.
  // We always open fresh so the Locator's on-load handler re-fires every
  // click; the named window simply reloads.
  // ============================================================
  // ⚠️ PAIRED PATH: this must stay in sync with the @match header in the
  // companion "D2L Manage Files Locator" script. If D2L ever moves this tool,
  // change BOTH — otherwise A opens a page B isn't watching and the highlight
  // silently stops working. Only the ?ou= value varies between courses.
  function manageFilesUrl() {
    return `/d2l/lp/manageFiles/main.d2l?ou=${encodeURIComponent(state.ou)}`;
  }

  function openManageFiles(filename, fullPath) {
    try {
      localStorage.setItem(HANDOFF_KEY, JSON.stringify({
        path: fullPath,
        filename,
        ou: state.ou,
        ts: Date.now(),
      }));
    } catch (_) { /* private mode / quota — popup still opens, just no auto-jump */ }

    const url = manageFilesUrl();
    const w = 1100, h = 700;
    const left = Math.round((screen.width - w) / 2);
    const top = Math.round((screen.height - h) / 2);
    const popup = window.open(url, 'd2l_manage_files_popup',
      `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
    if (!popup) window.open(url, '_blank');   // popup blocked → plain tab
  }

  // ============================================================
  // ORCHESTRATION + SPA navigation handling
  // ============================================================
  let runToken = 0;
  let activeInterval = null;

  function start() {
    if (!isEditableContext()) return;
    if (isNewPageContext()) return;
    installKeepAlive();                  // re-attach the label across component re-renders
    const myToken = ++runToken;          // only the latest start() stays live
    if (activeInterval) clearInterval(activeInterval);

    state = freshState();
    state.ou = getOu();
    state.topicId = topicIdFromLocation();

    // wait for the title field, show a placeholder, kick the lookup
    let tries = 0;
    activeInterval = setInterval(() => {
      if (myToken !== runToken) { clearInterval(activeInterval); return; }
      const host = getTitleHost();
      if (host) {
        clearInterval(activeInterval);
        if (!state.topicId) { showError('no topic id in URL'); return; }
        if (!state.filename) showLoading();
        runDetection();
        setTimeout(() => {
          if (myToken !== runToken) return;
          const el = document.getElementById('d2l-filename-display');
          if (el && !state.filename) showError('lookup timed out');
        }, CFG.idResolveTimeoutMs);
      } else if (++tries > 60) {
        clearInterval(activeInterval);
      }
    }, 250);
  }

  // Re-run only if the user navigates to a genuinely different topic.
  let lastTopicId = null;
  function onNav() {
    const id = topicIdFromLocation();
    if (!id || id === lastTopicId) return;   // same page / no real change → do nothing
    lastTopicId = id;
    removeAllLabels(getTitleHost());
    if (isNewPageContext()) return;
    start();
  }
  window.addEventListener('popstate', onNav);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { lastTopicId = topicIdFromLocation(); start(); });
  } else {
    lastTopicId = topicIdFromLocation();
    start();
  }
})();