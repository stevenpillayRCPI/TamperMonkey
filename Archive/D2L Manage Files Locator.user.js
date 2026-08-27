// ==UserScript==
// @name         D2L Manage Files Locator
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Companion to "D2L Filename Display". Runs inside the Manage Files popup. Reads the target path handed off via localStorage, scrolls the legacy YUI file list (lazy-loaded), and highlights the matching file — navigating into subfolders first if the path has any. Does nothing if no fresh target is present (e.g. when you open Manage Files manually). v1.1: scroll the pane that holds the rows (multiple .dsl_p_m panes; tree was a decoy). v1.2: real subfolder navigation — folders are clicked by their name link (delegated JS handler), found by z_o_s row value, scrolling to load them.
// @match        https://brightspace.rcpi.ie/d2l/lp/manageFiles/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// ⚠️ PAIRED PATH: the @match above must stay in sync with manageFilesUrl() in
// the companion "D2L Filename Display" script — that's the page A opens, and
// this @match is where B is allowed to run. If D2L moves the Manage Files tool,
// update BOTH or the handoff silently breaks (A opens a page B never sees).

(function () {
  'use strict';

  // ============================================================
  // CONFIG  — confirmed selectors for this instance. The only place
  // to edit if D2L changes the Manage Files (legacy YUI) markup.
  // ============================================================
  const CFG = {
    mf: {
      // First-try class for the scrollable file-list pane. If D2L renames it,
      // getScroller() falls back to anchoring on the rows and climbing to the
      // nearest real scroll container — see getScroller().
      scroller: '.dsl_p_m',
      rowCheckbox: 'input[name="z_o_s"]',     // value = full enforced path (folders end in /)
    },
  };

  // Shared with the "D2L Filename Display" script. Must match there.
  const HANDOFF_KEY = 'd2l-mf-target';

  // Belt-and-suspenders only: the real safety is consume-on-read below.
  // The popup loads in well under a second, so this is never hit in the
  // normal flow; it just stops us acting on a stale leftover after a crash.
  const MAX_AGE_MS = 10 * 60 * 1000;          // 10 minutes

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================
  // PATH HELPERS
  // ============================================================
  function stripPrefix(p, fallback) {
    const s = String(p || fallback || '')
      .split('?')[0]
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^.*\/enforced\/\d+-[^/]+\//, '')
      .replace(/^.*\/enforced\/\d+\//, '')
      .replace(/^\/content\/[^/]+\//, '');
    return s || fallback;
  }

  function folderInfo(path, fallback) {
    const rel = stripPrefix(path, fallback);
    const parts = rel.split('/').filter(Boolean);
    const filename = parts.pop() || fallback;
    return { folders: parts, filename };
  }

  // ============================================================
  // BANNER
  // ============================================================
  function makeBanner(pdoc, text) {
    pdoc.getElementById('d2l-tamper-banner')?.remove();
    const b = pdoc.createElement('div');
    b.id = 'd2l-tamper-banner';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;background:#fef3c7;
      border-bottom:2px solid #f59e0b;padding:8px 16px;font-family:sans-serif;font-size:13px;
      display:flex;align-items:center;gap:10px;color:#78350f;box-sizing:border-box;`;
    b.innerHTML = `<span>📄</span><span id="d2l-tamper-banner-text"></span>
      <button type="button" style="margin-left:auto;background:none;border:1px solid #f59e0b;
      border-radius:4px;padding:2px 8px;cursor:pointer;color:#78350f;font-size:12px;">✕</button>`;
    b.querySelector('#d2l-tamper-banner-text').textContent = text;
    b.querySelector('button').addEventListener('click', () => b.remove());
    pdoc.body.insertAdjacentElement('afterbegin', b);
    return b;
  }
  function setBanner(b, t) { const s = b?.querySelector('#d2l-tamper-banner-text'); if (s) s.textContent = t; }
  // Failure path: show it in the banner AND leave a greppable console breadcrumb,
  // so a problem months from now can be filtered from the console (it never fires
  // on success).
  function setFail(b, t) { setBanner(b, t); try { console.warn('[D2L-MF]', t, '|', location.href); } catch (_) {} }

  // ============================================================
  // ⚠️ DOM-DRIVEN SECTION (fragile) — drives the legacy Manage Files DOM,
  // so this is the part most likely to need future patching. Logic is
  // unchanged from the original; it just runs against this popup's own
  // `document` instead of reaching across `window.opener`.
  // ============================================================
  // Navigate into each path segment in turn. A folder opens via a delegated JS
  // click handler on its name link (href is "javascript://", onclick is null) —
  // so we must dispatch a real click on that <a>.
  //
  // Fragility note: we anchor on the STICKIEST signals, not YUI classes —
  //   • find the folder by its z_o_s checkbox value ending in /{segment}/  (the
  //     form-name + enforced-path contract), scrolling to load it if needed;
  //   • pick the link by matching the anchor whose visible text == the folder
  //     name (locale-independent — the name is our data). Name-cell/class and
  //     "first anchor in row" are fallbacks only.
  async function navFolders(pdoc, folders, banner) {
    for (const seg of folders) {
      setBanner(banner, `Opening folder: ${seg}`);
      const row = await findFolderRow(pdoc, seg, banner);
      if (!row) { setFail(banner, `Could not find folder "${seg}" — is it spelled exactly as in the path?`); return false; }

      const link = folderLink(row, seg);
      if (!link) { setFail(banner, `Folder "${seg}" row has no clickable name link — the Manage Files layout may have changed.`); return false; }

      const before = listingSignature(pdoc);
      link.scrollIntoView({ block: 'center' });
      await sleep(120);
      link.click();                      // delegated handler navigates the listing

      const changed = await waitForListingChange(pdoc, before);
      if (!changed) { setFail(banner, `Clicked folder "${seg}" but the list never changed — folder navigation may have changed.`); return false; }
    }
    return true;
  }

  // Scroll-find the folder row whose z_o_s value ends in /{segment}/.
  async function findFolderRow(pdoc, seg, banner) {
    const want = '/' + seg.toLowerCase() + '/';
    const find = () => {
      for (const cb of pdoc.querySelectorAll(CFG.mf.rowCheckbox)) {
        if ((cb.value || '').toLowerCase().endsWith(want)) return cb.closest('tr');
      }
      return null;
    };
    let row = find();
    if (row) return row;
    let prevH = -1, prevN = -1, stuck = 0;
    for (let i = 0; i < 120 && !row; i++) {
      const sc = getScroller(pdoc);
      const n = pdoc.querySelectorAll(CFG.mf.rowCheckbox).length;
      setBanner(banner, `Finding folder ${seg}… (${n} rows)`);
      sc.scrollTop = sc.scrollHeight;
      await sleep(i < 5 ? 600 : 400);
      row = find();
      const grew = sc.scrollHeight !== prevH || n !== prevN;
      if (!grew) { if (++stuck >= 4) break; } else { stuck = 0; }
      prevH = sc.scrollHeight; prevN = n;
    }
    return row || find();
  }

  // Confidence order: visible text == folder name → Name-cell link → first <a>.
  function folderLink(row, seg) {
    if (!row) return null;
    const anchors = Array.from(row.querySelectorAll('a'));
    const byText = anchors.find(a => (a.textContent || '').trim().toLowerCase() === seg.toLowerCase());
    if (byText) return byText;
    const nameCell = row.querySelector('td[class*="col-Name"], td[headers*="Name"]');
    const nameLink = nameCell && nameCell.querySelector('a');
    return nameLink || anchors[0] || null;
  }

  // A cheap fingerprint of the current listing — count + first/last row value.
  // Changes when we navigate into a folder (the whole table reloads).
  function listingSignature(pdoc) {
    const v = Array.from(pdoc.querySelectorAll(CFG.mf.rowCheckbox)).map(cb => cb.value || '');
    return v.length + '|' + (v[0] || '') + '|' + (v[v.length - 1] || '');
  }

  // Wait for the listing to change from `before`, then settle.
  async function waitForListingChange(pdoc, before) {
    const start = Date.now(); let last = null, stable = 0;
    while (Date.now() - start < 8000) {
      const sig = listingSignature(pdoc);
      if (sig !== before) {
        if (sig === last) { if (++stable >= 3) return true; } else { stable = 0; last = sig; }
      }
      await sleep(200);
    }
    return false;
  }

  async function findRowAutoScroll(pdoc, name, banner) {
    let prevH = -1, prevRows = -1, stuck = 0;
    for (let i = 0; i < 120; i++) {
      let row = findRowNow(pdoc, name);
      if (row) return row;
      const sc = getScroller(pdoc);
      if (!sc) { await sleep(500); continue; }

      const rows = pdoc.querySelectorAll(CFG.mf.rowCheckbox).length;
      setBanner(banner, `Loading file list… (${rows} so far)`);

      sc.scrollTop = sc.scrollHeight;
      await sleep(i < 5 ? 700 : 450);
      row = findRowNow(pdoc, name); if (row) return row;

      // stop when neither the height nor the row count grows across a few tries
      const grew = sc.scrollHeight !== prevH || rows !== prevRows;
      if (!grew) { if (++stuck >= 4) break; } else { stuck = 0; }
      prevH = sc.scrollHeight; prevRows = rows;
    }
    return findRowNow(pdoc, name);
  }

  // Try the declared class first (fast, exact). If it's gone — or it isn't
  // actually the scrolling element — anchor on something stable (the rows,
  // matched by their form `name`) and climb to the nearest ancestor that
  // genuinely scrolls. Class is a convenience; structure is the safety net.
  function isScrollable(el, view) {
    if (!el || el.nodeType !== 1) return false;
    const oy = view.getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50;
  }

  function getScroller(pdoc) {
    const view = pdoc.defaultView || window;

    // 1) AUTHORITATIVE — the scroll container that actually HOLDS the file rows.
    //    This page has several .dsl_p_m panes and more than one of them scrolls
    //    (the folder-tree pane is a scrollable decoy), so picking "the first
    //    .dsl_p_m that scrolls" grabs the wrong one. Anchor on a row and climb to
    //    its nearest scrolling ancestor — that is, by definition, the file list.
    const anchor = pdoc.querySelector(CFG.mf.rowCheckbox);
    const start = anchor ? (anchor.closest('table') || anchor) : null;
    for (let el = start; el; el = el.parentElement) {
      if (isScrollable(el, view)) return el;
    }

    // 2) declared class, but only a pane that BOTH contains rows AND scrolls
    for (const pane of pdoc.querySelectorAll(CFG.mf.scroller)) {
      if (pane.querySelector(CFG.mf.rowCheckbox) && isScrollable(pane, view)) return pane;
    }

    // 3) last resorts: any declared pane, then the page itself
    return pdoc.querySelector(CFG.mf.scroller) || pdoc.scrollingElement || pdoc.documentElement;
  }

  // Checkbox value is a TYPE-PREFIXED full enforced path, e.g.
  //   d_/content/enforced/{ou}-{course}/banners/      (folder — trailing slash)
  //   f_/content/enforced/{ou}-{course}/Lesson X.html (file — no trailing slash)
  // We match on the path ENDING in our filename, so the d_/f_ prefix and any
  // leading folders are irrelevant, and spaces/parens are handled exactly.
  function findRowNow(pdoc, name) {
    const lower = name.toLowerCase();
    for (const cb of pdoc.querySelectorAll(CFG.mf.rowCheckbox)) {
      const val = (cb.value || '').replace(/\/+$/, '');   // trim trailing slash
      if (val.toLowerCase().endsWith('/' + lower) || val.toLowerCase() === lower) {
        return cb.closest('tr');
      }
    }
    return null;
  }

  function highlight(pdoc, row) {
    row.style.background = '#fff9c4';
    row.style.outline = '2px solid #f59e0b';
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = true;
  }

  // ============================================================
  // ENTRY — read the handoff (one-shot), then locate.
  // ============================================================
  function readTarget() {
    let raw;
    try { raw = localStorage.getItem(HANDOFF_KEY); } catch (_) { return null; }
    if (!raw) return null;
    // consume immediately so a stray reload/manual open never re-triggers
    try { localStorage.removeItem(HANDOFF_KEY); } catch (_) {}
    let t;
    try { t = JSON.parse(raw); } catch (_) { return null; }
    if (!t || !t.filename) return null;
    if (t.ts && (Date.now() - t.ts) > MAX_AGE_MS) return null;   // stale leftover
    return t;
  }

  async function run(target) {
    const { folders, filename } = folderInfo(target.path, target.filename);
    const banner = makeBanner(document, `Looking for ${filename}…`);
    try {
      const navOk = await navFolders(document, folders, banner);
      if (!navOk) return;             // banner already names the folder that failed
      setBanner(banner, 'Scanning file list…');
      const row = await findRowAutoScroll(document, filename, banner);
      if (row) {
        highlight(document, row);
        setBanner(banner, `Highlighted: ${filename} — use the ⌄ arrow to rename`);
      } else {
        // Distinguish the two very different failures: we COULD read the list but
        // the name isn't here (a name/location problem — the common case), versus
        // we couldn't read any rows at all (the Manage Files tool likely changed).
        const rows = document.querySelectorAll(CFG.mf.rowCheckbox).length;
        if (rows > 0) {
          setFail(banner, `Scanned ${rows} item(s) in this folder — none named "${filename}". Check the exact name and extension.`);
        } else {
          setFail(banner, `Couldn't read any files here — the folder may be empty, or the Manage Files list structure has changed.`);
        }
      }
    } catch (e) {
      setFail(banner, `Stopped: an error occurred while scanning the file list.`);
      try { console.warn('[D2L-MF] exception', e); } catch (_) {}
    }
  }

  function init() {
    const target = readTarget();
    if (!target) return;            // opened manually / no fresh handoff → stay quiet
    run(target);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();