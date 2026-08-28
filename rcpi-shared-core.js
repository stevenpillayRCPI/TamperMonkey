/* =====================================================================
 * RCPI Toolkit — Shared Core
 * ---------------------------------------------------------------------
 * Canonical detection rules + generic helpers used by BOTH the Block
 * Builder Edit Toolkit (edit mode) and the Brightspace Audit Toolkit
 * (view mode). This file is NOT a userscript — it has no ==UserScript==
 * header and is pulled into each toolkit via:
 *
 *   // @require https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/rcpi-shared-core.js
 *
 * Design contract:
 *   - This module NEVER writes to page/editor content. It only detects,
 *     collects, probes, and provides UI scaffolding. All mutation lives
 *     in the Edit Toolkit.
 *   - Detection functions take a `body`/`root` element or arrays of
 *     elements — never a TinyMCE editor — so the Audit Toolkit (which has
 *     no editor) and the Edit Toolkit can both call them.
 *   - GM_xmlhttpRequest / GM_getValue / GM_setValue are used directly.
 *     Each consuming userscript must @grant them (both already do).
 *
 * Exposed as: window.RCPIShared  (and unsafeWindow.RCPIShared when present)
 * ===================================================================== */

(function () {
  'use strict';

  // Grab GM APIs defensively — a consuming script might not grant all three.
  const _GMxhr = (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : null;
  const _GMget = (typeof GM_getValue !== 'undefined') ? GM_getValue : (k, d) => d;
  const _GMset = (typeof GM_setValue !== 'undefined') ? GM_setValue : () => {};

  // ─── CONFIG (overridable: RCPIShared.config.xxx = ... after load) ──────
  const CFG = {
    imageSizeKB: 1000,
    imageWidthPx: 2000,
    probeHeadFirst: true,
    probeRetryOnce: true,
    probeFlagRedirect: true,
    probeFlagMixed: true,
    ncbiEmail: 'admin@rcpi.ie',
    crossrefMailto: 'admin@rcpi.ie',
  };

  // ─── STORAGE KEYS ─────────────────────────────────────────────────────
  const IGNORE_KEY = 'rcpi-probe-ignore-v1';
  const COPYRIGHT_SESSION_KEY = 'rcpi-copyright-session-v1';

  const DEFAULT_IGNORE_DOMAINS = [
    'doi.org', 'dx.doi.org', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov',
    'www.nejm.org', 'www.thelancet.com', 'jamanetwork.com', 'bmj.com',
    'www.bmj.com', 'academic.oup.com', 'journals.lww.com', 'onlinelibrary.wiley.com',
    'link.springer.com', 'www.sciencedirect.com', 'www.nature.com',
    'europepmc.org', 'www.cochranelibrary.com'
  ];

  // ─── GENERIC HELPERS ──────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cssEsc(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, ch => '\\' + ch);
  }

  // Walk up the parent chain as far as same-origin access allows.
  function findTopSameOriginDoc() {
    let w = window;
    while (w.parent && w.parent !== w) {
      try { void w.parent.document; w = w.parent; } catch (e) { break; }
    }
    return w.document;
  }

  // Content pages render inside a same-origin d2l/le/lessons iframe, so the
  // real topic URL lives on the top frame, not location.href. Covers both
  // file topics (/topics/N) and unit pages (/units/N) — the only two
  // content types in scope for audit/edit.
  function getBrightspaceUrl() {
    try {
      const topHref = findTopSameOriginDoc().location.href;
      if (/\/d2l\/le\/lessons\/\d+\/(topics|units)\/\d+/i.test(topHref)) return topHref;
    } catch (e) {}
    return '';
  }

  // Maps an /edit/ pathname to its view-mode URL, or null if the content
  // type isn't one we audit/edit (e.g. quizzes, discussions — deliberately
  // out of scope). File topics and unit pages use unrelated edit URL shapes
  // (loadActivity/file/N vs loadUnit/N) so this can't be a string swap.
  function editUrlToViewUrl(pathname) {
    let m = pathname.match(/\/d2l\/le\/lessons\/(\d+)\/edit\/\d+\/loadActivity\/file\/(\d+)/i);
    if (m) return `https://brightspace.rcpi.ie/d2l/le/lessons/${m[1]}/topics/${m[2]}`;
    m = pathname.match(/\/d2l\/le\/lessons\/(\d+)\/edit\/loadUnit\/(\d+)/i);
    if (m) return `https://brightspace.rcpi.ie/d2l/le/lessons/${m[1]}/units/${m[2]}`;
    return null;
  }

  // Canonical key for the audit-to-edit localStorage handoff — derived from
  // a view-mode URL (topics or units), used by both scripts so the key
  // shape can't drift between them.
  function topicKeyFromViewUrl(href) {
    const m = (href || '').match(/\/d2l\/le\/lessons\/(\d+)\/(topics|units)\/(\d+)/i);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  function downloadCsv(rows, basename, doc) {
    const d = doc || document;
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = d.createElement('a');
    a.href = url; a.download = `${basename}-${Date.now()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadMarkdown(text, basename, doc) {
    const d = doc || document;
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = d.createElement('a');
    a.href = url; a.download = `${basename}-${Date.now()}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Lightweight transient toast, mounted into whichever document is passed.
  function toast(msg, doc) {
    const d = doc || document;
    const el = d.createElement('div');
    el.className = 'rcpi-toast';
    el.textContent = msg;
    d.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
  }

  // Before locating, force open every collapsed ancestor (accordion panel,
  // reveal panel, inactive tab pane, inactive carousel slide) so the target
  // is actually visible to scroll to. This is why Locate looked broken for
  // anything nested inside closed content in view mode: view-mode runtime
  // JS (bootstrap-custom-cleanup.js) actively collapses these on load,
  // whereas the TinyMCE editor never wires that behaviour up, so edit mode
  // never hit this. Matches the exact class/attribute patterns the runtime
  // cleanup script and the block builder's own templates use.
  function revealAncestors(el) {
    if (!el) return;
    let node = el.parentElement;
    const seenDoc = el.ownerDocument || document;
    while (node) {
      // Bootstrap collapse (accordion body, reveal-table row, standalone
      // reveal panel) — panel carries .collapse, only .show when open.
      if (node.classList && node.classList.contains('collapse') && !node.classList.contains('show')) {
        node.classList.add('show');
        node.setAttribute('aria-hidden', 'false');
        let trigger = node.id ? seenDoc.querySelector(`[data-bs-target="#${cssEsc(node.id)}"]`) : null;
        if (!trigger) {
          const accItem = node.closest('.accordion-item');
          if (accItem) trigger = accItem.querySelector('.accordion-button');
        }
        if (!trigger) {
          const revealContainer = node.closest('.reveal-container');
          if (revealContainer) trigger = revealContainer.querySelector('.reveal-button');
        }
        if (trigger) { trigger.classList.remove('collapsed'); trigger.setAttribute('aria-expanded', 'true'); }
      }
      // <details> not open.
      if (node.tagName === 'DETAILS' && !node.open) node.open = true;
      // Inactive tab pane — activate it and its nav-link.
      if (node.classList && node.classList.contains('tab-pane') && !node.classList.contains('active')) {
        const tabContent = node.parentElement;
        if (tabContent) Array.from(tabContent.children).forEach(p => { if (p.classList && p.classList.contains('tab-pane')) p.classList.toggle('active', p === node); });
        if (node.id) {
          const navLink = seenDoc.querySelector(`[data-bs-target="#${cssEsc(node.id)}"], [aria-controls="${cssEsc(node.id)}"]`);
          if (navLink) {
            const nav = navLink.closest('.nav, [role="tablist"]');
            if (nav) nav.querySelectorAll('.nav-link').forEach(l => l.classList.toggle('active', l === navLink));
            navLink.setAttribute('aria-selected', navLink === navLink ? 'true' : 'false');
          }
        }
      }
      // Inactive carousel slide — activate it, deactivate siblings.
      if (node.classList && node.classList.contains('carousel-item') && !node.classList.contains('active')) {
        const inner = node.parentElement;
        if (inner) Array.from(inner.children).forEach(s => { if (s.classList && s.classList.contains('carousel-item')) s.classList.toggle('active', s === node); });
      }
      // Generic inline-hidden safety net.
      if (node.style && node.style.display === 'none') node.style.display = '';
      node = node.parentElement;
    }
  }

  // Scroll a rendered element into view and flash it (view-mode locate).
  function locateInPage(el) {
    if (!el) return;
    try {
      revealAncestors(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      clearTimeout(el._rcpiLocateTimer);
      el.classList.remove('rcpi-locate-flash');
      void el.offsetWidth; // restart animation if already flashing
      el.classList.add('rcpi-locate-flash');
      el._rcpiLocateTimer = setTimeout(() => el.classList.remove('rcpi-locate-flash'), 2200);
    } catch (e) { console.error('[rcpi] locateInPage failed:', e); }
  }

  // ─── IGNORE-LIST / SESSION STORAGE ────────────────────────────────────
  function loadIgnoreDomains() {
    try {
      const raw = _GMget(IGNORE_KEY, null);
      if (!raw) return DEFAULT_IGNORE_DOMAINS.slice();
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : DEFAULT_IGNORE_DOMAINS.slice();
    } catch { return DEFAULT_IGNORE_DOMAINS.slice(); }
  }
  function saveIgnoreDomains(list) { _GMset(IGNORE_KEY, JSON.stringify(list, null, 2)); }
  function isDomainIgnored(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return loadIgnoreDomains().some(d => {
        const clean = d.replace(/^www\./, '');
        return host === clean || host.endsWith('.' + clean);
      });
    } catch { return false; }
  }

  function loadAuditSession() {
    try {
      const raw = _GMget(COPYRIGHT_SESSION_KEY, null);
      if (!raw) return { active: false, rows: [] };
      const p = JSON.parse(raw);
      return (p && Array.isArray(p.rows)) ? p : { active: false, rows: [] };
    } catch { return { active: false, rows: [] }; }
  }
  function saveAuditSession(s) { _GMset(COPYRIGHT_SESSION_KEY, JSON.stringify(s)); }

  // ─── LINK TRACKING-PARAM STRIP (detection half; write is Edit-side) ────
  const TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'igshid', 'yclid', 'dclid', 'msclkid',
    '_hsenc', '_hsmi', 'vero_id', 'oly_anon_id', 'oly_enc_id', 'wickedid', 'ref', 'ref_src'
  ];
  function stripTrackingFromUrl(url, baseHref) {
    const removed = [];
    try {
      const u = new URL(url, baseHref || location.href);
      TRACKING_PARAMS.forEach(p => { if (u.searchParams.has(p)) { u.searchParams.delete(p); removed.push(p); } });
      Array.from(u.searchParams.keys()).forEach(k => {
        if (/^utm_/i.test(k) || /clid$/i.test(k)) { u.searchParams.delete(k); removed.push(k); }
      });
      let out = u.toString().replace(/\?$/, '');
      return { url: out, removed };
    } catch { return { url, removed }; }
  }

  // ─── STRUCTURAL URL LINTER ────────────────────────────────────────────
  function lintHref(raw) {
    let h = raw || '', reasons = [];
    const note = r => { if (!reasons.includes(r)) reasons.push(r); };

    const ltrim = h.replace(/^[\s"'“”‘’<>()\[\]{}]+/, '');
    if (ltrim !== h) { h = ltrim; note('stripped leading junk'); }

    const isWeb =
      /^https?/i.test(h) ||
      /^h?t{1,3}ps?/i.test(h) ||
      /^\w+\./.test(h) ||
      /^www\./i.test(h) ||
      /^[a-z0-9.-]+\.[a-z]{2,}/i.test(h) && !/^(mailto|tel|javascript|data):/i.test(h);

    if (/^(mailto|tel):/i.test(h)) {
      const m2 = h.replace(/^(mailto|tel):https?/i, '$1:');
      if (m2 !== h) { h = m2; note('removed scheme inside mailto/tel'); }
    } else if (isWeb) {
      let prev;
      do {
        prev = h;
        h = h.replace(/^(https?):\1+/i, '$1');
        h = h.replace(/^(https?)\/\/(?!\/)/i, '$1://');
        h = h.replace(/^https?:https?:/i, 'https:');
      } while (h !== prev);

      if (h !== raw && /^https?/i.test(h) && /^https?:https?/i.test(raw)) note('fixed doubled scheme');

      const typo = h.match(/^(h?t{1,3}ps?)(:?\/{0,2})/i);
      if (typo) {
        const word = typo[1].toLowerCase();
        if (word !== 'http' && word !== 'https' && /^h?t{1,3}ps?$/.test(word)) {
          h = h.replace(/^h?t{1,3}ps?/i, /s$/.test(word) ? 'https' : 'http');
          note('normalised scheme');
        }
      }

      let s = h
        .replace(/^https?:(?!\/\/)/i, m => m + '//')
        .replace(/^https?:\/(?!\/)/i, m => m + '/');
      if (s !== h) { h = s; note('normalised scheme'); }

      const nospace = h.replace(/\s+/g, '');
      if (nospace !== h) { h = nospace; note('removed internal whitespace'); }

      const dedupe = h.replace(/^(https?:)\/{2,}/i, '$1//');
      if (dedupe !== h) { h = dedupe; note('collapsed double slashes'); }

      let changed = true;
      while (changed) {
        changed = false;
        const last = h.slice(-1);
        if (/[.,;:!?]$/.test(last)) { h = h.slice(0, -1); note('removed trailing junk'); changed = true; continue; }
        if (last === ')') {
          const opens = (h.match(/\(/g) || []).length;
          const closes = (h.match(/\)/g) || []).length;
          if (closes > opens) { h = h.slice(0, -1); note('removed trailing junk'); changed = true; }
        }
      }
      h = h.trim();
    }

    if (h === raw) return null;
    return { fixed: h, reasons };
  }

  // Convenience: lint an array of <a> elements. Returns match descriptors.
  function lintAnchors(anchors) {
    const out = [];
    (anchors || []).forEach(a => {
      const raw = a.getAttribute('href');
      const r = lintHref(raw);
      if (r) out.push({ a, oldHref: raw, newHref: r.fixed, reasons: r.reasons, text: a.textContent });
    });
    return out;
  }

  // ─── 404 / SOFT-404 PROBE (read-only network) ─────────────────────────
  const BROKEN_STATUS = new Set([404, 410]);
  const BINARY_EXT = /\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|mp4|mp3|mov|avi|png|jpe?g|gif|svg|csv|epub)$/i;
  const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?)(\?.*)?$/i;
  const SOFT404_MARKERS = [
    'blob not found', 'page not found', 'not found', 'error 404', 'does not exist',
    'cannot be found', 'no longer available', 'object not found', 'file not found'
  ];

  function classifyStatus(status, errored) {
    if (errored) return 'broken';
    if (BROKEN_STATUS.has(status)) return 'broken';
    if (status >= 200 && status < 400) return 'ok';
    return 'uncertain';
  }

  function looksSoftBroken(url, ctype, body) {
    const ct = (ctype || '').toLowerCase();
    const isHtml = ct.includes('text/html') || (!ct && /<html|<!doctype/i.test(body || ''));
    if (BINARY_EXT.test(url) && isHtml) return 'expected file, got HTML page';
    if (isHtml && body) {
      const low = body.toLowerCase();
      if (low.length < 4000 && SOFT404_MARKERS.some(m => low.includes(m))) return 'page says not found';
    }
    return null;
  }

  function isProbableUrl(url) {
    return /^https?/i.test(url) && !/^https?:\/\/(localhost|127\.)/i.test(url);
  }

  function _gmGet(url, method, extraHeaders, timeout) {
    return new Promise(resolve => {
      const finish = (status, errored, ctype, body, loc, contentLength) =>
        resolve({ status, errored, ctype, body, finalUrl: loc || url, contentLength: contentLength || 0 });
      if (!_GMxhr) { finish(0, true, '', '', '', 0); return; }
      try {
        _GMxhr({
          method, url, timeout: timeout || 15000, headers: extraHeaders || {},
          onload: r => {
            let ctype = '';
            try { const m = r.responseHeaders.match(/content-type:\s*([^\n\r]+)/i); if (m) ctype = m[1].trim(); } catch {}
            let loc = '';
            try { const m = r.responseHeaders.match(/location:\s*([^\n\r]+)/i); if (m) loc = m[1].trim(); } catch {}
            let contentLength = 0;
            try { const m = r.responseHeaders.match(/content-length:\s*(\d+)/i); if (m) contentLength = parseInt(m[1], 10); } catch {}
            finish(r.status, false, ctype, (r.responseText || '').slice(0, 4096), loc, contentLength);
          },
          onerror: () => finish(0, true, '', '', '', 0),
          ontimeout: () => finish(0, true, '', '', '', 0)
        });
      } catch { finish(0, true, '', '', '', 0); }
    });
  }

  async function probe(url) {
    if (!CFG.probeHeadFirst) return _gmGet(url, 'GET', {}, 15000);
    const head = await _gmGet(url, 'HEAD', {}, 10000);
    if (head.status === 405 || head.status === 501 || head.errored) {
      return _gmGet(url, 'GET', { 'Range': 'bytes=0-4095' }, 15000);
    }
    const isHtml = head.ctype.toLowerCase().includes('text/html');
    const isBin = BINARY_EXT.test(url);
    if (head.status >= 200 && head.status < 300 && isHtml && !isBin) {
      return _gmGet(url, 'GET', { 'Range': 'bytes=0-4095' }, 15000);
    }
    return head;
  }

  async function probeWithRetry(url) {
    const result = await probe(url);
    if (!CFG.probeRetryOnce) return result;
    const shouldRetry = result.errored || (result.status >= 500 && result.status < 600);
    if (!shouldRetry) return result;
    await new Promise(r => setTimeout(r, 1500));
    return probe(url);
  }

  // Generic probe run over supplied anchors + images (no editor dependency).
  // opts: { anchors:[], images:[], onProgress(done,total), generation, isCurrent() }
  async function runProbe(opts) {
    opts = opts || {};
    const anchors = opts.anchors || [];
    const images = opts.images || [];
    const onProgress = opts.onProgress || null;
    const isCurrent = opts.isCurrent || (() => true);
    const map = new Map();
    const pageIsHttps = location.protocol === 'https:';

    const tag = (el, type) => {
      const url = (el.getAttribute(type === 'img' ? 'src' : 'href') || '').trim();
      if (!isProbableUrl(url)) return;
      if (!map.has(url)) map.set(url, { anchors: [], imgs: [], type });
      const entry = map.get(url);
      if (type === 'img') entry.imgs.push(el); else entry.anchors.push(el);
    };
    anchors.forEach(a => tag(a, 'link'));
    images.forEach(img => tag(img, 'img'));

    const urls = [...map.keys()];
    const results = [];
    let i = 0, active = 0, idx = 0;
    const CONCURRENCY = 4;

    return new Promise(resolve => {
      const pump = () => {
        if (!isCurrent()) { resolve([]); return; }
        if (idx >= urls.length && active === 0) { resolve(results); return; }
        while (active < CONCURRENCY && idx < urls.length) {
          const url = urls[idx++];
          if (CFG.probeFlagMixed && pageIsHttps && /^http:/i.test(url)) {
            results.push({ url, status: 0, errored: false, klass: 'warn', reason: 'Mixed content: http resource on https page', isMixed: true, ...map.get(url) });
            i++; if (onProgress) onProgress(i, urls.length); pump(); continue;
          }
          if (isDomainIgnored(url)) {
            results.push({ url, status: 0, errored: false, klass: 'ignored', reason: 'Domain on ignore list', ...map.get(url) });
            i++; if (onProgress) onProgress(i, urls.length); pump(); continue;
          }
          active++;
          probeWithRetry(url).then(({ status, errored, ctype, body, finalUrl, contentLength }) => {
            if (!isCurrent()) { active--; pump(); return; }
            let klass = classifyStatus(status, errored), reason = '';
            if (klass === 'ok') {
              const soft = looksSoftBroken(url, ctype, body);
              if (soft) { klass = 'broken'; reason = soft; }
              else if (CFG.probeFlagRedirect && finalUrl && finalUrl !== url) { klass = 'redirect'; reason = `Redirects to: ${finalUrl}`; }
              else if (IMAGE_EXT.test(url) && contentLength > 0) {
                const sizeKB = Math.round(contentLength / 1024);
                if (sizeKB > CFG.imageSizeKB) { klass = 'warn'; reason = `Image is ${sizeKB} KB (threshold: ${CFG.imageSizeKB} KB)`; }
              }
            } else if (klass === 'broken') { reason = errored ? 'unreachable' : `HTTP ${status}`; }
            else if (klass === 'uncertain') { reason = `HTTP ${status}`; }
            results.push({ url, status, errored, klass, reason, finalUrl, contentLength, ...map.get(url) });
            active--; i++; if (onProgress) onProgress(i, urls.length); pump();
          });
        }
      };
      if (!urls.length) resolve(results); else pump();
    });
  }

  // ─── ACCESSIBILITY / HYGIENE / HEADING ENGINE ─────────────────────────
  const NONDESCRIPTIVE_LINK_TEXT = new Set([
    'click here', 'here', 'read more', 'more', 'link', 'this link', 'go', 'visit',
    'download', 'learn more', 'info', 'information', 'details', 'page', 'website', 'web site',
    'see here', 'see more', 'view', 'view here', 'source', 'reference', 'article', 'full text'
  ]);
  const BRIGHTSPACE_HOST_RE = /^https?:\/\/brightspace\.rcpi\.ie/i;
  // DOI/PubMed/PMC citation links are conventionally displayed as bare URLs
  // in academic reference lists ("Available at: https://doi.org/...") — the
  // bare-URL link-text check below should not flag these as a hygiene issue.
  const CITATION_URL_RE = /doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pmc/i;
  const FILE_TYPE_RE = /\.(pdf|docx?|pptx?|xlsx?|zip|mp4|mp3|mov|xls[xm]?)$/i;
  const FILE_LABEL_RE = /(pdf|word|doc|pptx?|excel|xlsx?|zip|mp4|mp3|video|audio|download|spreadsheet|presentation)/i;
  const FILENAME_ALT_RE = /^[\w.\-_]+\.(png|jpe?g|gif|svg|webp|bmp|tiff?)$/i;
  const TRANSCRIPT_LABEL_RE = /transcript/i;
  const PLACEHOLDER_TEXT_RE = /\b(to be added|tbd|to do\b|todo\b|coming soon|placeholder text|lorem ipsum|\[.*\bto be\b.*\])/i;
  const MEDIA_SELECTOR = 'video, audio, iframe[src*="panopto" i], iframe[src*="yuja" i], iframe[src*="vimeo" i], iframe[src*="youtube" i], iframe[src*="wistia" i]';
  const MANAGED_MEDIA_HOST_RE = /panopto|yuja/i;
  const NEW_WINDOW_WARNING_RE = /new (window|tab)|opens in (a )?new/i;
  const SENSORY_DESCRIPTOR_WORD_RE = /^(round|square|circular|oval|red|green|blue|yellow|orange|purple|pink|black|white|grey|gray|left|right|top|bottom|above|below|upper|lower|first|second|third|large|small|big|little)$/i;
  const SENSORY_ACTION_RE = /\b(?:click|tap|select|press)\s+(?:on\s+)?(?:the\s+)?([a-z][a-z\s]{1,30}?)\s+(button|icon|box|link|tab|control)\b/gi;

  function rgbLuminance(rgbStr) {
    const m = (rgbStr || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    const r = parseInt(m[1], 10) / 255, g = parseInt(m[2], 10) / 255, b = parseInt(m[3], 10) / 255;
    const ch = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }
  function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function isTransparentRgb(rgbStr) {
    const m = (rgbStr || '').match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/i);
    return !!m && parseFloat(m[1]) === 0;
  }
  function findEffectiveBg(el) {
    let node = el;
    for (let i = 0; i < 12 && node; i++) {
      let cs;
      try { cs = getComputedStyle(node); } catch { return 'rgb(255, 255, 255)'; }
      if (cs.backgroundColor && cs.backgroundColor !== 'transparent' && !isTransparentRgb(cs.backgroundColor)) return cs.backgroundColor;
      node = node.parentElement;
    }
    return 'rgb(255, 255, 255)';
  }
  function findNearbyLabelledAccordion(mediaEl, labelRe) {
    let node = mediaEl.closest('div, section, figure') || mediaEl.parentElement;
    for (let hops = 0; hops < 6 && node; hops++) {
      const scope = node.parentElement || node;
      const candidates = scope.querySelectorAll('.accordion, [class*="accordion" i], details');
      for (const acc of candidates) {
        const headerEl = acc.querySelector('.accordion-header, .accordion-button, summary, [role="heading"]') || acc;
        if (labelRe.test(headerEl.textContent || '')) return acc;
      }
      node = node.parentElement;
    }
    return null;
  }
  function accordionBodyText(acc) {
    const body = acc.querySelector('.accordion-body, [class*="collapse" i]') || acc;
    return (body.textContent || '').trim();
  }

  // The canonical WCAG 2.1 AA scan. Pass a body/root element (editor body or
  // rendered page body). Returns { issues, headingTree, wordCount, readMins }.
  // Each issue: { severity:'error'|'warn'|'info', category, el, msg, fix }.
  // `fix` is an advisory hint only — this module never applies it.
  function runA11y(body) {
    const issues = [];
    const note = (severity, category, el, msg, fix) => {
      if (el && el.closest && el.closest('.rcpi-shell')) return;
      issues.push({ severity, category, el: el || null, msg, fix: fix || null });
    };

    const altCounts = {};
    body.querySelectorAll('img[alt]').forEach(img => {
      const alt = img.getAttribute('alt');
      if (alt) altCounts[alt] = (altCounts[alt] || 0) + 1;
    });

    body.querySelectorAll('img').forEach(img => {
      const alt = img.getAttribute('alt');
      const src = img.getAttribute('src') || '';
      const w = parseInt(img.getAttribute('width') || '999', 10);
      const h = parseInt(img.getAttribute('height') || '999', 10);
      const tiny = w <= 20 && h <= 20;
      const srcDec = /spacer|pixel|blank|divider|border/i.test(src);
      const fig = img.closest('figure');
      const hasCap = fig && fig.querySelector('figcaption');

      if (alt === null) {
        if (tiny || srcDec) note('warn', 'Images', img, 'Decorative-looking image has no alt attribute; add alt=""', 'add-empty-alt');
        else note('error', 'Images', img, 'Image missing alt attribute entirely', 'add-alt');
      } else if (alt === '') {
        const contentSrc = /chart|graph|diagram|figure|photo|screenshot/i.test(src);
        if (contentSrc && !hasCap) note('warn', 'Images', img, 'Image has empty alt but src suggests it contains content; verify it is truly decorative', null);
      } else {
        if (/^(image of|photo of|picture of)\b/i.test(alt)) note('warn', 'Images', img, `alt text starts with redundant phrase: "${alt.slice(0, 40)}"`, null);
        if (alt.length > 150) note('warn', 'Images', img, `alt text is very long (${alt.length} chars); aim for under 150`, null);
        if (FILENAME_ALT_RE.test(alt)) note('warn', 'Images', img, `alt text looks like a filename: "${alt.slice(0, 50)}" — replace with a real description`, null);
        if ((altCounts[alt] || 0) > 1) note('info', 'Images', img, `Duplicate alt text across ${altCounts[alt]} images: "${alt.slice(0, 50)}" — each image should have a unique description unless truly identical`, null);
      }
    });

    body.querySelectorAll('a[href]').forEach(a => {
      const text = a.textContent.trim();
      const href = a.getAttribute('href') || '';
      const low = text.toLowerCase().replace(/[^a-z ]/g, '').trim();
      if (!text) note('error', 'Links', a, 'Link has no visible text; screen reader users will hear the URL only', null);
      else if (NONDESCRIPTIVE_LINK_TEXT.has(low)) note('warn', 'Links', a, `Non-descriptive link text: "${text}"`, null);
      else if (/^https?:/i.test(text) && !CITATION_URL_RE.test(href) && !/available\s+(at|from)/i.test((a.parentElement && a.parentElement.textContent) || '')) note('warn', 'Links', a, `Link text is a bare URL: ${text.slice(0, 60)}`, 'fix-bare-url');
      if (FILE_TYPE_RE.test(href) && !FILE_LABEL_RE.test(text) && !FILE_LABEL_RE.test(a.getAttribute('title') || '')) {
        const ext = (href.match(FILE_TYPE_RE) || [, 'file'])[1];
        note('warn', 'Links', a, `Link to .${ext} file has no file type in its text`, null);
      }
      if (BRIGHTSPACE_HOST_RE.test(href)) note('info', 'Hygiene', a, 'Hardcoded Brightspace URL; consider converting to a D2L quicklink', null);
      if (href.startsWith('#')) {
        const target = href.slice(1);
        if (target && !body.querySelector(`#${cssEsc(target)}`)) note('error', 'Hygiene', a, `Broken fragment link target "${target}"`, null);
      }
    });

    body.querySelectorAll('a[name]').forEach(a => {
      if (!a.getAttribute('href')) note('info', 'Hygiene', a, `Legacy <a name="${a.getAttribute('name')}"> should be id on the target element instead`, null);
    });

    const idCount = {};
    body.querySelectorAll('[id]').forEach(el => { const id = el.getAttribute('id'); if (id) idCount[id] = (idCount[id] || 0) + 1; });
    Object.entries(idCount).filter(([, n]) => n > 1).forEach(([id, n]) => {
      note('error', 'Hygiene', body.querySelector(`#${cssEsc(id)}`), `Duplicate id "${id}" (${n} occurrences); ids must be unique`, null);
    });

    body.querySelectorAll('table').forEach(table => {
      if (!table.querySelector('caption')) note('warn', 'Tables', table, 'Table has no caption; add a caption to describe the table\'s purpose', null);
      const ths = [...table.querySelectorAll('th')];
      if (!ths.length) note('warn', 'Tables', table, 'Table has no <th> header cells; add headers and scope attributes', null);
      else ths.filter(th => !th.getAttribute('scope')).forEach(th => note('warn', 'Tables', th, `<th> missing scope attribute: ${th.textContent.trim().slice(0, 30)}`, null));
    });

    body.querySelectorAll('b').forEach(el => note('info', 'Semantics', el, `<b> used for "${el.textContent.trim().slice(0, 30)}"; use <strong> for emphasis, or CSS for visual-only bold`, 'b-to-strong'));
    // No <i> → <em> check: <i> is the established convention for icon fonts
    // in this codebase (e.g. <i class="bi bi-card-list">), so a blanket
    // "semantic italics" check has no reliable way to tell an icon from
    // genuine italic text — removed rather than risk flagging icons.

    body.querySelectorAll('p, li, td, th, span, a, h1, h2, h3, h4, h5, h6, button, label').forEach(el => {
      if (el.children.length || !el.textContent.trim()) return;
      let cs;
      try { cs = getComputedStyle(el); } catch { return; }
      const fgL = rgbLuminance(cs.color);
      const bgL = rgbLuminance(findEffectiveBg(el));
      if (fgL === null || bgL === null) return;
      const ratio = contrastRatio(fgL, bgL);
      const fontSizePx = parseFloat(cs.fontSize) || 16;
      const isBold = parseInt(cs.fontWeight, 10) >= 700 || cs.fontWeight === 'bold';
      const isLarge = fontSizePx >= 24 || (fontSizePx >= 18.66 && isBold);
      const threshold = isLarge ? 3.0 : 4.5;
      if (ratio < threshold) note('warn', 'Colour', el, `Low colour contrast (${ratio.toFixed(1)}:1, needs ${threshold}:1) for "${el.textContent.trim().slice(0, 40)}"`, null);
    });

    body.querySelectorAll('[style*="font-size" i]').forEach(el => {
      const m = (el.getAttribute('style') || '').match(/font-size:\s*(\d+(?:\.\d+)?)px/i);
      if (m && parseFloat(m[1]) < 12) note('warn', 'Text', el, `Fixed font-size ${m[1]}px is small and won't scale with browser zoom well`, null);
    });

    body.querySelectorAll(MEDIA_SELECTOR).forEach(el => {
      const isNativeMedia = el.tagName === 'VIDEO' || el.tagName === 'AUDIO';
      const src = el.getAttribute('src') || '';
      if (MANAGED_MEDIA_HOST_RE.test(src)) return;
      if (isNativeMedia) {
        const nativeTrack = el.querySelector('track[kind="captions"], track[kind="subtitles"]');
        if (nativeTrack) return;
      }
      const acc = findNearbyLabelledAccordion(el, TRANSCRIPT_LABEL_RE);
      if (!acc) {
        const sev = isNativeMedia ? 'error' : 'warn';
        const msg = isNativeMedia
          ? 'Native <video>/<audio> has no caption track and no nearby transcript accordion'
          : `Third-party video embed (${src.slice(0, 60)}) has no nearby transcript accordion — verify captions are enabled at source`;
        note(sev, 'Media', el, msg, null);
        return;
      }
      const bodyText = accordionBodyText(acc);
      if (!bodyText || PLACEHOLDER_TEXT_RE.test(bodyText)) note('warn', 'Media', el, 'Transcript accordion found but appears empty or still a placeholder', null);
    });

    body.querySelectorAll('.accordion, [class*="accordion" i]').forEach(acc => {
      const headerEl = acc.querySelector('.accordion-header, .accordion-button, summary') || acc;
      const headerText = headerEl.textContent || '';
      const bodyText = accordionBodyText(acc);
      if (bodyText) {
        if (PLACEHOLDER_TEXT_RE.test(bodyText)) note('warn', 'Content', acc, `Accordion "${headerText.trim().slice(0, 40)}" still contains placeholder text — needs to be written`, null);
      }
    });

    body.querySelectorAll('iframe').forEach(el => {
      const title = (el.getAttribute('title') || '').trim();
      if (!title) note('error', 'Embeds', el, 'iframe has no title attribute — screen readers announce it with no context', null);
      else if (/^(iframe|video|embed|frame|content)$/i.test(title)) note('warn', 'Embeds', el, `iframe title is generic: "${title}"`, null);
    });

    body.querySelectorAll('a[href], button').forEach(el => {
      const text = el.textContent.trim();
      const hasAccName = el.getAttribute('aria-label') || el.getAttribute('title');
      const hasIconChild = el.querySelector('i, svg, [class*="icon" i], [class*="bi-" i]');
      if (!text && hasIconChild && !hasAccName) note('error', el.tagName === 'A' ? 'Links' : 'Buttons', el, 'Icon-only control has no accessible name — add aria-label', null);
    });

    body.querySelectorAll('a[target="_blank"]').forEach(a => {
      const context = a.textContent + ' ' + (a.getAttribute('aria-label') || '');
      if (!NEW_WINDOW_WARNING_RE.test(context)) note('warn', 'Links', a, 'Link opens in a new tab with no warning text for screen reader users', 'add-new-window-note');
    });

    body.querySelectorAll('p, li, td').forEach(el => {
      const text = el.textContent;
      let m;
      SENSORY_ACTION_RE.lastIndex = 0;
      while ((m = SENSORY_ACTION_RE.exec(text)) !== null) {
        const descriptorWords = m[1].trim().split(/\s+/).filter(Boolean);
        const nonDescriptor = descriptorWords.filter(w => !SENSORY_DESCRIPTOR_WORD_RE.test(w));
        const hasSensoryWord = descriptorWords.some(w => SENSORY_DESCRIPTOR_WORD_RE.test(w));
        if (hasSensoryWord && nonDescriptor.length === 0) note('warn', 'Content', el, `Instruction relies on shape/colour/position alone: "${m[0]}" — pair it with the control's actual label text`, null);
      }
    });

    body.querySelectorAll('marquee, [style*="animation" i]').forEach(el => {
      if (el.hasAttribute('data-bb-li-animated')) return; // scroll-triggered, one-shot li fade-in — not autoplaying motion
      note('warn', 'Motion', el, 'Auto-playing animation with no visible pause control', null);
    });
    body.querySelectorAll('video[autoplay], audio[autoplay]').forEach(el => { if (!el.hasAttribute('controls')) note('error', 'Media', el, 'Autoplaying media has no visible controls to pause/stop it', null); });

    if (body.ownerDocument) {
      const metaRefresh = body.ownerDocument.querySelector('meta[http-equiv="refresh" i]');
      if (metaRefresh) note('error', 'Structure', null, 'Page contains a meta refresh/timed redirect — not user-controllable', null);
    }

    const headings = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const h1s = headings.filter(h => h.tagName === 'H1');
    if (h1s.length > 1) h1s.forEach(h => note('error', 'Headings', h, `Multiple h1 elements (${h1s.length} found); only one h1 per page`, null));

    headings.forEach(h => {
      const text = h.textContent.trim();
      if (!text) note('error', 'Headings', h, `Empty ${h.tagName.toLowerCase()} heading`, null);
      else if (text.length < 4) note('warn', 'Headings', h, 'Very short heading text may be used for visual styling rather than structure', null);
      else if (text === text.toUpperCase() && /[A-Z]{3,}/.test(text)) note('warn', 'Headings', h, `All-caps heading: ${text.slice(0, 40)}`, null);
    });

    for (let i = 1; i < headings.length; i++) {
      const prev = parseInt(headings[i - 1].tagName[1], 10);
      const curr = parseInt(headings[i].tagName[1], 10);
      if (curr > prev + 1) note('warn', 'Headings', headings[i], `Heading level skipped (h${prev} → h${curr}); levels should increment by one`, 'fix-skipped-heading');
    }

    // A "meaningful content" element inside a p/heading (image, iframe,
    // embed, etc.) means it is NOT empty even though its textContent is —
    // this guard exists because the emptiness check below previously judged
    // purely by textContent and would flag (and the Edit Toolkit would then
    // delete) a <p> whose only content was e.g. an <iframe>, silently
    // destroying embedded content. Never drop this guard.
    const MEANINGFUL_EMBED_SELECTOR = 'img, iframe, embed, object, video, audio, svg, canvas, table, form, button, a[href], input, select, textarea';
    body.querySelectorAll('p, li, td, th, h1, h2, h3, h4, h5, h6').forEach(el => {
      if (el.querySelector(MEANINGFUL_EMBED_SELECTOR)) return; // has real content — never emptyish
      const html = el.innerHTML.trim();
      const text = el.textContent.trim().replace(/\u00a0/g, '');
      const isEmptyish = !text || html === '&nbsp;' || html === '<br>' || html === '<br />' || /^(&nbsp;)?<br\s*\/?>$/i.test(html);
      if (isEmptyish && el.tagName === 'P') note('info', 'Hygiene', el, `Empty paragraph, possibly a paste artefact: ${html.slice(0, 30) || '(blank)'}`, 'remove-empty');
      else if (isEmptyish && /^H[1-6]$/.test(el.tagName)) note('error', 'Headings', el, `Empty ${el.tagName.toLowerCase()} heading`, null);
    });

    // "Fake heading" check (bold-only short paragraph) removed — too
    // prone to false positives (e.g. emphasised quotes/callouts that are
    // legitimately bold, not mislabelled headings).

    body.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const text = a.textContent.trim();
      const ext = (href.match(/\.(pdf|docx?|pptx?|xlsx?|xls[xm]?)$/i) || [])[1];
      if (!ext) return;
      const alreadyFlagged = issues.some(i => i.el === a && i.category === 'Links' && /file/.test(i.msg));
      if (!alreadyFlagged && !FILE_LABEL_RE.test(text) && !FILE_LABEL_RE.test(a.getAttribute('title') || '')) note('info', 'Links', a, `Link to .${ext.toUpperCase()} file: verify the document itself is accessible`, null);
    });

    const bodyLang = body.getAttribute('lang') || body.closest('[lang]');
    if (!bodyLang) {
      const htmlEl = body.ownerDocument && body.ownerDocument.documentElement;
      if (htmlEl && !htmlEl.getAttribute('lang')) note('warn', 'Structure', null, 'No lang attribute found on the page; screen readers need this to choose the right voice', null);
    }

    body.querySelectorAll('img').forEach(img => {
      const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      if (w > CFG.imageWidthPx) note('warn', 'Images', img, `Image is very wide (${w}px); consider resizing to ${CFG.imageWidthPx}px before uploading`, null);
    });

    const headingTree = headings.map(h => ({ el: h, level: parseInt(h.tagName[1], 10), text: h.textContent.trim() }));
    const allText = body.textContent.trim().replace(/\s+/g, ' ');
    const wordCount = allText ? allText.split(' ').filter(w => w.length > 0).length : 0;
    const readMins = Math.max(1, Math.round(wordCount / 200));

    // Run any checks registered via RCPIShared.registerA11yCheck() after the
    // built-in set, so custom rules see the same body but can't reorder or
    // suppress canonical findings.
    runCustomA11yChecks(body, note);

    return { issues, headingTree, wordCount, readMins };
  }

  const SEV_ORDER = { error: 0, warn: 1, info: 2 };

  // ─── REGISTRIES (expansion points — add checks/fixes/tabs without editing
  // this file) ──────────────────────────────────────────────────────────
  // A11y: extra detection rules layered on top of the built-in runA11y set.
  //   RCPIShared.registerA11yCheck((body, note) => { ... note(sev,cat,el,msg,fix) ... });
  const CUSTOM_A11Y_CHECKS = [];
  function registerA11yCheck(fn) { if (typeof fn === 'function') CUSTOM_A11Y_CHECKS.push(fn); }
  function runCustomA11yChecks(body, note) {
    CUSTOM_A11Y_CHECKS.forEach(fn => { try { fn(body, note); } catch (e) { console.warn('[RCPIShared] a11y check failed', e); } });
  }

  // Edit-mode fixes: extra entries for the Edit Toolkit's Check & Fix list.
  //   RCPIShared.registerFixCheck(({body, ed, doc}) => [{category,label,apply}, ...]);
  const CUSTOM_FIX_CHECKS = [];
  function registerFixCheck(fn) { if (typeof fn === 'function') CUSTOM_FIX_CHECKS.push(fn); }
  function runCustomFixChecks(ctx) {
    const out = [];
    CUSTOM_FIX_CHECKS.forEach(fn => {
      try { const r = fn(ctx); if (Array.isArray(r)) out.push(...r); }
      catch (e) { console.warn('[RCPIShared] fix check failed', e); }
    });
    return out;
  }

  // Audit tabs: extra report tabs for the right-docked Audit bar.
  //   RCPIShared.registerAuditTab({ id, label, render(bodyEl) });
  const CUSTOM_AUDIT_TABS = [];
  function registerAuditTab(tab) { if (tab && tab.id && tab.render) CUSTOM_AUDIT_TABS.push(tab); }

  // ─── CITATIONS: DOI + PMID DETECTION & LOOKUP (no writes) ──────────────
  const DOI_MIN_LEN = 80;
  const DOI_YEAR_RE = /\b(19|20)\d{2}\b/;
  const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const CROSSREF_BASE = 'https://api.crossref.org/works';
  const DOI_BAND_HIGH = 80;
  const DOI_BAND_MED = 40;
  const REF_MARKER_RE = /\[\[\s*\d+(?:\s*[-,]\s*\d+)*\s*\]\]\s*[.,;:!?]?\s*$/;
  const PMID_RE = /\bPMID[:\s]*(\d{5,9})\b/gi;
  const PMCID_RE = /\bPMCID[:\s]*(PMC\d+)\b/gi;
  const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

  function endsWithRefMarker(text) { return REF_MARKER_RE.test((text || '').trim()); }
  function extractYear(text) { const m = (text || '').match(DOI_YEAR_RE); return m ? parseInt(m[0], 10) : null; }

  function extractRawDoi(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('a').forEach(a => a.remove());
    const m = (clone.textContent || '').match(DOI_RE);
    return m ? m[0].replace(/[.,;)\]]+$/, '') : null;
  }
  function hasDoi(el) {
    return [...el.querySelectorAll('a[href]')].some(a => {
      const href = a.getAttribute('href') || '';
      const txt = (a.textContent || '').trim();
      return DOI_RE.test(href) || DOI_RE.test(txt) || /doi\.org\//i.test(href);
    });
  }
  function extractRawPmid(el) {
    if (hasPmidLink(el)) return null;
    PMID_RE.lastIndex = 0;
    const m = PMID_RE.exec(el.textContent || '');
    return m ? m[1] : null;
  }
  function extractRawPmcid(el) {
    if (hasPmcidLink(el)) return null;
    PMCID_RE.lastIndex = 0;
    const m = PMCID_RE.exec(el.textContent || '');
    return m ? m[1] : null;
  }
  function hasPmcidLink(el) {
    return [...el.querySelectorAll('a[href]')].some(a => /ncbi\.nlm\.nih\.gov\/pmc\/articles\/PMC\d+/i.test(a.getAttribute('href') || ''));
  }
  function collectPmids(el) {
    const pmids = [];
    let m;
    PMID_RE.lastIndex = 0;
    while ((m = PMID_RE.exec(el.textContent || '')) !== null) pmids.push(m[1]);
    return [...new Set(pmids)];
  }
  function hasPmidLink(el) {
    return [...el.querySelectorAll('a[href]')].some(a => {
      const href = a.getAttribute('href') || '';
      return /pubmed\.ncbi\.nlm\.nih\.gov\/\d+/i.test(href) || /ncbi\.nlm\.nih\.gov\/pubmed\/\d+/i.test(href);
    });
  }

  // Reference-list discovery — takes a body/root element (not an editor).
  function findReferencesContainer(bodyEl) {
    if (!bodyEl) return null;
    let el = bodyEl.querySelector('[id*="reference" i]');
    if (el) return el;
    el = bodyEl.querySelector('[class*="reference" i]');
    if (el) return el;
    const candidates = [...bodyEl.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,.accordion-button,button,strong,b')];
    const headingEl = candidates.find(h => /^references?\s*:?$/i.test((h.textContent || '').trim()));
    if (headingEl) {
      const item = headingEl.closest('.accordion-item, .card, section, div, li');
      if (item) {
        const inner = item.querySelector('.accordion-body, .collapse, .card-body, .panel-body');
        return inner || item;
      }
      return headingEl.parentElement || null;
    }
    return null;
  }
  function isReferenceEl(el) {
    if (el.tagName !== 'P' && el.tagName !== 'LI') return false;
    const text = (el.textContent || '').trim();
    if (endsWithRefMarker(text)) return false;
    return text.length >= DOI_MIN_LEN && DOI_YEAR_RE.test(text);
  }
  function collectReferenceEls(bodyEl) {
    const container = findReferencesContainer(bodyEl);
    if (!container) return [];
    return [...container.querySelectorAll('p, li')].filter(isReferenceEl);
  }
  function collectShortReferenceCandidates(bodyEl) {
    const container = findReferencesContainer(bodyEl);
    if (!container) return [];
    return [...container.querySelectorAll('p, li')].filter(el => {
      const text = (el.textContent || '').trim();
      if (!text || text.length >= DOI_MIN_LEN) return false;
      if (!DOI_YEAR_RE.test(text)) return false;
      if (endsWithRefMarker(text)) return false;
      return true;
    });
  }
  function refQueryText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('a').forEach(a => {
      const t = (a.textContent || '').trim();
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(t) || /^https?:/i.test(href) || DOI_RE.test(t) || DOI_RE.test(href)) a.remove();
    });
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function crossrefQuery(text) {
    return new Promise(resolve => {
      const url = `${CROSSREF_BASE}?rows=3&mailto=${encodeURIComponent(CFG.crossrefMailto)}&query.bibliographic=${encodeURIComponent(text)}`;
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      if (!_GMxhr) { finish(null); return; }
      try {
        _GMxhr({
          method: 'GET', url, timeout: 12000,
          headers: { 'User-Agent': `RCPI-Toolkit (brightspace.rcpi.ie; mailto:${CFG.crossrefMailto})`, 'Accept': 'application/json' },
          onload: r => {
            try {
              if (r.status < 200 || r.status >= 300) { finish(null); return; }
              const data = JSON.parse(r.responseText);
              const items = data && data.message && Array.isArray(data.message.items) ? data.message.items : [];
              finish(items);
            } catch (e) { finish([]); }
          },
          onerror: () => finish(null),
          ontimeout: () => finish(null)
        });
      } catch (e) { finish(null); }
    });
  }
  const _crossrefCache = new Map();
  function crossrefQueryCached(text) {
    if (_crossrefCache.has(text)) return Promise.resolve(_crossrefCache.get(text));
    return crossrefQuery(text).then(items => { _crossrefCache.set(text, items); return items; });
  }
  function fmtCrossref(item) {
    const authorsArr = Array.isArray(item.author) ? item.author : [];
    const authors = authorsArr.slice(0, 3).map(a => [a.family, a.given ? `${a.given[0]}.` : ''].filter(Boolean).join(', ')).join(', ') + (authorsArr.length > 3 ? ' et al.' : '');
    const year = item.published && item.published['date-parts'] && item.published['date-parts'][0] && item.published['date-parts'][0][0];
    const title = item.title && item.title[0];
    const journal = (item['container-title'] && item['container-title'][0]) || item.publisher;
    return [authors, year, title, journal].filter(Boolean).join('. ').slice(0, 160);
  }
  function scoreBand(score, yearMismatch) {
    if (yearMismatch) return { label: 'Year mismatch', cls: 'doi-low' };
    if (score >= DOI_BAND_HIGH) return { label: 'High confidence', cls: 'doi-high' };
    if (score >= DOI_BAND_MED) return { label: 'Moderate', cls: 'doi-med' };
    return { label: 'Low confidence', cls: 'doi-low' };
  }
  function ncbiSummary(pmid) {
    return new Promise(resolve => {
      const url = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json&tool=rcpi-toolkit&email=${encodeURIComponent(CFG.ncbiEmail)}`;
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      if (!_GMxhr) { finish(null); return; }
      try {
        _GMxhr({
          method: 'GET', url, timeout: 10000, headers: { 'Accept': 'application/json' },
          onload: r => {
            try {
              const data = JSON.parse(r.responseText);
              const result = data && data.result && data.result[pmid];
              if (!result) { finish(null); return; }
              const authors = (result.authors || []).slice(0, 3).map(a => a.name).join(', ') + (result.authors && result.authors.length > 3 ? ' et al.' : '');
              const year = result.pubdate ? result.pubdate.slice(0, 4) : '';
              const title = result.title || '';
              const journal = result.fulljournalname || result.source || '';
              const doi = (result.articleids || []).find(a => a.idtype === 'doi');
              finish({ pmid, summary: [authors, year, title, journal].filter(Boolean).join('. ').slice(0, 160), doiFromNcbi: doi ? doi.value : null, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` });
            } catch { finish(null); }
          },
          onerror: () => finish(null),
          ontimeout: () => finish(null)
        });
      } catch { finish(null); }
    });
  }

  // ─── COPYRIGHT / H5P IMAGE COLLECTION (read-only) ─────────────────────
  function collectImagesDeep(root, out, seenFrames) {
    out = out || [];
    seenFrames = seenFrames || new Set();
    const el = root.body || root;
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.tagName === 'IMG' && node.getAttribute('src')) out.push(node);
      if (node.shadowRoot) Array.from(node.shadowRoot.children).forEach(walk);
      if (node.tagName === 'IFRAME' && !seenFrames.has(node)) {
        seenFrames.add(node);
        try { const doc = node.contentDocument; if (doc) collectImagesDeep(doc, out, seenFrames); } catch (e) {}
      }
      Array.from(node.children || []).forEach(walk);
    };
    walk(el);
    return out;
  }

  function _gmGetFullBody(url, timeout) {
    return new Promise(resolve => {
      if (!_GMxhr) { resolve({ status: 0, errored: true, body: '' }); return; }
      try {
        _GMxhr({
          method: 'GET', url, timeout: timeout || 15000,
          onload: r => resolve({ status: r.status, errored: false, body: r.responseText || '' }),
          onerror: () => resolve({ status: 0, errored: true, body: '' }),
          ontimeout: () => resolve({ status: 0, errored: true, body: '' })
        });
      } catch { resolve({ status: 0, errored: true, body: '' }); }
    });
  }

  function findImagePathsInH5PJson(node, out) {
    if (!node || typeof node !== 'object') return out;
    if (typeof node.path === 'string' && typeof node.mime === 'string' && node.mime.indexOf('image/') === 0) out.push(node.path);
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') findImagePathsInH5PJson(v, out); }
    return out;
  }

  async function scanH5PIframeForCopyright(iframeEl) {
    const src = iframeEl.getAttribute('src') || '';
    if (!/h5p\.com/i.test(src)) return [];
    const r = await _gmGetFullBody(src);
    if (r.errored || !r.body) return [];
    const m = r.body.match(/H5PIntegration\s*=\s*(\{[\s\S]*?\});\s*\n/);
    if (!m) return [];
    let integ;
    try { integ = JSON.parse(m[1]); } catch { return []; }
    const base = (integ.url || '').replace(/\/$/, '');
    const contents = integ.contents || {};
    const out = [];
    for (const cid in contents) {
      const c = contents[cid];
      const contentId = (cid.match(/^cid-(.+)$/) || [])[1];
      if (!contentId || !c.jsonContent) continue;
      let parsed;
      try { parsed = JSON.parse(c.jsonContent); } catch { continue; }
      findImagePathsInH5PJson(parsed, []).forEach(p => {
        const url = base ? `${base}/content/${contentId}/${p}` : '';
        out.push({ filename: (p.split('/').pop() || p), sourceHint: url, title: c.title || '' });
      });
    }
    return out;
  }

  // Scan the current document's DOM images into copyright-audit row shape.
  function scanImagesForCopyright() {
    const pageUrl = location.href;
    const brightspaceUrl = getBrightspaceUrl();
    const whereUsed = document.title || location.pathname;
    const dateStr = new Date().toISOString().slice(0, 10);
    const out = [];
    collectImagesDeep(document).forEach(img => {
      const src = img.getAttribute('src') || '';
      const filename = (src.split('/').pop() || src).split('?')[0];
      const fig = img.closest('figure') || img.closest('.figure-wrapper');
      const capEl = fig && fig.querySelector('figcaption');
      out.push({ date: dateStr, whereUsed, image: filename, sourceUrl: '', basis: '', attribution: capEl ? capEl.textContent.trim() : '', changed: '', pageUrl, brightspaceUrl });
    });
    return out;
  }

  // ─── DOCKED SIDEBAR SHELL FACTORY ─────────────────────────────────────
  // Builds the full-height fixed sidebar both toolkits share. Parameterised
  // by side so Edit docks left and Audit docks right. Returns handles; the
  // caller supplies tab render functions.
  //
  // opts = {
  //   doc,                      // document to mount into (default document)
  //   side: 'left' | 'right',
  //   idPrefix: 'rcpi-audit',   // unique per toolkit (namespaces DOM ids + storage)
  //   title: '🔍 Audit Toolkit',
  //   minIcon: '⟩',             // arrow pointing the collapse direction
  //   width: 380,               // default px width
  //   tabs: [ { id, label, render(bodyEl) } ]
  // }
  function createDockedShell(opts) {
    opts = opts || {};
    const doc = opts.doc || document;
    const side = opts.side === 'right' ? 'right' : 'left';
    const P = opts.idPrefix || 'rcpi-shell';
    const title = opts.title || 'Toolkit';
    const minIcon = opts.minIcon || (side === 'right' ? '⟩' : '⟨');
    const tabs = opts.tabs || [];
    const MIN_KEY = `${P}-minimized`;
    const W_KEY = `${P}-width`;

    injectShellCss(doc);

    // Remove any prior instance (re-mounts on SPA nav).
    const prior = doc.getElementById(`${P}-panel`); if (prior) prior.remove();
    const priorBar = doc.getElementById(`${P}-minbar`); if (priorBar) priorBar.remove();

    let width = parseInt(_GMget(W_KEY, ''), 10);
    if (!width || isNaN(width)) width = opts.width || 380;

    const panel = doc.createElement('div');
    panel.id = `${P}-panel`;
    panel.className = `rcpi-shell rcpi-shell-${side}`;
    panel.style.width = width + 'px';
    panel.innerHTML = `
      <div class="rcpi-shell-hd">
        <span class="rcpi-shell-title">${escapeHtml(title)}</span>
        <span class="rcpi-shell-badges"></span>
        <button class="rcpi-shell-min" title="Minimise to a bar">${minIcon}</button>
      </div>
      <div class="rcpi-shell-tabs"></div>
      <div class="rcpi-shell-panels"></div>
      <div class="rcpi-shell-resize" title="Drag to resize"></div>`;
    doc.body.appendChild(panel);

    const tabsEl = panel.querySelector('.rcpi-shell-tabs');
    const panelsEl = panel.querySelector('.rcpi-shell-panels');
    const rendered = {};

    tabs.forEach((t, idx) => {
      const btn = doc.createElement('button');
      btn.className = 'rcpi-shell-tab' + (idx === 0 ? ' active' : '');
      btn.textContent = t.label;
      btn.dataset.tab = t.id;
      tabsEl.appendChild(btn);

      const body = doc.createElement('div');
      body.className = 'rcpi-shell-tabpanel' + (idx === 0 ? ' active' : '');
      body.id = `${P}-tab-${t.id}`;
      panelsEl.appendChild(body);

      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.rcpi-shell-tab').forEach(b => b.classList.remove('active'));
        panelsEl.querySelectorAll('.rcpi-shell-tabpanel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        body.classList.add('active');
        // Render on first visit only. Re-invoking render() on every click
        // is exactly what caused Links/Citations to silently re-run their
        // network probes each time the tab was revisited — a tab's own
        // "Rescan"/"Check" button (or shell.rerender()) is the only
        // intended way to trigger that again.
        if (t.render && !rendered[t.id]) { try { t.render(body); rendered[t.id] = true; } catch (e) { body.textContent = 'Error rendering tab.'; } }
      });
    });

    // Render the first tab immediately.
    if (tabs[0] && tabs[0].render) { try { tabs[0].render(panelsEl.querySelector(`#${P}-tab-${tabs[0].id}`)); rendered[tabs[0].id] = true; } catch (e) {} }

    // Minimised bar.
    const minbar = doc.createElement('div');
    minbar.id = `${P}-minbar`;
    minbar.className = `rcpi-shell-minbar rcpi-shell-minbar-${side}`;
    minbar.innerHTML = `<span>${escapeHtml(title)}</span>`;
    minbar.style.display = 'none';
    doc.body.appendChild(minbar);

    function setMinimized(min) {
      panel.style.display = min ? 'none' : 'flex';
      minbar.style.display = min ? 'flex' : 'none';
      try { _GMset(MIN_KEY, min ? '1' : '0'); } catch {}
    }
    panel.querySelector('.rcpi-shell-min').addEventListener('click', () => setMinimized(true));
    minbar.addEventListener('click', () => setMinimized(false));

    // Resize (handle on the inner edge; direction depends on side).
    const handle = panel.querySelector('.rcpi-shell-resize');
    let resizing = false;
    handle.addEventListener('mousedown', (e) => { resizing = true; e.preventDefault(); doc.body.style.userSelect = 'none'; });
    doc.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      let w = side === 'right' ? (doc.documentElement.clientWidth - e.clientX) : e.clientX;
      w = Math.max(280, Math.min(720, w));
      panel.style.width = w + 'px';
    });
    doc.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      doc.body.style.userSelect = '';
      try { _GMset(W_KEY, String(parseInt(panel.style.width, 10))); } catch {}
    });

    // Restore persisted minimised state; if never set, fall back to
    // opts.defaultMinimized (Audit defaults closed — see rebuild notes).
    try {
      const persisted = _GMget(MIN_KEY, null);
      if (persisted === '1') setMinimized(true);
      else if (persisted === null && opts.defaultMinimized) setMinimized(true);
    } catch {}

    return {
      panel, minbar,
      setMinimized,
      getTabBody: (id) => panelsEl.querySelector(`#${P}-tab-${id}`),
      setBadge: (html) => { panel.querySelector('.rcpi-shell-badges').innerHTML = html || ''; },
      rerender: (id) => { const t = tabs.find(x => x.id === id); const b = panelsEl.querySelector(`#${P}-tab-${id}`); if (t && t.render && b) t.render(b); }
    };
  }

  function injectShellCss(doc) {
    if (doc.getElementById('rcpi-shell-css')) return;
    const s = doc.createElement('style');
    s.id = 'rcpi-shell-css';
    // Matches the Edit Toolkit's actual chrome (#bb-tk-panel and friends) —
    // same header treatment, underline-style tabs, spacing, and button
    // tokens — so the two toolkits read as one family rather than two
    // differently-designed panels. Kept under its own rcpi-shell-* class
    // names (not literally shared bb-* classes) since the two scripts can
    // never be certain they aren't both present in the same top document.
    s.textContent = `
      .rcpi-shell {
        position: fixed; top: 0; bottom: 0; z-index: 2000000;
        display: flex; flex-direction: column;
        background: #fff; color: #1b2733;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 0 14px rgba(0,0,0,.18);
      }
      .rcpi-shell-left  { left: 0;  border-right: 1px solid #cdd5dc; }
      .rcpi-shell-right { right: 0; border-left: 1px solid #cdd5dc; }
      .rcpi-shell-hd {
        display: flex; align-items: center; gap: 6px;
        padding: 11px 12px; background: #002d72; color: #fff; flex: 0 0 auto;
        user-select: none;
      }
      .rcpi-shell-title { font-weight: 700; flex: 1; font-size: 15px; }
      .rcpi-shell-badges { font-size: 11px; }
      .rcpi-shell-min {
        background: none; border: none; color: #fff; cursor: pointer;
        font-size: 18px; padding: 0 4px; line-height: 1;
      }
      .rcpi-shell-min:hover { opacity: .8; }
      .rcpi-shell-tabs {
        display: flex; border-bottom: 1px solid #dee2e6; background: #f8f9fa; flex: 0 0 auto;
      }
      .rcpi-shell-tab {
        flex: 1; padding: 8px 6px; border: none; border-bottom: 2px solid transparent;
        background: none; cursor: pointer; font-size: 13px; color: #6e7477;
      }
      .rcpi-shell-tab.active { color: #002d72; border-bottom-color: #002d72; font-weight: 700; }
      .rcpi-shell-panels { overflow-y: auto; flex: 1; }
      .rcpi-shell-tabpanel { display: none; padding: 8px 10px; }
      .rcpi-shell-tabpanel.active { display: block; }
      .rcpi-shell-resize {
        position: absolute; top: 0; bottom: 0; width: 6px; cursor: ew-resize;
      }
      .rcpi-shell-left  .rcpi-shell-resize { right: -3px; }
      .rcpi-shell-right .rcpi-shell-resize { left: -3px; }
      .rcpi-shell-resize:hover { background: rgba(0,45,114,.25); }
      .rcpi-shell-minbar {
        position: fixed; top: 0; bottom: 0; width: 52px; z-index: 2000000;
        background: #002d72; color: #fff; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 2px 0 12px rgba(0,0,0,.2);
      }
      .rcpi-shell-minbar-left  { left: 0; }
      .rcpi-shell-minbar-right { right: 0; }
      .rcpi-shell-minbar:hover { background: #0040a0; }
      .rcpi-shell-minbar span { writing-mode: vertical-rl; transform: rotate(180deg); font-weight: 700; letter-spacing: .04em; font-size: 13px; }
      .rcpi-toast {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%) translateY(10px);
        background: #1b2733; color: #fff; padding: 8px 14px; border-radius: 6px;
        font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        z-index: 2100000; opacity: 0; transition: opacity .25s, transform .25s; pointer-events: none;
      }
      .rcpi-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      .rcpi-locate-flash {
        outline: 3px solid #ffb300 !important;
        outline-offset: 2px;
        animation: rcpi-locate-pulse 2.2s ease-out;
      }
      @keyframes rcpi-locate-pulse {
        0%, 40% { background-color: rgba(255,179,0,.35); box-shadow: 0 0 0 6px rgba(255,179,0,.25); }
        100% { background-color: transparent; box-shadow: 0 0 0 6px rgba(255,179,0,0); }
      }
    `;
    doc.head.appendChild(s);
  }

  // ─── EXPORT ───────────────────────────────────────────────────────────
  const API = {
    version: '1.0.0',
    config: CFG,

    // generic
    escapeHtml, cssEsc, findTopSameOriginDoc, getBrightspaceUrl,
    editUrlToViewUrl, topicKeyFromViewUrl,
    downloadCsv, downloadMarkdown, toast, locateInPage,

    // storage
    loadIgnoreDomains, saveIgnoreDomains, isDomainIgnored, DEFAULT_IGNORE_DOMAINS,
    loadAuditSession, saveAuditSession,

    // links
    lintHref, lintAnchors, TRACKING_PARAMS, stripTrackingFromUrl, NONDESCRIPTIVE_LINK_TEXT,

    // probe
    runProbe, probeWithRetry, classifyStatus, looksSoftBroken, isProbableUrl,

    // a11y
    runA11y, SEV_ORDER, rgbLuminance, contrastRatio, findEffectiveBg,

    // citations
    DOI_RE, PMID_RE, DOI_YEAR_RE, extractYear, endsWithRefMarker,
    extractRawDoi, hasDoi, extractRawPmid, extractRawPmcid, collectPmids, hasPmidLink, hasPmcidLink,
    findReferencesContainer, collectReferenceEls, collectShortReferenceCandidates, refQueryText,
    crossrefQueryCached, fmtCrossref, scoreBand, ncbiSummary,

    // copyright / h5p
    collectImagesDeep, findImagePathsInH5PJson, scanH5PIframeForCopyright, scanImagesForCopyright,

    // ui
    createDockedShell,

    // registries (expansion points)
    registerA11yCheck, registerFixCheck, runCustomFixChecks, registerAuditTab, CUSTOM_AUDIT_TABS,
  };

  window.RCPIShared = API;
  try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.RCPIShared = API; } catch (e) {}
})();