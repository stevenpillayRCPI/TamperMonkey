// ==UserScript==
// @name         RCPI Brightspace Audit Toolkit
// @namespace    rcpi-content-audit
// @description  Content editing suite: 404/image checker (HEAD-first, retry, redirects, mixed-content, ignore-list), URL linter, find/replace (dry-run + undo), DOI+PMID lookup, accessibility (WCAG 2.1 AA), Settings tab, CSV/Markdown export, keyboard shortcut.
// @match        https://brightspace.rcpi.ie/d2l/le/lessons/*/edit/*
// @match        https://brightspace.rcpi.ie/d2l/lms/content/*/edit/*
// @version      3.1
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // FEATURES CONFIG
  // enabled: include this feature at all
  // autoRunPageLoad: run silently in background when editor loads; results cached, FAB badge updated
  // before-save intercept has no autoRun; it fires on D2L Save.
const FEATURES = {
  // NOTE: linkChecker auto-run fires a GET at every external link/image when the
  // editor loads (downloads full files, 4 at a time, up to 15s each). It is now
  // actually wired up, but left OFF by default so we don't hammer external servers
  // on every page open. Flip autoRunPageLoad to true to warm the 404 cache on load.
  linkChecker:   { enabled: true,  autoRunPageLoad: false },
  doiLookup:     { enabled: true,  autoRunPageLoad: true  },
  pmidLookup:    { enabled: true },   // resolve PubMed IDs alongside DOI
  accessibility: { enabled: true,  autoRunPageLoad: true  },
  beforeSave:    { enabled: true },

  imageSizeKB: 1000,
  imageWidthPx: 2000,

  // link checker behaviour
  probeHeadFirst:   true,    // try HEAD before GET (saves bandwidth)
  probeRetryOnce:   true,    // retry once on timeout / 5xx
  probeFlagRedirect: true,   // surface 3xx redirects as warnings
  probeFlagMixed:   true,    // flag http:// links/images on an https: page

  // keyboard shortcut to open panel (Alt+Shift+E by default)
  keyboardShortcut: true,
  shortcutKey: 'e',   // combined with Alt+Shift
};

  // STORAGE / RULES
  const RULES_KEY     = 'rcpi-link-rules-v1';
  const IGNORE_KEY    = 'rcpi-probe-ignore-v1';
  const SETTINGS_KEY  = 'rcpi-settings-v1';

  // Domains that commonly wall/block HEAD requests — skip probing them
  const DEFAULT_IGNORE_DOMAINS = [
    'doi.org', 'dx.doi.org', 'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov',
    'www.nejm.org', 'www.thelancet.com', 'jamanetwork.com', 'bmj.com',
    'www.bmj.com', 'academic.oup.com', 'journals.lww.com', 'onlinelibrary.wiley.com',
    'link.springer.com', 'www.sciencedirect.com', 'www.nature.com',
    'europepmc.org', 'www.cochranelibrary.com'
  ];

  function loadIgnoreDomains() {
    try {
      const raw = GM_getValue(IGNORE_KEY, null);
      if (!raw) return DEFAULT_IGNORE_DOMAINS.slice();
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : DEFAULT_IGNORE_DOMAINS.slice();
    } catch { return DEFAULT_IGNORE_DOMAINS.slice(); }
  }

  function saveIgnoreDomains(list) {
    GM_setValue(IGNORE_KEY, JSON.stringify(list, null, 2));
  }

  function isDomainIgnored(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const ignored = loadIgnoreDomains();
      return ignored.some(d => {
        const clean = d.replace(/^www\./, '');
        return host === clean || host.endsWith('.' + clean);
      });
    } catch { return false; }
  }

  // Persisted settings override — overlaid on FEATURES at runtime
  function loadSettings() {
    try {
      const raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch { return {}; }
  }

  function saveSettings(obj) {
    GM_setValue(SETTINGS_KEY, JSON.stringify(obj, null, 2));
  }

  // Merge saved settings into FEATURES on startup
  (function applySettings() {
    const s = loadSettings();
    const flat = [
      'imageSizeKB','imageWidthPx','probeHeadFirst','probeRetryOnce',
      'probeFlagRedirect','probeFlagMixed','keyboardShortcut','shortcutKey'
    ];
    flat.forEach(k => { if (k in s) FEATURES[k] = s[k]; });
    ['linkChecker','doiLookup','pmidLookup','accessibility','beforeSave'].forEach(k => {
      if (s[k] && typeof s[k] === 'object') Object.assign(FEATURES[k], s[k]);
    });
  })();
  const DEFAULT_RULES = [
    { field: 'href', match: 'contains', find: 'oldcdn.rcpi.ie', replaceHref: 'brightspace.rcpi.ie', replaceText: null },
    { field: 'href', match: 'exact', find: 'https://example.com/old', replaceHref: 'https://example.com/new', replaceText: 'New link text' }
  ];

  function loadRules() {
    try {
      const raw = GM_getValue(RULES_KEY, null);
      if (!raw) return DEFAULT_RULES.slice();
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : DEFAULT_RULES.slice();
    } catch (e) {
      return DEFAULT_RULES.slice();
    }
  }

  function saveRules(r) {
    GM_setValue(RULES_KEY, JSON.stringify(r, null, 2));
  }

  // EDITOR ACCESS
  const PW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function getEditor() {
    const tm = PW.tinymce;
    if (typeof tm === 'undefined') return null;
    try {
      const ae = tm.activeEditor;
      if (ae) {
        try { if (ae.getBody()) return ae; } catch {}
      }
    } catch {}

    try {
      let l = tm.editors;
      if (!l) l = [];
      if (!Array.isArray(l)) l = Object.values(l);
      for (const e of l) {
        try { if (e && e.getBody()) return e; } catch {}
      }
    } catch {}

    try { if (tm.activeEditor) return tm.activeEditor; } catch {}
    return null;
  }

  function getLinks(ed) {
    return [...ed.getBody().querySelectorAll('a[href]')];
  }

  function getImages(ed) {
    return [...ed.getBody().querySelectorAll('img[src]')];
  }

  function getEditorKey(ed) {
    try {
      const body = ed && ed.getBody ? ed.getBody() : null;
      const bodyId = body && body.id ? body.id : '';
      const edId = ed && ed.id ? ed.id : '';
      return [location.pathname, location.search, edId, bodyId].join('||');
    } catch {
      return [location.pathname, location.search].join('||');
    }
  }

  // SCROLL / LOCATE
  // FIX 1: removed dead ed.selection.scrollIntoView branch (not a real TinyMCE API);
  // ed.selection.select() is kept so the cursor moves into the element.
  function locateInEditor(ed, el) {
    try {
      ed.selection.select(el);
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const cls = 'rcpi-locate-flash';
      el.classList.add(cls);
      setTimeout(() => el.classList.remove(cls), 2200);
    } catch (e) {}
  }

  // CONTAINER CONTEXT
  const LINKMARK = '[link]';
  const BLOCK = new Set(['P','LI','TD','TH','DIV','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','FIGCAPTION','DD','DT','CAPTION']);

  function containerInfo(a) {
    let el = a.parentElement;
    while (el && !BLOCK.has(el.tagName)) el = el.parentElement;
    if (!el) return { el: null, tag: '', text: '', marked: '', editable: false };

    let editable = a.parentElement === el;
    let otherEls = 0;
    [...el.childNodes].forEach(n => { if (n.nodeType === 1 && n !== a) otherEls++; });
    if (otherEls > 0) editable = false;

    let marked = '';
    [...el.childNodes].forEach(n => {
      if (n === a) marked += LINKMARK;
      else if (n.nodeType === 3) marked += n.nodeValue;
      else marked += n.textContent;
    });
    marked = marked.replace(/\s+/g, ' ').trim();

    const text = el.textContent.trim().replace(/\s+/g, ' ');
    return { el, tag: el.tagName.toLowerCase(), text, marked, editable };
  }

  function applyContainer(ed, a, edited) {
    const el = a.parentElement;
    const parts = edited.split(LINKMARK);
    if (parts.length !== 2) {
      return { ok: false, error: parts.length < 2 ? 'missing link marker' : 'more than one link marker' };
    }
    const doc = el.ownerDocument;
    while (el.firstChild) el.removeChild(el.firstChild);
    if (parts[0].length) el.appendChild(doc.createTextNode(parts[0]));
    el.appendChild(a);
    if (parts[1].length) el.appendChild(doc.createTextNode(parts[1]));
    return { ok: true };
  }

  // EDITOR WRITE HELPERS
  function flagDirty(ed) {
    try { ed.setDirty(true); } catch {}
    try { ed.fire('input'); } catch {}
    try { ed.fire('change'); } catch {}
  }

  function setHref(ed, a, href) {
    ed.dom.setAttrib(a, 'href', href);
  }

  function setText(ed, a, text) {
    ed.dom.setHTML(a, ed.dom.encode(text));
  }

  // FIND / REPLACE
  function ruleMatches(rule, a) {
    const href = a.getAttribute('href') || '';
    const text = a.textContent || '';
    const test = v => rule.match === 'contains' ? v.includes(rule.find) : v === rule.find;
    if (rule.field === 'href') return test(href);
    if (rule.field === 'text') return test(text);
    return test(href) || test(text);
  }

  function proposed(rule, a) {
    const oldHref = a.getAttribute('href') || '';
    const oldText = a.textContent || '';
    let newHref = oldHref;
    if (rule.replaceHref !== null && rule.replaceHref !== '') {
      newHref = rule.match === 'contains' && rule.field !== 'text'
        ? oldHref.split(rule.find).join(rule.replaceHref)
        : rule.replaceHref;
    }
    let newText = oldText;
    if (rule.replaceText !== null && rule.replaceText !== '') {
      newText = rule.replaceText;
    }
    return { oldHref, oldText, newHref, newText };
  }

  function collectReplaceMatches(ed) {
    const rules = loadRules(), out = [];
    getLinks(ed).forEach(a => {
      for (const rule of rules) {
        if (ruleMatches(rule, a)) {
          const p = proposed(rule, a);
          if (p.newHref !== p.oldHref || p.newText !== p.oldText) out.push({ a, rule, ...p });
          break;
        }
      }
    });
    return out;
  }

  // STRUCTURAL URL LINTER
  function lintHref(raw) {
    let h = raw || '', reasons = [];
    const note = r => { if (!reasons.includes(r)) reasons.push(r); };

    const ltrim = h.replace(/^[\s"'""''<>()\[\]{}]+/, '');
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
        if (/[.,;:!?]$/.test(last)) {
          h = h.slice(0, -1);
          note('removed trailing junk');
          changed = true;
          continue;
        }
        if (last === ')') {
          const opens = (h.match(/\(/g) || []).length;
          const closes = (h.match(/\)/g) || []).length;
          if (closes > opens) {
            h = h.slice(0, -1);
            note('removed trailing junk');
            changed = true;
          }
        }
      }

      h = h.trim();
    }

    if (h === raw) return null;
    return { fixed: h, reasons };
  }

  function collectLintMatches(ed) {
    const out = [];
    getLinks(ed).forEach(a => {
      const raw = a.getAttribute('href');
      const r = lintHref(raw);
      if (r) out.push({ a, oldHref: raw, newHref: r.fixed, reasons: r.reasons, text: a.textContent });
    });
    return out;
  }

  // 404 / SOFT-404 PROBE
  const BROKEN_STATUS = new Set([404, 410]);
  const BINARY_EXT = /\.(pdf|docx?|pptx?|xlsx?|zip|rar|7z|mp4|mp3|mov|avi|png|jpe?g|gif|svg|csv|epub)$/i;
  const SOFT404_MARKERS = [
    'blob not found', 'page not found', 'not found', 'error 404', 'does not exist',
    'cannot be found', 'no longer available', 'object not found', 'file not found'
  ];
  let probeCache = null;
  let probeCacheEdId = null;
  let probeRunning = false;
  let probeRunPromise = null;

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

  // Generation token — incremented on teardown so stale results can be discarded
  let probeGeneration = 0;

  function _gmGet(url, method, extraHeaders, timeout) {
    return new Promise(resolve => {
      const finish = (status, errored, ctype, body, loc, contentLength) =>
        resolve({ status, errored, ctype, body, finalUrl: loc || url, contentLength: contentLength || 0 });
      try {
        GM_xmlhttpRequest({
          method,
          url,
          timeout: timeout || 15000,
          headers: extraHeaders || {},
          onload: r => {
            let ctype = '';
            try { const m = r.responseHeaders.match(/content-type:\s*([^\n\r]+)/i); if (m) ctype = m[1].trim(); } catch {}
            let loc = '';
            try { const m = r.responseHeaders.match(/location:\s*([^\n\r]+)/i); if (m) loc = m[1].trim(); } catch {}
            // FIX 3: read Content-Length for image size checking
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
    if (!FEATURES.probeHeadFirst) {
      return _gmGet(url, 'GET', {}, 15000);
    }
    // HEAD first
    const head = await _gmGet(url, 'HEAD', {}, 10000);
    if (head.status === 405 || head.status === 501 || head.errored) {
      // Server refuses HEAD — use ranged GET to limit download
      return _gmGet(url, 'GET', { 'Range': 'bytes=0-4095' }, 15000);
    }
    // If HEAD says 200 and it's HTML, sample body for soft-404 text
    const isHtml = head.ctype.toLowerCase().includes('text/html');
    const isBin  = BINARY_EXT.test(url);
    if (head.status >= 200 && head.status < 300 && isHtml && !isBin) {
      return _gmGet(url, 'GET', { 'Range': 'bytes=0-4095' }, 15000);
    }
    return head;
  }

  async function probeWithRetry(url) {
    const result = await probe(url);
    if (!FEATURES.probeRetryOnce) return result;
    const shouldRetry = result.errored || (result.status >= 500 && result.status < 600);
    if (!shouldRetry) return result;
    await new Promise(r => setTimeout(r, 1500));
    return probe(url);
  }

  function isProbableUrl(url) {
    return /^https?/i.test(url) && !/^https?:\/\/(localhost|127\.)/i.test(url);
  }

  // FIX 3 (continued): IMAGE_EXT used to identify image URLs for size checking
  const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?)(\?.*)?$/i;

  async function runProbe(ed, onProgress) {
    const myGen = ++probeGeneration;
    const map = new Map();
    const pageIsHttps = location.protocol === 'https:';

    const tag = (el, type) => {
      const url = (el.getAttribute(type === 'img' ? 'src' : 'href') || '').trim();
      if (!isProbableUrl(url)) return;
      if (!map.has(url)) map.set(url, { anchors: [], imgs: [], type });
      const entry = map.get(url);
      if (type === 'img') entry.imgs.push(el);
      else entry.anchors.push(el);
    };

    getLinks(ed).forEach(a => tag(a, 'link'));
    getImages(ed).forEach(img => tag(img, 'img'));

    const urls = [...map.keys()];
    const results = [];
    let i = 0, active = 0, idx = 0;
    const CONCURRENCY = 4;

    return new Promise(resolve => {
      const pump = () => {
        if (myGen !== probeGeneration) { resolve([]); return; }
        if (idx >= urls.length && active === 0) { resolve(results); return; }

        while (active < CONCURRENCY && idx < urls.length) {
          const url = urls[idx++];

          // Mixed-content: http link/image on https page
          if (FEATURES.probeFlagMixed && pageIsHttps && /^http:/i.test(url)) {
            results.push({
              url, status: 0, errored: false, klass: 'warn',
              reason: 'Mixed content: http resource on https page',
              isMixed: true,
              ...map.get(url)
            });
            i++;
            if (onProgress) onProgress(i, urls.length);
            pump();
            continue;
          }

          // Ignored domain
          if (isDomainIgnored(url)) {
            results.push({
              url, status: 0, errored: false, klass: 'ignored',
              reason: 'Domain on ignore list',
              ...map.get(url)
            });
            i++;
            if (onProgress) onProgress(i, urls.length);
            pump();
            continue;
          }

          active++;
          probeWithRetry(url).then(({ status, errored, ctype, body, finalUrl, contentLength }) => {
            if (myGen !== probeGeneration) { active--; pump(); return; }
            let klass = classifyStatus(status, errored), reason = '';

            if (klass === 'ok') {
              const soft = looksSoftBroken(url, ctype, body);
              if (soft) { klass = 'broken'; reason = soft; }
              // Redirect
              else if (FEATURES.probeFlagRedirect && finalUrl && finalUrl !== url) {
                klass = 'redirect';
                reason = `Redirects to: ${finalUrl}`;
              }
              // FIX 3: flag oversized images based on Content-Length header
              else if (IMAGE_EXT.test(url) && contentLength > 0) {
                const sizeKB = Math.round(contentLength / 1024);
                if (sizeKB > FEATURES.imageSizeKB) {
                  klass = 'warn';
                  reason = `Image is ${sizeKB} KB (threshold: ${FEATURES.imageSizeKB} KB)`;
                }
              }
            } else if (klass === 'broken') {
              reason = errored ? 'unreachable' : `HTTP ${status}`;
            } else if (klass === 'uncertain') {
              reason = `HTTP ${status}`;
            }

            results.push({ url, status, errored, klass, reason, finalUrl, contentLength, ...map.get(url) });
            active--;
            i++;
            if (onProgress) onProgress(i, urls.length);
            pump();
          });
        }
      };
      if (!urls.length) resolve(results);
      else pump();
    });
  }

    function startProbeBackground(ed, onProgress) {
    const edId = getEditorKey(ed);

    if (probeRunning && probeCacheEdId === edId) return probeRunPromise;
    if (probeCache && probeCacheEdId === edId) {
      if (onProgress) onProgress(probeCache.length, probeCache.length);
      return Promise.resolve(probeCache);
    }

    probeRunning = true;
    probeCacheEdId = edId;

    probeRunPromise = runProbe(ed, onProgress)
      .then(results => {
        probeCache = results;
        probeCacheEdId = edId;
        probeRunning = false;
        probeRunPromise = null;
        return results;
      })
      .catch(err => {
        probeRunning = false;
        probeRunPromise = null;
        throw err;
      });

    return probeRunPromise;
  }

  function resetProbeState() {
    probeGeneration++;
    probeCache = null;
    probeCacheEdId = null;
    probeRunning = false;
    probeRunPromise = null;
  }

  // ACCESSIBILITY / HYGIENE / HEADING AUDIT ENGINE
  let a11yCache = null;
  let a11yCacheEdId = null;

  const NONDESCRIPTIVE_LINK_TEXT = new Set([
    'click here', 'here', 'read more', 'more', 'link', 'this link', 'go', 'visit',
    'download', 'learn more', 'info', 'information', 'details', 'page', 'website', 'web site',
    'see here', 'see more', 'view', 'view here', 'source', 'reference', 'article', 'full text'
  ]);
  const BRIGHTSPACE_HOST_RE = /^https?:\/\/brightspace\.rcpi\.ie/i;
  const FILE_TYPE_RE = /\.(pdf|docx?|pptx?|xlsx?|zip|mp4|mp3|mov|xls[xm]?)$/i;
  const FILE_LABEL_RE = /(pdf|word|doc|pptx?|excel|xlsx?|zip|mp4|mp3|video|audio|download|spreadsheet|presentation)/i;
  const COLOUR_PROP_RE = /(color|background-color)\s*:/i;
  const FILENAME_ALT_RE = /^[\w.\-_]+\.(png|jpe?g|gif|svg|webp|bmp|tiff?)$/i;  // alt that's just a filename

  function hexLuminance(hex) {
    const h = hex.replace('#', '');
    if (h.length !== 3 && h.length !== 6) return null;
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const r = parseInt(full.slice(0,2), 16) / 255;
    const g = parseInt(full.slice(2,4), 16) / 255;
    const b = parseInt(full.slice(4,6), 16) / 255;
    const ch = v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }

  function contrastRatio(l1, l2) {
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function parseInlineColour(style, prop) {
    const m = style.match(new RegExp(`${prop}\\s*:\\s*([^;]+)`, 'i'));
    if (!m) return null;
    const v = m[1].trim();
    const hex = v.match(/#[0-9a-f]{3,6}/i);
    if (hex) return hexLuminance(hex[0]);
    return null;
  }

  function runA11y(ed) {
    const body = ed.getBody();
    const issues = [];
    const note = (severity, category, el, msg, fix) => issues.push({ severity, category, el: el || null, msg, fix: fix || null });

    // Collect all alt texts to detect duplicates across images
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
        if (/^(image of|photo of|picture of)\b/i.test(alt)) note('warn', 'Images', img, `alt text starts with redundant phrase: "${alt.slice(0,40)}"`, null);
        if (alt.length > 150) note('warn', 'Images', img, `alt text is very long (${alt.length} chars); aim for under 150`, null);
        if (FILENAME_ALT_RE.test(alt)) note('warn', 'Images', img, `alt text looks like a filename: "${alt.slice(0,50)}" — replace with a real description`, null);
        if ((altCounts[alt] || 0) > 1) note('info', 'Images', img, `Duplicate alt text across ${altCounts[alt]} images: "${alt.slice(0,50)}" — each image should have a unique description unless truly identical`, null);
      }
    });

    body.querySelectorAll('a[href]').forEach(a => {
      const text = a.textContent.trim();
      const href = a.getAttribute('href') || '';
      const low = text.toLowerCase().replace(/[^a-z ]/g, '').trim();

      if (!text) note('error', 'Links', a, 'Link has no visible text; screen reader users will hear the URL only', null);
      else if (NONDESCRIPTIVE_LINK_TEXT.has(low)) note('warn', 'Links', a, `Non-descriptive link text: "${text}"`, null);
      else if (/^https?:/i.test(text)) note('warn', 'Links', a, `Link text is a bare URL: ${text.slice(0,60)}`, 'fix-bare-url');

      if (FILE_TYPE_RE.test(href) && !FILE_LABEL_RE.test(text) && !FILE_LABEL_RE.test(a.getAttribute('title') || '')) {
        const ext = (href.match(FILE_TYPE_RE) || [,'file'])[1];
        note('warn', 'Links', a, `Link to .${ext} file has no file type in its text`, null);
      }

      if (BRIGHTSPACE_HOST_RE.test(href)) note('info', 'Hygiene', a, 'Hardcoded Brightspace URL; consider converting to a D2L quicklink', null);

      if (href.startsWith('#')) {
        const target = href.slice(1);
        if (target && !body.querySelector(`#${CSS.escape(target)}`)) {
          note('error', 'Hygiene', a, `Broken fragment link target "${target}"`, null);
        }
      }
    });

    body.querySelectorAll('a[name]').forEach(a => {
      if (!a.getAttribute('href')) note('info', 'Hygiene', a, `Legacy <a name="${a.getAttribute('name')}"> should be id on the target element instead`, null);
    });

    const idCount = {};
    body.querySelectorAll('[id]').forEach(el => {
      const id = el.getAttribute('id');
      if (!id) return;
      idCount[id] = (idCount[id] || 0) + 1;
    });
    Object.entries(idCount).filter(([,n]) => n > 1).forEach(([id, n]) => {
      note('error', 'Hygiene', body.querySelector(`#${CSS.escape(id)}`), `Duplicate id "${id}" (${n} occurrences); ids must be unique`, null);
    });

    body.querySelectorAll('table').forEach(table => {
      if (!table.querySelector('caption')) note('warn', 'Tables', table, 'Table has no caption; add a caption to describe the table\'s purpose', null);
      const ths = [...table.querySelectorAll('th')];
      if (!ths.length) note('warn', 'Tables', table, 'Table has no <th> header cells; add headers and scope attributes', null);
      else ths.filter(th => !th.getAttribute('scope')).forEach(th => {
        note('warn', 'Tables', th, `<th> missing scope attribute: ${th.textContent.trim().slice(0,30)}`, null);
      });
    });

    body.querySelectorAll('b').forEach(el => note('info', 'Semantics', el, `<b> used for "${el.textContent.trim().slice(0,30)}"; use <strong> for emphasis, or CSS for visual-only bold`, 'b-to-strong'));
    body.querySelectorAll('i').forEach(el => note('info', 'Semantics', el, `<i> used for "${el.textContent.trim().slice(0,30)}"; use <em> for emphasis, or CSS for visual-only italic`, 'i-to-em'));

    body.querySelectorAll('[style]').forEach(el => {
      const style = el.getAttribute('style');
      if (!COLOUR_PROP_RE.test(style)) return;
      const fg = parseInlineColour(style, 'color');
      const bg = parseInlineColour(style, 'background-color');
      if (fg !== null && bg !== null) {
        const ratio = contrastRatio(fg, bg);
        if (ratio < 4.5) note('warn', 'Colour', el, `Low colour contrast ratio (${ratio.toFixed(1)}:1); WCAG AA requires 4.5:1 for text`, null);
      } else {
        note('info', 'Colour', el, 'Inline colour style detected; verify contrast meets WCAG AA 4.5:1', null);
      }
    });

    const headings = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const h1s = headings.filter(h => h.tagName === 'H1');
    if (h1s.length > 1) {
      h1s.forEach(h => note('error', 'Headings', h, `Multiple h1 elements (${h1s.length} found); only one h1 per page`, null));
    }

    headings.forEach(h => {
      const text = h.textContent.trim();
      if (!text) note('error', 'Headings', h, `Empty ${h.tagName.toLowerCase()} heading`, null);
      else if (text.length < 4) note('warn', 'Headings', h, 'Very short heading text may be used for visual styling rather than structure', null);
      else if (text === text.toUpperCase() && /[A-Z]{3,}/.test(text)) note('warn', 'Headings', h, `All-caps heading: ${text.slice(0,40)}`, null);
    });

    for (let i = 1; i < headings.length; i++) {
      const prev = parseInt(headings[i-1].tagName[1], 10);
      const curr = parseInt(headings[i].tagName[1], 10);
      if (curr > prev + 1) note('warn', 'Headings', headings[i], `Heading level skipped (h${prev} → h${curr}); levels should increment by one`, 'fix-skipped-heading');
    }

    body.querySelectorAll('p, li, td, th, h1, h2, h3, h4, h5, h6').forEach(el => {
      const html = el.innerHTML.trim();
      const text = el.textContent.trim().replace(/\u00a0/g, '');
      const isEmptyish = !text || html === '&nbsp;' || html === '<br>' || html === '<br />' || /^(&nbsp;)?<br\s*\/?>$/i.test(html);

      if (isEmptyish && el.tagName === 'P') note('info', 'Hygiene', el, `Empty paragraph, possibly a paste artefact: ${html.slice(0,30) || '(blank)'}`, 'remove-empty');
      else if (isEmptyish && /^H[1-6]$/.test(el.tagName)) note('error', 'Headings', el, `Empty ${el.tagName.toLowerCase()} heading`, null);
    });

    // Fake heading detection: short <p> entirely wrapped in <strong> or <b>
    body.querySelectorAll('p').forEach(el => {
      const txt = el.textContent.trim();
      if (!txt || txt.length > 120) return;
      const child = el.children;
      if (child.length === 1 && (child[0].tagName === 'STRONG' || child[0].tagName === 'B')) {
        const innerTxt = child[0].textContent.trim();
        if (innerTxt === txt && txt.length >= 3) {
          note('warn', 'Headings', el, `Fake heading: short paragraph using only bold text "${txt.slice(0,50)}" — use a proper <h2>/<h3> instead`, null);
        }
      }
    });

    // Document links: flag PDFs/Office docs without accessibility note
    body.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const text = a.textContent.trim();
      const ext = (href.match(/\.(pdf|docx?|pptx?|xlsx?|xls[xm]?)$/i) || [])[1];
      if (!ext) return;
      const alreadyFlagged = issues.some(i => i.el === a && i.category === 'Links' && /file/.test(i.msg));
      if (!alreadyFlagged && !FILE_LABEL_RE.test(text) && !FILE_LABEL_RE.test(a.getAttribute('title') || '')) {
        note('info', 'Links', a, `Link to .${ext.toUpperCase()} file: verify the document itself is accessible`, null);
      }
    });

    // Language attribute check: body should have lang
    const bodyEl = ed.getBody();
    const bodyLang = bodyEl.getAttribute('lang') || bodyEl.closest('[lang]');
    if (!bodyLang) {
      const htmlEl = bodyEl.ownerDocument && bodyEl.ownerDocument.documentElement;
      if (htmlEl && !htmlEl.getAttribute('lang')) {
        note('warn', 'Structure', null, 'No lang attribute found on the page; screen readers need this to choose the right voice', null);
      }
    }

    body.querySelectorAll('img').forEach(img => {
      const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10);
      if (w > FEATURES.imageWidthPx) note('warn', 'Images', img, `Image is very wide (${w}px); consider resizing to ${FEATURES.imageWidthPx}px before uploading`, null);
    });

    const headingTree = headings.map(h => ({
      el: h,
      level: parseInt(h.tagName[1], 10),
      text: h.textContent.trim()
    }));

    const allText = body.textContent.trim().replace(/\s+/g, ' ');
    const wordCount = allText ? allText.split(' ').filter(w => w.length > 0).length : 0;
    const readMins = Math.max(1, Math.round(wordCount / 200));

    return { issues, headingTree, wordCount, readMins };
  }

  const SEV_ORDER = { error: 0, warn: 1, info: 2 };

  function runAndCacheA11y(ed) {
  const result = runA11y(ed);
  a11yCache = result;
  a11yCacheEdId = getEditorKey(ed);
  return result;
}

  function suggestLinkText(a) {
    if (!a || a.tagName !== 'A') return null;
    const href = (a.getAttribute('href') || '').trim();
    const text = (a.textContent || '').trim();
    if (!/^https?:/i.test(text)) return null;

    try {
      const u = new URL(href || text);
      const parts = u.pathname.split('/').filter(Boolean);
      let last = parts[parts.length - 1] || u.hostname.replace(/^www\./i, '');

      if (/^NBK\d+$/i.test(last) && parts.length >= 2) {
        last = `${parts[parts.length - 2]} ${last}`;
      }

      last = last
        .replace(/[-_]+/g, ' ')
        .replace(/\.[a-z0-9]+$/i, '')
        .trim();

      if (!last) last = u.hostname.replace(/^www\./i, '');
      last = last.replace(/\b([a-z])/g, s => s.toUpperCase());

      return last.length >= 3 ? last : null;
    } catch {
      return null;
    }
  }

  function changeTagName(ed, el, newTag) {
    try {
      if (!el || !newTag || !el.parentNode) return false;
      const doc = ed.getBody().ownerDocument;
      const repl = doc.createElement(newTag);
      [...el.attributes].forEach(attr => repl.setAttribute(attr.name, attr.value));
      while (el.firstChild) repl.appendChild(el.firstChild);
      el.parentNode.replaceChild(repl, el);
      flagDirty(ed);
      return repl;
    } catch {
      return false;
    }
  }

  function removeIfEmpty(ed, el) {
    if (!el) return false;
    const html = (el.innerHTML || '').trim();
    const text = (el.textContent || '').trim().replace(/\u00a0/g, '');
    const isEmptyish = !text && (
      html === '' ||
      html === '&nbsp;' ||
      html === '<br>' ||
      html === '<br />' ||
      /^<br\b[^>]*>(?:&nbsp;)?$/i.test(html)
    );
    if (!isEmptyish) return false;
    el.remove();
    flagDirty(ed);
    return true;
  }

  // Single promote: change ONLY the flagged heading up by one level to close the
// gap. Touches nothing downstream — predictable, never corrupts correct nesting.
// If this creates a new skip further down, the re-scan flags that one separately.
function fixSkippedHeadingSingle(ed, el) {
  if (!el || !/^H[1-6]$/.test(el.tagName)) return { ok: false, msg: 'No heading target' };
  const lvl = parseInt(el.tagName.slice(1), 10);
  if (lvl <= 1) return { ok: false, msg: 'Heading cannot be promoted further' };
  const repl = changeTagName(ed, el, 'h' + (lvl - 1));
  if (!repl) return { ok: false, msg: 'Could not change heading level' };
  return { ok: true, msg: `Promoted to h${lvl - 1}`, newEl: repl };
}

  // FIX 2: applyA11yFix now dispatches on issue.fix (set by runA11y) rather than
  // re-deriving fixability from category+msg string matching. Falls back to the
  // msg-based heuristic for issues where fix is null, for safety.
  function applyA11yFix(ed, issue) {
    if (!issue || !issue.el) return { ok: false, msg: 'No target' };
    const el = issue.el;
    const fix = issue.fix;

    if (fix === 'i-to-em') {
      const repl = changeTagName(ed, el, 'em');
      return repl ? { ok: true, msg: '<i> changed to <em>', newEl: repl } : { ok: false, msg: 'Could not change tag' };
    }

    if (fix === 'b-to-strong') {
      const repl = changeTagName(ed, el, 'strong');
      return repl ? { ok: true, msg: '<b> changed to <strong>', newEl: repl } : { ok: false, msg: 'Could not change tag' };
    }

    if (fix === 'remove-empty') {
      return removeIfEmpty(ed, el)
        ? { ok: true, msg: 'Empty paragraph removed' }
        : { ok: false, msg: 'Paragraph not empty anymore' };
    }

    if (fix === 'fix-skipped-heading') {
      return fixSkippedHeadingSingle(ed, el)
    }

    if (fix === 'fix-bare-url') {
      const suggestion = suggestLinkText(el);
      if (!suggestion) return { ok: false, msg: 'No good suggestion' };
      setText(ed, el, suggestion);
      flagDirty(ed);
      return { ok: true, msg: `Link text changed to "${suggestion}"` };
    }

    if (fix === 'add-empty-alt') {
      ed.dom.setAttrib(el, 'alt', '');
      flagDirty(ed);
      return { ok: true, msg: 'Added alt=""' };
    }

    // fix === null or unrecognised — no automatic fix available
    return { ok: false, msg: 'No automatic fix for this issue' };
  }

  function markA11yRowFixed(row, msg) {
    row.style.opacity = '0.45';
    row.style.pointerEvents = 'none';
    row.querySelectorAll('button').forEach(b => {
      b.disabled = true;
      if (b.textContent === 'Fix') b.textContent = 'Fixed';
    });

    const note = document.createElement('div');
    note.className = 'rcpi-old';
    note.style.marginTop = '4px';
    note.style.color = '#0a5';
    note.textContent = msg || 'Fixed';
    row.appendChild(note);
  }

  function refreshA11yFooter(ft, bd, ed, pane, issues, wordCount, readMins) {
    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warn').length;
    const infos = issues.filter(i => i.severity === 'info').length;

    ft.innerHTML = `
      <span class="rcpi-prog">${errors} errors, ${warnings} warnings, ${infos} info · ${wordCount} words · ${readMins} min read</span>
      <button class="rcpi-btn sec" data-exportcsv>CSV</button>
      <button class="rcpi-btn sec" data-exportmd>Markdown</button>
      <button class="rcpi-btn sec" data-export>HTML report</button>
      <button class="rcpi-btn sec" data-rerun>Re-scan</button>
      <button class="rcpi-btn sec" data-outline>Edit outline</button>
    `;

    ft.querySelector('[data-rerun]').addEventListener('click', () => {
      a11yCache = null;
      a11yCacheEdId = null;
      bd.innerHTML = '';
      ft.innerHTML = '';
      renderA11y(bd, ft, ed, pane);
    });

    ft.querySelector('[data-export]').addEventListener('click', () => {
      exportA11yReport(issues, wordCount, readMins);
    });

    ft.querySelector('[data-exportcsv]').addEventListener('click', () => {
      const rows = [['Severity','Category','Issue']];
      issues.forEach(i => rows.push([i.severity, i.category, i.msg]));
      downloadCsv(rows, 'a11y-report');
    });

     const outlineBtn = ft.querySelector('[data-outline]');
       if (outlineBtn) outlineBtn.addEventListener('click', () => {
         openOutlineEditor(ed, () => {
           a11yCache = null; a11yCacheEdId = null;
           bd.innerHTML = ''; ft.innerHTML = '';
           renderA11y(bd, ft, ed, pane);
         });
       });

    ft.querySelector('[data-exportmd]').addEventListener('click', () => {
      const pageTitle = document.title || location.href;
      const now = new Date().toLocaleString();
      const sevIcon = s => s === 'error' ? '⛔' : s === 'warn' ? '⚠️' : 'ℹ️';
      const cats = {};
      issues.sort((a,b) => (SEV_ORDER[a.severity]??9) - (SEV_ORDER[b.severity]??9))
        .forEach(i => { if (!cats[i.category]) cats[i.category] = []; cats[i.category].push(i); });
      let md = `# Accessibility Report\n\n`;
      md += `**Page:** ${pageTitle}  \n**URL:** ${location.href}  \n**Generated:** ${now}  \n`;
      md += `**Summary:** ${errors} errors · ${warnings} warnings · ${infos} info · ${wordCount} words · ${readMins} min read\n\n`;
      Object.entries(cats).forEach(([cat, items]) => {
        md += `## ${cat}\n\n`;
        items.forEach(i => { md += `- ${sevIcon(i.severity)} **${i.severity.toUpperCase()}** — ${i.msg}\n`; });
        md += '\n';
      });
      downloadMarkdown(md, 'a11y-report');
    });

    updateFabBadge();
  }

  // BEFORE-SAVE INTERCEPT
  function installSaveIntercept(getEd) {
    let interceptActive = true;

    document.addEventListener('click', function onSaveClick(e) {
      if (!interceptActive) return;
      if (!FEATURES.beforeSave.enabled) return;

      const path = e.composedPath();
      let isD2lSave = false;
      for (const el of path) {
        if (el.tagName && el.tagName.toLowerCase() === 'd2l-button') {
          const txt = el.textContent.trim().toLowerCase();
          if (txt === 'save' || txt === 'save and close') {
            isD2lSave = true;
            break;
          }
        }
      }
      if (!isD2lSave) return;

      const ed = getEd();
      if (!ed) return;

      const issues = runA11y(ed);
      const errors = issues.issues.filter(i => i.severity === 'error');
      const warnings = issues.issues.filter(i => i.severity === 'warn');

      if (!errors.length && !warnings.length) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      showSaveConfirm(errors, warnings, () => {
        interceptActive = false;
        setTimeout(() => {
          for (const el of path) {
            if (el.tagName && el.tagName.toLowerCase() === 'd2l-button') {
              const txt = el.textContent.trim().toLowerCase();
              if (txt === 'save' || txt === 'save and close') {
                el.click();
                break;
              }
            }
          }
          setTimeout(() => { interceptActive = true; }, 2000);
        }, 100);
      });
    }, true);
  }

  function showSaveConfirm(errors, warnings, onProceed) {
    const existing = document.getElementById('rcpi-save-confirm');
    if (existing) existing.remove();

    const dlg = document.createElement('div');
    dlg.id = 'rcpi-save-confirm';
    dlg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.3);z-index:2147483647;padding:20px 24px;min-width:340px;max-width:480px;font:13px/1.5 system-ui,Arial,sans-serif';

    const eHtml = errors.length
      ? `<div style="color:#c00;margin-bottom:6px"><b>${errors.length} error${errors.length===1?'':'s'}</b><ul style="margin:4px 0 0 16px">${errors.slice(0,5).map(i => `<li>${esc(i.msg.slice(0,80))}</li>`).join('')}${errors.length>5?`<li>and ${errors.length-5} more</li>`:''}</ul></div>`
      : '';

    const wHtml = warnings.length
      ? `<div style="color:#856404;margin-bottom:6px"><b>${warnings.length} warning${warnings.length===1?'':'s'}</b></div>`
      : '';

    dlg.innerHTML = `
      <div style="font-size:15px;font-weight:600;margin-bottom:10px">Accessibility issues found</div>
      ${eHtml}${wHtml}
      <div style="color:#555;font-size:12px;margin-bottom:14px">Review in the Edit Toolkit Accessibility tab.</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="rcpi-sc-cancel" style="padding:6px 14px;border:1px solid #bbb;background:#fff;border-radius:4px;cursor:pointer;font:inherit">Cancel</button>
        <button id="rcpi-sc-proceed" style="padding:6px 14px;border:1px solid #c00;background:#c00;color:#fff;border-radius:4px;cursor:pointer;font:inherit">Save anyway</button>
      </div>
    `;
    document.body.appendChild(dlg);

    dlg.querySelector('#rcpi-sc-cancel').addEventListener('click', () => dlg.remove());
    dlg.querySelector('#rcpi-sc-proceed').addEventListener('click', () => {
      dlg.remove();
      onProceed();
    });
  }

  const css = `
  .rcpi-pane{position:fixed;top:0;right:0;bottom:0;width:min(600px,50vw);background:#fff;z-index:2001;display:flex;flex-direction:column;box-shadow:-6px 0 32px rgba(0,0,0,.25);font:13px/1.4 system-ui,Arial,sans-serif;border-left:1px solid #d0d0d0}
  .rcpi-hd{padding:12px 16px;border-bottom:1px solid #e2e2e2;display:flex;align-items:center;justify-content:space-between;flex:0 0 auto}
  .rcpi-hd h2{margin:0;font-size:14px;font-weight:600}
  .rcpi-tabs{display:flex;gap:2px;padding:8px 16px 0;border-bottom:1px solid #e2e2e2;flex:0 0 auto}
  .rcpi-tab{padding:6px 11px;border:1px solid #e2e2e2;border-bottom:none;border-radius:6px 6px 0 0;background:#f5f5f5;cursor:pointer;font:inherit;font-size:12px}
  .rcpi-tab.active{background:#fff;font-weight:600;position:relative;top:1px}
    .rcpi-tab.running{background:#fff8e1;color:#8a5a00}
  .rcpi-tab.done{background:#eaf7ea;color:#0a5}
  .rcpi-tab.done::after{content:"●";margin-left:6px;font-size:10px;vertical-align:middle}
  .rcpi-tab.running::after{content:"…";margin-left:6px;font-size:12px;vertical-align:middle}
  .rcpi-tab.active.done,.rcpi-tab.active.running{font-weight:600}
  .rcpi-bd{padding:12px 16px;overflow-y:auto;flex:1}
  .rcpi-ft{padding:10px 16px;border-top:1px solid #e2e2e2;display:flex;gap:6px;justify-content:flex-end;align-items:center;flex:0 0 auto}
  .rcpi-row{border:1px solid #e2e2e2;border-radius:6px;padding:9px;margin-bottom:9px;transition:opacity .15s}
  .rcpi-row.skip{opacity:.4}
  .rcpi-jump {padding: 4px 0; border-radius: 4px;}
  .rcpi-jump:hover {background: #fff3cd;}
  .rcpi-jump:focus {outline: 2px solid #f90; outline-offset: 2px;}
  .rcpi-old{color:#777;font-size:11px;word-break:break-all;margin-bottom:5px}
  .rcpi-old.rcpi-jump {cursor: pointer;}
.rcpi-old.rcpi-jump:hover {background: #fff3cd; border-radius: 4px;}
  .rcpi-ctx{color:#555;font-size:11px;background:#f6f6f6;border-left:3px solid #ccc;padding:4px 7px;margin:0 0 6px;border-radius:0 3px 3px 0}
  .rcpi-ctx-fld input{background:#fcfcf5}
  .rcpi-cerr{color:#c00;font-size:11px;margin:-2px 0 6px 76px}
  .rcpi-fld{display:flex;gap:6px;align-items:center;margin:3px 0}
  .rcpi-fld label{width:68px;color:#444;flex:0 0 auto;font-size:12px}
  .rcpi-fld input{flex:1;padding:4px 6px;border:1px solid #bbb;border-radius:3px;font:inherit;font-size:12px}
  .rcpi-preview{margin:6px 0 4px;padding:5px 8px;background:#f0f7ff;border:1px solid #c5dff8;border-radius:4px;font-size:12px;color:#234;word-break:break-word}
  .rcpi-preview b{color:#0a5}
  .rcpi-preview i{color:#999}
  .rcpi-img-thumb{max-width:80px;max-height:48px;border:1px solid #ddd;border-radius:3px;vertical-align:middle;margin-right:6px}
  .rcpi-btn{padding:6px 12px;border:1px solid #0a5;background:#0a5;color:#fff;border-radius:4px;cursor:pointer;font:inherit;font-size:12px}
  .rcpi-btn.sec{background:#fff;color:#333;border-color:#bbb}
  .rcpi-btn.danger{background:#fff;color:#c00;border-color:#c99}
  .rcpi-btn:disabled{opacity:.5;cursor:default}
  .rcpi-skipbtn{font-size:11px;cursor:pointer;color:#c00;background:none;border:none;text-decoration:underline;padding:0}
  .rcpi-tag{display:inline-block;font-size:10px;background:#eef;color:#225;padding:1px 5px;border-radius:3px;margin-left:4px}
  .rcpi-tag.warn{background:#fee;color:#900}
  .rcpi-empty{padding:20px;text-align:center;color:#666}
  .rcpi-ta{width:100%;min-height:280px;font:12px/1.4 monospace;padding:7px;border:1px solid #bbb;border-radius:4px;box-sizing:border-box}
  .rcpi-fab{position:fixed !important;bottom:18px !important;right:18px !important;z-index:2000 !important}
  .rcpi-fab button{padding:9px 14px;border-radius:6px;border:2px solid #fff;background:#0a5;color:#fff;cursor:pointer;font:13px system-ui,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)}
  .rcpi-fab-badge{display:inline-block;background:#c00;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 5px;margin-left:5px;vertical-align:middle}
  .rcpi-a11y-tree{font-family:monospace;font-size:12px;line-height:1.6;background:#f8f8f8;border:1px solid #e0e0e0;border-radius:4px;padding:8px 10px;margin-bottom:10px}
  .rcpi-a11y-tree .h1{color:#c00;font-weight:700}
  .rcpi-a11y-tree .h2{color:#0a5;font-weight:600;margin-left:12px}
  .rcpi-a11y-tree .h3{color:#225;margin-left:24px}
  .rcpi-a11y-tree .h4{color:#555;margin-left:36px}
  .rcpi-a11y-tree .h5{color:#777;margin-left:48px}
  .rcpi-a11y-tree .h6{color:#999;margin-left:60px}
  .rcpi-a11y-cat{font-weight:700;font-size:12px;margin:10px 0 4px;padding:4px 8px;background:#f0f0f0;border-radius:3px}
  .rcpi-a11y-row{display:flex;gap:6px;align-items:flex-start;padding:5px 0;border-bottom:1px solid #f0f0f0}
  .rcpi-a11y-row:last-child{border-bottom:none}
  .rcpi-sev-error{flex:0 0 auto;color:#c00;font-weight:700;font-size:11px}
  .rcpi-sev-warn{flex:0 0 auto;color:#856404;font-weight:700;font-size:11px}
  .rcpi-sev-info{flex:0 0 auto;color:#555;font-size:11px}
  .rcpi-a11y-msg{flex:1;font-size:12px;color:#333}
  .rcpi-a11y-actions{flex:0 0 auto;display:flex;gap:4px}
  .rcpi-sec-title{font-weight:600;margin:12px 0 5px;font-size:12px}
  .rcpi-status{font-weight:600}
  .rcpi-status.broken{color:#c00}
  .rcpi-status.uncertain{color:#b80}
  .rcpi-prog{color:#555;margin-right:auto;font-size:12px}
  details.rcpi-unc summary{cursor:pointer;color:#b80;font-weight:600;margin:8px 0;font-size:12px}
  .rcpi-row-actions{display:flex;gap:5px;justify-content:flex-end;align-items:center;margin-top:5px}
  .rcpi-locate{display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 7px;border:1px solid #bbb;border-radius:3px;background:#f8f8f8;color:#444;cursor:pointer;white-space:nowrap}
  .rcpi-locate:hover{background:#fff3cd;border-color:#f90;color:#a60}
    .rcpi-locate-flash{outline:3px solid #f90 !important;outline-offset:2px !important;background:rgba(255,170,0,0.25) !important}
  .rcpi-dupe-badge{display:inline-block;font-size:10px;background:#fef;color:#808;padding:1px 5px;border-radius:3px;margin-left:4px}
  .rcpi-doi-hit{border:1px solid #e0e0e0;border-radius:4px;padding:7px 9px;margin:5px 0;background:#fafafa}
  .rcpi-doi-meta{display:flex;align-items:flex-start;gap:7px;margin-bottom:4px;flex-wrap:wrap}
  .rcpi-doi-band{flex:0 0 auto;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px}
  .doi-high{background:#d4edda;color:#155724}
  .doi-med{background:#fff3cd;color:#856404}
  .doi-low{background:#f8d7da;color:#721c24}
  .rcpi-doi-summary{font-size:11px;color:#444;flex:1}
  .rcpi-doi-url{font-size:11px;color:#0a5;word-break:break-all;margin-bottom:5px;font-family:monospace}
  .rcpi-doi-reftext{font-size:11px;color:#555;margin-bottom:6px;font-style:italic}
  .rcpi-doi-insert{padding:3px 10px;font-size:11px}
  .rcpi-doi-hits{margin:4px 0 2px}
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  const escA = s => String(s).replace(/"/g, '&quot;');

  // CSV / Markdown export helper
  function downloadCsv(rows, basename) {
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${basename}-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadMarkdown(text, basename) {
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${basename}-${Date.now()}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Per-session undo stack (find/replace operations)
  const undoStack = [];
  function pushUndo(ed, snapshotHtml, description) {
    undoStack.push({ edKey: getEditorKey(ed), html: snapshotHtml, description });
    if (undoStack.length > 20) undoStack.shift();
  }
  function popUndo(ed) {
    const edKey = getEditorKey(ed);
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].edKey === edKey) {
        const entry = undoStack.splice(i, 1)[0];
        return entry;
      }
    }
    return null;
  }

  function buildPreview(hInput, tInput, cInput, ctxMarked, row) {
    const update = () => {
      let prev = row.querySelector('.rcpi-preview');
      if (!prev) {
        prev = document.createElement('div');
        prev.className = 'rcpi-preview';
        row.querySelector('.rcpi-row-actions').before(prev);
      }
      const href = hInput ? hInput.value : '';
      const text = tInput ? tInput.value : '';
      if (cInput && ctxMarked) {
        const parts = cInput.value.split(LINKMARK);
        if (parts.length === 2) {
          prev.innerHTML = `${esc(parts[0])} <b><a style="color:#0a5">${esc(text)}</a></b> ${esc(parts[1])}`;
          return;
        }
      }
      prev.innerHTML = `<b><a style="color:#0a5">${esc(text)}</a></b> <i style="color:#aaa">${esc(href)}</i>`;
    };
    [hInput, tInput, cInput].forEach(inp => inp && inp.addEventListener('input', update));
    update();
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:70px;right:18px;z-index:2147483647;background:#222;color:#fff;padding:9px 13px;border-radius:5px;font:13px system-ui;box-shadow:0 3px 12px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }

  function applyRow(ed, a, s) {
    let changed = false, errored = false;

    if (s.cInput && s.ctxEditable && s.cInput.value !== s.ctxMarked) {
      const res = applyContainer(ed, a, s.cInput.value);
      if (!res.ok) {
        if (s.cErr) {
          s.cErr.style.display = 'block';
          s.cErr.textContent = res.error;
        }
        errored = true;
      } else if (s.cErr) {
        s.cErr.style.display = 'none';
        changed = true;
      }
    }

    if (s.tInput && s.tInput.value !== a.textContent) {
      setText(ed, a, s.tInput.value);
      changed = true;
    }

    if (s.hInput && s.hInput.value !== a.getAttribute('href')) {
      setHref(ed, a, s.hInput.value);
      changed = true;
    }

    return { changed, errored };
  }

  function buildEditableRows(bd, items, ed) {
  const states = [];
  const hrefCount = {};

  items.forEach(m => {
    const h = m.oldHref;
    hrefCount[h] = (hrefCount[h] || 0) + 1;
  });

  items.forEach(m => {
    const a = m.a;
    const oldText = m.oldText != null ? m.oldText : a.textContent;
    const newText = m.newText != null ? m.newText : oldText;
    const ctx = containerInfo(a);
    const isDupe = (hrefCount[m.oldHref] || 0) > 1;

    const row = document.createElement('div');
    row.className = 'rcpi-row';

    const tags = m.reasons && m.reasons.length
      ? m.reasons.map(r => `<span class="rcpi-tag warn">${esc(r)}</span>`).join('')
      : (m.tagText ? `<span class="rcpi-tag">${esc(m.tagText)}</span>` : '');

    const dupeBadge = isDupe
      ? `<span class="rcpi-dupe-badge">duplicate href</span>`
      : '';

    let ctxHtml = '';
    if (ctx.tag && ctx.editable) {
      ctxHtml = `
        <div class="rcpi-fld rcpi-ctx-fld">
          <label>In &lt;${esc(ctx.tag)}&gt;</label>
          <input data-c value="${escA(ctx.marked)}">
        </div>
        <div class="rcpi-cerr" data-cerr style="display:none"></div>
      `;
    } else if (ctx.tag) {
      ctxHtml = `<div class="rcpi-ctx"><b>in &lt;${esc(ctx.tag)}&gt;</b> ${esc(ctx.text || '(empty)')}</div>`;
    }

    row.innerHTML = `
      <div class="rcpi-old rcpi-jump" title="Click to locate in editor" tabindex="0" role="button">
        <b>href</b> ${esc(m.oldHref)} ${tags}${dupeBadge}<br>
        <b>text</b> ${esc(oldText || '(empty)')}
      </div>

      <div class="rcpi-fld">
        <label>New text</label>
        <input data-t value="${escA(newText)}">
      </div>

      <div class="rcpi-fld">
        <label>New href</label>
        <input data-h value="${escA(m.newHref)}">
      </div>

      ${ctxHtml}

      <div class="rcpi-row-actions">
        <button class="rcpi-skipbtn" data-skip>skip</button>
      </div>
    `;

    bd.appendChild(row);

    const st = {
      item: m,
      row,
      skip: false,
      hInput: row.querySelector('[data-h]'),
      tInput: row.querySelector('[data-t]'),
      cInput: row.querySelector('[data-c]'),
      cErr: row.querySelector('[data-cerr]'),
      ctxMarked: ctx.marked,
      ctxEditable: ctx.editable
    };

    buildPreview(st.hInput, st.tInput, st.cInput, ctx.marked, row);

    const jump = row.querySelector('.rcpi-jump');
    if (jump) {
      jump.style.cursor = 'pointer';
      jump.addEventListener('click', () => locateInEditor(ed, a));
      jump.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          locateInEditor(ed, a);
        }
      });
    }

    row.querySelectorAll('input, textarea, button').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation());
      el.addEventListener('keydown', e => e.stopPropagation());
    });

    row.querySelector('[data-skip]').addEventListener('click', () => {
      st.skip = !st.skip;
      row.classList.toggle('skip', st.skip);
      row.querySelector('[data-skip]').textContent = st.skip ? 'include' : 'skip';
    });

    states.push(st);
  });

  return states;
}
  let panelEl = null;

// REPLACE TAB
function renderReplace(bd, ft, ed, pane) {
  const matches = collectReplaceMatches(ed);
  const hasUndo = undoStack.some(u => u.edKey === getEditorKey(ed));

  if (!matches.length) {
    bd.innerHTML = `<div class="rcpi-empty">No links matched your current rules.</div>`;
    ft.innerHTML = `
      <span class="rcpi-prog">Nothing to replace</span>
      <button class="rcpi-btn sec" data-rules>Edit rules</button>
      ${hasUndo ? '<button class="rcpi-btn danger" data-undo>Undo last apply</button>' : ''}
      <button class="rcpi-btn" data-apply disabled>Apply</button>
    `;
    paintTabStatuses(pane.querySelectorAll('.rcpi-tab'), ed);
    ft.querySelector('[data-rules]').addEventListener('click', showRules);
    if (hasUndo) ft.querySelector('[data-undo]').addEventListener('click', () => doUndo(ed, bd, ft, pane));
    return;
  }

  const states = buildEditableRows(
    bd,
    matches.map(m => ({ ...m, tagText: `${m.rule.field}/${m.rule.match}` })),
    ed
  );

  ft.innerHTML = `
    <span class="rcpi-prog">${matches.length} match${matches.length===1?'':'es'} — review above before applying</span>
    <button class="rcpi-btn sec" data-rules>Edit rules</button>
    ${hasUndo ? '<button class="rcpi-btn danger" data-undo>Undo</button>' : ''}
    <button class="rcpi-btn sec" data-preview>Preview CSV</button>
    <button class="rcpi-btn" data-apply ${matches.length?'':'disabled'}>Apply</button>
  `;

  paintTabStatuses(pane.querySelectorAll('.rcpi-tab'), ed);
  ft.querySelector('[data-rules]').addEventListener('click', showRules);
  if (hasUndo) ft.querySelector('[data-undo]').addEventListener('click', () => doUndo(ed, bd, ft, pane));

  ft.querySelector('[data-preview]').addEventListener('click', () => {
    const rows = [['Old href','New href','Old text','New text','Rule','Skip']];
    states.forEach(s => {
      rows.push([
        s.item.oldHref,
        s.hInput ? s.hInput.value : s.item.newHref,
        s.item.oldText,
        s.tInput ? s.tInput.value : s.item.newText,
        s.item.rule ? `${s.item.rule.field}/${s.item.rule.match}` : '',
        s.skip ? 'yes' : 'no'
      ]);
    });
    downloadCsv(rows, 'replace-preview');
  });

  const ab = ft.querySelector('[data-apply]');
  if (ab) ab.addEventListener('click', () => {
    const snapshot = ed.getBody().innerHTML;
    let n = 0, errors = 0;
    states.forEach(s => {
      if (s.skip) return;
      const r = applyRow(ed, s.item.a, s);
      if (r.errored) errors++;
      if (r.changed) n++;
    });
    if (n) {
      pushUndo(ed, snapshot, `Replace: ${n} change${n===1?'':'s'}`);
      flagDirty(ed);
    }
    paintTabStatuses(pane.querySelectorAll('.rcpi-tab'), ed);
    if (errors) {
      toast(`Applied ${n}, but ${errors} row${errors===1?'':'s'} had marker errors.`);
      return;
    }
    pane.remove(); panelEl = null;
    toast(`Applied ${n} change${n===1?'':'s'}. Now click D2L's Save.`);
  });
}

function doUndo(ed, bd, ft, pane) {
  const entry = popUndo(ed);
  if (!entry) { toast('Nothing to undo.'); return; }
  try {
    ed.getBody().innerHTML = entry.html;
    flagDirty(ed);
    probeCache = null; probeCacheEdId = null;
    a11yCache = null; a11yCacheEdId = null;
    toast(`Undone: ${entry.description}`);
    bd.innerHTML = ''; ft.innerHTML = '';
    renderReplace(bd, ft, ed, pane);
  } catch (e) {
    toast('Undo failed: ' + e.message);
  }
}


// LINT TAB
function renderLint(bd, ft, ed, pane) {
  const matches = collectLintMatches(ed);

  if (!matches.length) {
    bd.innerHTML = `<div class="rcpi-empty">No malformed URLs detected.</div>`;
    ft.innerHTML = `
      <span class="rcpi-prog">No fixes needed</span>
      <button class="rcpi-btn" data-apply disabled>Apply fixes</button>
    `;
    paintTabStatuses(pane.querySelectorAll('.rcpi-tab'), ed);
    return;
  }

  const states = buildEditableRows(bd, matches, ed);

  ft.innerHTML = `
    <span class="rcpi-prog">${matches.length} to fix</span>
    <button class="rcpi-btn" data-apply ${matches.length?'':'disabled'}>Apply fixes</button>
  `;

  paintTabStatuses(pane.querySelectorAll('.rcpi-tab'), ed);

  const ab = ft.querySelector('[data-apply]');
  if (ab) ab.addEventListener('click', () => {
    let n = 0, errors = 0;
    states.forEach(s => {
      if (s.skip) return;
      const r = applyRow(ed, s.item.a, s);
      if (r.errored) errors++;
      if (r.changed) n++;
    });
    if (n) flagDirty(ed);
    paintTabStatuses(pane.querySelectorAll('.rcpi-tab'), ed);
    if (errors) {
      toast(`Fixed ${n}, but ${errors} marker error${errors===1?'':'s'}.`);
      return;
    }
    pane.remove(); panelEl = null;
    toast(`Fixed ${n} link${n===1?'':'s'}. Now click D2L's Save.`);
  });
}

  // PROBE TAB
    function isActiveTab(name, pane) {
  const active = pane.querySelector('.rcpi-tab.active');
  return !!active && active.dataset.t === name;
}

  function renderProbe(bd, ft, ed, pane) {
    const edId = getEditorKey(ed);

    if (probeCache && probeCacheEdId === edId) {
      renderProbeResults(probeCache, bd, ft, ed, pane);
      return;
    }

    if (probeRunning && probeCacheEdId === edId) {
      bd.innerHTML = `<div class="rcpi-empty">Checking links and images…</div>`;
      ft.innerHTML = `<span class="rcpi-prog" data-prog>In progress…</span><button class="rcpi-btn sec" data-cls>Close panel</button>`;
      ft.querySelector('[data-cls]').addEventListener('click', () => { pane.remove(); panelEl = null; });

     probeRunPromise.then(results => {
  if (!panelEl || !pane.isConnected) return;
  if (!isActiveTab('probe', pane)) return;
  renderProbeResults(results, bd, ft, ed, pane);
});

      return;
    }

    bd.innerHTML = `<div class="rcpi-empty">Checking links and images…</div>`;
    ft.innerHTML = `<span class="rcpi-prog" data-prog>Starting…</span><button class="rcpi-btn sec" data-cls>Close panel</button>`;
    ft.querySelector('[data-cls]').addEventListener('click', () => { pane.remove(); panelEl = null; });

    const prog = ft.querySelector('[data-prog]');
   startProbeBackground(ed, (i, total) => prog.textContent = `Probed ${i}/${total}`)
  .then(results => {
    if (!panelEl || !pane.isConnected) return;
    if (!isActiveTab('probe', pane)) return;
    renderProbeResults(results, bd, ft, ed, pane);
  });
  }
 function renderProbeResults(results, bd, ft, ed, pane) {
  const broken    = results.filter(r => r.klass === 'broken');
  const redirects = results.filter(r => r.klass === 'redirect');
  const mixed     = results.filter(r => r.klass === 'warn' && r.isMixed);
  // FIX 3: surface oversized images as a separate group in the results UI
  const oversized = results.filter(r => r.klass === 'warn' && !r.isMixed);
  const uncertain = results.filter(r => r.klass === 'uncertain');
  const ignored   = results.filter(r => r.klass === 'ignored');

  bd.innerHTML = '';
  broken.sort((a, b) => a.url.localeCompare(b.url));

  const bt = document.createElement('div');
  bt.className = 'rcpi-sec-title';
  bt.innerHTML = `Broken ${broken.length}`;
  bd.appendChild(bt);

  if (!broken.length) {
    const e = document.createElement('div');
    e.className = 'rcpi-empty';
    e.textContent = 'None.';
    bd.appendChild(e);
  }

  const states = [];
  broken.forEach(r => {
    const isImg = r.imgs && r.imgs.length > 0 && (!r.anchors || !r.anchors.length);
    const allEls = [...(r.anchors || []), ...(r.imgs || [])];
    const row = document.createElement('div');
    row.className = 'rcpi-row';
    const statusTxt = r.reason || (r.errored ? 'unreachable' : String(r.status));

    const anchorMeta = [];
    const elBlocks = allEls.map((el, i) => {
      const isImgEl = el.tagName === 'IMG';
      const thumbHtml = isImgEl ? `<img class="rcpi-img-thumb" data-thumb src="${escA(r.url)}" alt="">` : '';
      const curText = isImgEl ? (el.getAttribute('alt') || '') : el.textContent;
      const label = isImgEl ? 'Alt text' : 'Link text';

      let ctx = { tag: '', editable: false, marked: '', text: '' };
      let ctxHtml = '';

      if (!isImgEl) {
        ctx = containerInfo(el);
        anchorMeta.push({ ctxMarked: ctx.marked, ctxEditable: ctx.editable });

        if (ctx.tag && ctx.editable) {
          ctxHtml = `
            <div class="rcpi-fld rcpi-ctx-fld">
              <label>In &lt;${esc(ctx.tag)}&gt;${allEls.length > 1 ? ' ' + (i + 1) : ''}</label>
              <input data-c${i} value="${escA(ctx.marked)}">
            </div>
            <div class="rcpi-cerr" data-cerr${i} style="display:none"></div>
          `;
        } else if (ctx.tag) {
          ctxHtml = `<div class="rcpi-ctx"><b>in &lt;${esc(ctx.tag)}&gt;</b> ${esc(ctx.text || '(empty)')}</div>`;
        }
      } else {
        anchorMeta.push({ ctxMarked: '', ctxEditable: false });
      }

      return `
        <div class="rcpi-jump" data-jump${i} title="Click to locate in editor" tabindex="0" role="button">
          ${thumbHtml}
          <div class="rcpi-fld">
            <label>${label}${allEls.length > 1 ? ' ' + (i + 1) : ''}</label>
            <input data-t${i} value="${escA(curText)}">
          </div>
          ${ctxHtml}
        </div>
      `;
    }).join('');

    const typeLabel = isImg ? 'Image' : `${r.anchors.length} link${r.anchors.length === 1 ? '' : 's'}`;

    row.innerHTML = `
      <div class="rcpi-old">
        <span class="rcpi-status broken">${esc(statusTxt)}</span> ${typeLabel}<br>
        <b>src/href</b> ${esc(r.url)}
      </div>
      <div class="rcpi-fld">
        <label>New URL</label>
        <input data-h value="${escA(r.url)}">
      </div>
      ${elBlocks}
      <div class="rcpi-row-actions">
        <button class="rcpi-skipbtn" data-skip>skip</button>
      </div>
    `;
    bd.appendChild(row);

    allEls.forEach((el, i) => {
      const jump = row.querySelector(`[data-jump${i}]`);
      if (jump) {
        jump.style.cursor = 'pointer';
        jump.addEventListener('click', (e) => {
          if (e.target.closest('input, textarea, button, label')) return;
          locateInEditor(ed, el);
        });
        jump.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            locateInEditor(ed, el);
          }
        });
      }
    });

    row.querySelectorAll('input, textarea, button').forEach(el => {
      el.addEventListener('click', e => e.stopPropagation());
      el.addEventListener('keydown', e => e.stopPropagation());
    });

    row.querySelectorAll('img.rcpi-img-thumb[data-thumb]').forEach(thumb => {
      const hide = () => { thumb.style.display = 'none'; };
      thumb.addEventListener('error', hide);
      // image may have already failed before this listener attached
      if (thumb.complete && thumb.naturalWidth === 0) hide();
    });

    const hInp = row.querySelector('[data-h]');
    const t0 = row.querySelector('[data-t0]') || row.querySelector('[data-t]');
    buildPreview(hInp, t0, null, null, row);

    const st = {
      r, row, skip: false, anchorMeta, allEls, hInput: hInp,
      tInputs: allEls.map((_, i) => row.querySelector(`[data-t${i}]`)),
      cInputs: allEls.map((_, i) => row.querySelector(`[data-c${i}]`)),
      cErrs: allEls.map((_, i) => row.querySelector(`[data-cerr${i}]`))
    };

    row.querySelector('[data-skip]').addEventListener('click', () => {
      st.skip = !st.skip;
      row.classList.toggle('skip', st.skip);
      row.querySelector('[data-skip]').textContent = st.skip ? 'include' : 'skip';
    });

    states.push(st);
  });

  if (oversized.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary style="color:#b83400">Oversized images: ${oversized.length}</summary>`;
    oversized.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '5px 0';
      d.innerHTML = `<span style="color:#b83400">⚠</span> <b>${esc(r.url)}</b><br><small style="margin-left:12px">${esc(r.reason)}</small>`;
      det.appendChild(d);
    });
    bd.appendChild(det);
  }

  if (uncertain.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary>Couldn't verify (403/405/429/5xx): ${uncertain.length}</summary>`;
    uncertain.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '5px 0';
      d.innerHTML = `<span class="rcpi-status uncertain">${r.status || '?'}</span> ${esc(r.url)}`;
      det.appendChild(d);
    });
    bd.appendChild(det);
  }

  if (redirects.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary style="color:#6a5a00">Redirects (update these links): ${redirects.length}</summary>`;
    redirects.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '5px 0';
      d.innerHTML = `<span style="color:#856404">→</span> <b>${esc(r.url)}</b><br><small style="margin-left:12px">→ ${esc(r.reason)}</small>`;
      det.appendChild(d);
    });
    bd.appendChild(det);
  }

  if (mixed.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary style="color:#b83400">Mixed content (http on https page): ${mixed.length}</summary>`;
    mixed.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '5px 0';
      d.textContent = r.url;
      det.appendChild(d);
    });
    bd.appendChild(det);
  }

  if (ignored.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary style="color:#aaa">Skipped (ignored domains): ${ignored.length}</summary>`;
    ignored.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '5px 0';
      d.textContent = r.url;
      det.appendChild(d);
    });
    bd.appendChild(det);
  }

  ft.innerHTML = `
    <span class="rcpi-prog">${broken.length} broken, ${redirects.length} redirect, ${mixed.length} mixed, ${oversized.length} oversized, ${uncertain.length} uncertain, ${results.length} checked</span>
    <button class="rcpi-btn sec" data-exportcsv>CSV</button>
    <button class="rcpi-btn sec" data-recheck>Re-check</button>
    <button class="rcpi-btn" data-apply ${broken.length ? '' : 'disabled'}>Apply &amp; re-check</button>
  `;

  ft.querySelector('[data-recheck]').addEventListener('click', () => {
    resetProbeState();
    bd.innerHTML = '';
    ft.innerHTML = '';
    renderProbe(bd, ft, ed, pane);
  });

  ft.querySelector('[data-exportcsv]').addEventListener('click', () => {
    const rows = [['Status','Type','URL','Reason']];
    results.forEach(r => {
      const type = (r.imgs && r.imgs.length) ? 'image' : 'link';
      rows.push([r.klass, type, r.url, r.reason || '']);
    });
    downloadCsv(rows, 'link-check');
  });

  const ab = ft.querySelector('[data-apply]');
  if (ab) ab.addEventListener('click', () => {
    let n = 0, errors = 0;

    states.forEach(s => {
      if (s.skip) return;
      let changed = false;
      const newUrl = s.hInput.value;

      s.allEls.forEach((el, i) => {
        const meta = s.anchorMeta[i];
        const isImgEl = el.tagName === 'IMG';
        const ci = s.cInputs[i];

        if (!isImgEl && ci && meta && meta.ctxEditable && ci.value !== meta.ctxMarked) {
          const res = applyContainer(ed, el, ci.value);
          if (!res.ok) {
            const ce = s.cErrs[i];
            if (ce) {
              ce.style.display = 'block';
              ce.textContent = res.error;
            }
            errors++;
          } else {
            const ce = s.cErrs[i];
            if (ce) ce.style.display = 'none';
            changed = true;
          }
        }

        const ti = s.tInputs[i];
        if (isImgEl) {
          if (ti && ti.value !== el.getAttribute('alt')) {
            ed.dom.setAttrib(el, 'alt', ti.value);
            changed = true;
          }
        } else if (ti && ti.value !== el.textContent) {
          setText(ed, el, ti.value);
          changed = true;
        }

        if (newUrl !== el.getAttribute(isImgEl ? 'src' : 'href')) {
          ed.dom.setAttrib(el, isImgEl ? 'src' : 'href', newUrl);
          changed = true;
        }
      });

      if (changed) n++;
    });

    if (n) {
      flagDirty(ed);
      resetProbeState();
    }
    if (errors) toast(`Updated ${n}, but ${errors} marker error${errors === 1 ? '' : 's'}.`);
    bd.innerHTML = '';
    ft.innerHTML = '';
    renderProbe(bd, ft, ed, pane);
  });
}
 // DOI REFERENCE CHECKER

let doiCache = null;
let doiCacheEdId = null;
let doiRunning = false;
let doiRunPromise = null;

const DOI_MIN_LEN = 80;
const DOI_YEAR_RE = /\b(19|20)\d{2}\b/;
const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
const CROSSREF_BASE = 'https://api.crossref.org/works';
const DOI_BAND_HIGH = 80;
const DOI_BAND_MED = 40;

// Combined DOI+PMID cache
let pmidCache = null;
let pmidCacheEdId = null;

function startDoiBackground(ed) {
  const edId = getEditorKey(ed);

  if (doiRunning && doiCacheEdId === edId && doiRunPromise) return doiRunPromise;
  if (doiCache && doiCacheEdId === edId) return Promise.resolve(doiCache);

  doiRunning = true;
  doiCacheEdId = edId;

  doiRunPromise = runDoiCheck(ed).then(results => {
    doiCache = results;
    doiRunning = false;
    // Also kick off PMID lookup in background (non-blocking)
    if (FEATURES.pmidLookup && FEATURES.pmidLookup.enabled && pmidCacheEdId !== edId) {
      pmidCacheEdId = edId;
      runPmidCheck(ed).then(pmids => { pmidCache = pmids; pmidCacheEdId = edId; }).catch(() => {});
    }
    return results;
  }).catch(err => {
    doiRunning = false;
    doiRunPromise = null;
    throw err;
  });

  return doiRunPromise;
}

function isReferenceEl(el) {
  const tag = el.tagName;
  if (tag !== 'P' && tag !== 'LI') return false;

  const text = (el.textContent || '').trim();
  return text.length >= DOI_MIN_LEN && DOI_YEAR_RE.test(text);
}

function collectReferenceEls(ed) {
  const body = ed.getBody();
  return [...body.querySelectorAll('p, li')].filter(isReferenceEl);
}

function refQueryText(el) {
  const clone = el.cloneNode(true);

  clone.querySelectorAll('a').forEach(a => {
    const t = (a.textContent || '').trim();
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(t) || /^https?:/i.test(href) || DOI_RE.test(t) || DOI_RE.test(href)) {
      a.remove();
    }
  });

  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function hasDoi(el) {
  const links = el.querySelectorAll('a[href]');
  return [...links].some(a => {
    const href = a.getAttribute('href') || '';
    const txt = (a.textContent || '').trim();
    return DOI_RE.test(href) || DOI_RE.test(txt) || /doi\.org\//i.test(href);
  });
}

// PMID detection and lookup via NCBI E-utilities
const PMID_RE = /\bPMID[:\s]*(\d{5,9})\b/gi;
const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function collectPmids(el) {
  const text = el.textContent || '';
  const pmids = [];
  let m;
  PMID_RE.lastIndex = 0;
  while ((m = PMID_RE.exec(text)) !== null) {
    pmids.push(m[1]);
  }
  return [...new Set(pmids)];
}

function hasPmidLink(el) {
  return [...el.querySelectorAll('a[href]')].some(a => {
    const href = a.getAttribute('href') || '';
    return /pubmed\.ncbi\.nlm\.nih\.gov\/\d+/i.test(href) ||
           /ncbi\.nlm\.nih\.gov\/pubmed\/\d+/i.test(href);
  });
}

function ncbiSummary(pmid) {
  return new Promise(resolve => {
    const url = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json&tool=rcpi-toolkit&email=admin@rcpi.ie`;
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 10000,
        headers: { 'Accept': 'application/json' },
        onload: r => {
          try {
            const data = JSON.parse(r.responseText);
            const result = data && data.result && data.result[pmid];
            if (!result) { finish(null); return; }
            const authors = (result.authors || []).slice(0, 3)
              .map(a => a.name).join(', ') + (result.authors && result.authors.length > 3 ? ' et al.' : '');
            const year = result.pubdate ? result.pubdate.slice(0, 4) : '';
            const title = result.title || '';
            const journal = result.fulljournalname || result.source || '';
            const doi = (result.articleids || []).find(a => a.idtype === 'doi');
            finish({
              pmid,
              summary: [authors, year, title, journal].filter(Boolean).join('. ').slice(0, 160),
              doiFromNcbi: doi ? doi.value : null,
              url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
            });
          } catch { finish(null); }
        },
        onerror: () => finish(null),
        ontimeout: () => finish(null)
      });
    } catch { finish(null); }
  });
}

function insertPmidLink(ed, el, pmid, url) {
  // Replace the bare PMID text node with linked version
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const toReplace = [];
  let node;
  while ((node = walk.nextNode())) {
    if (/PMID[:\s]*\d{5,9}/i.test(node.nodeValue)) toReplace.push(node);
  }
  toReplace.forEach(tn => {
    const frag = tn.ownerDocument.createDocumentFragment();
    const parts = tn.nodeValue.split(new RegExp(`(PMID[:\\s]*${pmid})`, 'i'));
    parts.forEach((part, idx) => {
      if (idx % 2 === 1) {
        const a = tn.ownerDocument.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = part;
        frag.appendChild(a);
      } else if (part) {
        frag.appendChild(tn.ownerDocument.createTextNode(part));
      }
    });
    tn.parentNode.replaceChild(frag, tn);
  });
  flagDirty(ed);
}

async function runPmidCheck(ed) {
  if (!FEATURES.pmidLookup || !FEATURES.pmidLookup.enabled) return [];
  const els = collectReferenceEls(ed);
  const results = [];
  for (const el of els) {
    const pmids = collectPmids(el);
    if (!pmids.length) continue;
    const alreadyLinked = hasPmidLink(el);
    if (alreadyLinked) {
      results.push({ el, pmids, items: [], alreadyLinked: true });
      continue;
    }
    const items = [];
    for (const pmid of pmids.slice(0, 3)) { // max 3 per paragraph
      const info = await ncbiSummary(pmid);
      if (info) items.push(info);
      await new Promise(r => setTimeout(r, 200));
    }
    results.push({ el, pmids, items, alreadyLinked: false });
  }
  return results;
}

function crossrefQuery(text) {
  return new Promise(resolve => {
    const url = `${CROSSREF_BASE}?rows=3&mailto=admin@rcpi.ie&query.bibliographic=${encodeURIComponent(text)}`;
    let done = false;

    const finish = v => {
      if (done) return;
      done = true;
      resolve(v);
    };

    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 12000,
        headers: {
          'User-Agent': 'RCPI-LinkToolkit/3.1 (brightspace.rcpi.ie; mailto:admin@rcpi.ie)',
          'Accept': 'application/json'
        },
        onload: r => {
          try {
            if (r.status < 200 || r.status >= 300) {
              finish(null);
              return;
            }
            const data = JSON.parse(r.responseText);
            const items = data && data.message && Array.isArray(data.message.items)
              ? data.message.items
              : [];
            finish(items);
          } catch (e) {
            finish([]);
          }
        },
        onerror: () => finish(null),
        ontimeout: () => finish(null)
      });
    } catch (e) {
      finish(null);
    }
  });
}

function fmtCrossref(item) {
  const authorsArr = Array.isArray(item.author) ? item.author : [];
  const authors = authorsArr
    .slice(0, 3)
    .map(a => [a.family, a.given ? `${a.given[0]}.` : ''].filter(Boolean).join(', '))
    .join(', ') + (authorsArr.length > 3 ? ' et al.' : '');

  const year =
    item.published &&
    item.published['date-parts'] &&
    item.published['date-parts'][0] &&
    item.published['date-parts'][0][0];

  const title = item.title && item.title[0];
  const journal = (item['container-title'] && item['container-title'][0]) || item.publisher;

  return [authors, year, title, journal].filter(Boolean).join('. ').slice(0, 160);
}

function scoreBand(score) {
  if (score >= DOI_BAND_HIGH) return { label: 'High confidence', cls: 'doi-high' };
  if (score >= DOI_BAND_MED) return { label: 'Moderate', cls: 'doi-med' };
  return { label: 'Low confidence', cls: 'doi-low' };
}

function insertDoiLink(ed, el, doi) {
  const doc = ed.getBody().ownerDocument;
  const space = doc.createTextNode(' ');
  const a = doc.createElement('a');

  a.setAttribute('href', `https://doi.org/${doi}`);
  a.setAttribute('target', '_blank');
  a.setAttribute('rel', 'noopener');
  a.textContent = doi;

  el.appendChild(space);
  el.appendChild(a);
  flagDirty(ed);
}

async function runDoiCheck(ed, onProgress) {
  const els = collectReferenceEls(ed);
  const results = [];

  let i = 0;
  for (const el of els) {
    i++;
    if (onProgress) onProgress(i, els.length);

    const alreadyHas = hasDoi(el);
    const queryText = refQueryText(el);

    if (!queryText) {
      results.push({ el, queryText: '', items: [], alreadyHas, errored: false, mismatch: null });
      continue;
    }

    if (alreadyHas) {
      results.push({ el, queryText, items: [], alreadyHas, errored: false, mismatch: null });
      continue;
    }

    const items = await crossrefQuery(queryText);

    // DOI↔text cross-check: if top result title is very different from reference text, flag it
    let mismatch = null;
    if (items && items.length > 0) {
      const topTitle = (items[0].title && items[0].title[0]) ? items[0].title[0].toLowerCase() : '';
      const refLow = queryText.toLowerCase();
      // Tokenise both and check overlap
      const topWords = new Set(topTitle.split(/\W+/).filter(w => w.length > 4));
      const refWords = new Set(refLow.split(/\W+/).filter(w => w.length > 4));
      const overlap = [...topWords].filter(w => refWords.has(w)).length;
      const minWords = Math.min(topWords.size, refWords.size);
      const score = minWords > 0 ? overlap / minWords : 1;
      if (score < 0.25 && topWords.size > 3 && refWords.size > 3) {
        mismatch = `Top Crossref result title looks different from this reference — verify it's the right paper.`;
      }
    }

    results.push({
      el,
      queryText,
      items: items || [],
      alreadyHas,
      errored: items === null,
      mismatch
    });

    await new Promise(r => setTimeout(r, 150));
  }

  return results;
}

function renderDoi(bd, ft, ed, pane) {
  const edId = getEditorKey(ed);

  if (doiCache && doiCacheEdId === edId) {
    renderDoiResults(doiCache, bd, ft, ed, pane);
    return;
  }

  if (doiRunning && doiCacheEdId === edId && doiRunPromise) {
    bd.innerHTML = `<div class="rcpi-empty">DOI lookup is running in the background…</div>`;
    ft.innerHTML = `
      <span class="rcpi-prog">Scanning references and querying Crossref…</span>
      <button class="rcpi-btn sec" data-cls>Close panel</button>
    `;

    ft.querySelector('[data-cls]').addEventListener('click', () => {
      pane.remove();
      panelEl = null;
    });

    doiRunPromise.then(results => {
      if (!panelEl || !pane.isConnected) return;
      if (!isActiveTab('doi', pane)) return;
      bd.innerHTML = '';
      ft.innerHTML = '';
      renderDoiResults(results, bd, ft, ed, pane);
    }).catch(() => {
      if (!panelEl || !pane.isConnected) return;
      if (!isActiveTab('doi', pane)) return;
      bd.innerHTML = `<div class="rcpi-empty">DOI lookup failed.</div>`;
      ft.innerHTML = '';
    });

    return;
  }

  bd.innerHTML = `<div class="rcpi-empty">DOI lookup is starting in the background…</div>`;
  ft.innerHTML = `
    <span class="rcpi-prog">Scanning references and querying Crossref…</span>
    <button class="rcpi-btn sec" data-cls>Close panel</button>
  `;

  ft.querySelector('[data-cls]').addEventListener('click', () => {
    pane.remove();
    panelEl = null;
  });

  startDoiBackground(ed).then(results => {
    if (!panelEl || !pane.isConnected) return;
    if (!isActiveTab('doi', pane)) return;
    bd.innerHTML = '';
    ft.innerHTML = '';
    renderDoiResults(results, bd, ft, ed, pane);
  }).catch(err => {
    console.error('DOI lookup failed:', err);
    if (!panelEl || !pane.isConnected) return;
    if (!isActiveTab('doi', pane)) return;
    bd.innerHTML = '<div class="rcpi-empty">DOI lookup failed.</div>';
    ft.innerHTML = '';
  });
}

function renderDoiResults(results, bd, ft, ed, pane) {
  bd.innerHTML = '';

  const withHits = results.filter(r => !r.errored && r.items && r.items.length && !r.alreadyHas);
  const alreadyHas = results.filter(r => r.alreadyHas);
  const noHits = results.filter(r => !r.errored && (!r.items || !r.items.length) && !r.alreadyHas);
  const errored = results.filter(r => r.errored);

  const hdr = document.createElement('div');
  hdr.className = 'rcpi-sec-title';
  hdr.textContent = `${results.length} reference${results.length === 1 ? '' : 's'} found; ${withHits.length} with DOI suggestions`;
  bd.appendChild(hdr);

  if (!results.length) {
    bd.innerHTML = `<div class="rcpi-empty">No reference-like paragraphs or list items found.<br><small>Looking for &lt;p&gt;/&lt;li&gt; over 80 chars containing a year.</small></div>`;
    ft.innerHTML = `
      <span class="rcpi-prog">0 references scanned</span>
      <button class="rcpi-btn sec" data-rerun>Re-scan</button>
    `;
    ft.querySelector('[data-rerun]').addEventListener('click', () => {
      doiCache = null;
      doiCacheEdId = null;
      doiRunning = false;
      doiRunPromise = null;
      bd.innerHTML = '';
      ft.innerHTML = '';
      renderDoi(bd, ft, ed, pane);
    });
    return;
  }

  withHits.forEach(r => {
    const row = document.createElement('div');
    row.className = 'rcpi-row';

    const sorted = [...r.items].sort((a, b) => (b.score || 0) - (a.score || 0));

    const hitsHtml = sorted.map((item, idx) => {
      const doi = item.DOI;
      const score = Math.round(item.score || 0);
      const band = scoreBand(score);
      const summary = fmtCrossref(item);

      if (!doi) return '';

      return `
        <div class="rcpi-doi-hit" data-doi="${escA(doi)}" data-idx="${idx}">
          <div class="rcpi-doi-meta">
            <span class="rcpi-doi-band ${band.cls}">${band.label} (${score})</span>
            <span class="rcpi-doi-summary">${esc(summary)}</span>
          </div>
          <div class="rcpi-doi-url">https://doi.org/${esc(doi)}</div>
          <div style="display:flex;gap:4px;margin-top:4px">
            <button class="rcpi-btn rcpi-doi-insert" data-doi="${escA(doi)}">Insert DOI</button>
            <button class="rcpi-btn sec rcpi-doi-copy" data-doi="${escA(doi)}" title="Copy DOI to clipboard">Copy</button>
          </div>
        </div>
      `;
    }).filter(Boolean).join('');

    const mismatchHtml = r.mismatch
      ? `<div style="color:#856404;font-size:11px;margin:4px 0;padding:4px 7px;background:#fff9e6;border-left:3px solid #f0b400;border-radius:0 3px 3px 0">⚠️ ${esc(r.mismatch)}</div>`
      : '';

    row.innerHTML = `
      <div class="rcpi-old rcpi-doi-reftext">${esc(r.queryText.slice(0, 200))}${r.queryText.length > 200 ? '…' : ''}</div>
      ${mismatchHtml}
      <div class="rcpi-doi-hits">${hitsHtml || '<i style="color:#999">No DOI found in results</i>'}</div>
      <div class="rcpi-row-actions"><button class="rcpi-locate" data-locate>Locate</button></div>
    `;

    bd.appendChild(row);

    row.querySelector('[data-locate]').addEventListener('click', () => {
      locateInEditor(ed, r.el);
    });

    row.querySelectorAll('.rcpi-doi-insert').forEach(btn => btn.addEventListener('click', () => {
      const doi = btn.getAttribute('data-doi');
      insertDoiLink(ed, r.el, doi);
      row.style.opacity = '0.5';
      row.querySelectorAll('.rcpi-doi-insert').forEach(b => {
        b.disabled = true;
        b.textContent = 'Inserted';
      });
      const loc = row.querySelector('[data-locate]');
      if (loc) loc.click();
    }));

    row.querySelectorAll('.rcpi-doi-copy').forEach(btn => btn.addEventListener('click', () => {
      const doi = btn.getAttribute('data-doi');

      navigator.clipboard.writeText(doi).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = doi;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();

        const orig = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = orig; }, 1800);
      });
    }));
  });

  if (alreadyHas.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary>Already has a DOI link (${alreadyHas.length})</summary>`;

    alreadyHas.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '4px 0';
      d.textContent = r.queryText.slice(0, 120) + (r.queryText.length > 120 ? '…' : '');
      det.appendChild(d);
    });

    bd.appendChild(det);
  }

  if (noHits.length) {
    const det = document.createElement('details');
    det.className = 'rcpi-unc';
    det.innerHTML = `<summary style="color:#888">No Crossref match (${noHits.length})</summary>`;

    noHits.forEach(r => {
      const d = document.createElement('div');
      d.className = 'rcpi-old';
      d.style.margin = '4px 0';
      d.textContent = r.queryText.slice(0, 120) + (r.queryText.length > 120 ? '…' : '');
      det.appendChild(d);
    });

    bd.appendChild(det);
  }

  if (errored.length) {
    const e = document.createElement('div');
    e.className = 'rcpi-old';
    e.style.color = '#c00';
    e.style.margin = '8px 0';
    e.textContent = `${errored.length} reference${errored.length === 1 ? '' : 's'} failed to query (network error).`;
    bd.appendChild(e);
  }

  // PMID section
  const edId = getEditorKey(ed);
  const pmids = (pmidCache && pmidCacheEdId === edId) ? pmidCache : null;
  if (pmids && pmids.length) {
    const pmidWithItems = pmids.filter(p => !p.alreadyLinked && p.items && p.items.length);
    if (pmidWithItems.length) {
      const ph = document.createElement('div');
      ph.className = 'rcpi-sec-title';
      ph.style.marginTop = '16px';
      ph.textContent = `PubMed IDs found — ${pmidWithItems.length} suggestion${pmidWithItems.length === 1 ? '' : 's'}`;
      bd.appendChild(ph);

      pmidWithItems.forEach(p => {
        const row = document.createElement('div');
        row.className = 'rcpi-row';
        const hitsHtml = p.items.map(item => `
          <div class="rcpi-doi-hit">
            <div class="rcpi-doi-meta">
              <span class="rcpi-doi-band doi-high">PMID ${esc(item.pmid)}</span>
              <span class="rcpi-doi-summary">${esc(item.summary)}</span>
            </div>
            <div class="rcpi-doi-url">${esc(item.url)}</div>
            <div style="display:flex;gap:4px;margin-top:4px">
              <button class="rcpi-btn rcpi-pmid-insert" data-pmid="${escA(item.pmid)}" data-url="${escA(item.url)}">Link PMID</button>
              <button class="rcpi-btn sec rcpi-pmid-copy" data-url="${escA(item.url)}">Copy URL</button>
            </div>
          </div>
        `).join('');
        row.innerHTML = `
          <div class="rcpi-old rcpi-doi-reftext">${esc((p.el.textContent || '').slice(0, 200))}</div>
          <div class="rcpi-doi-hits">${hitsHtml}</div>
          <div class="rcpi-row-actions"><button class="rcpi-locate" data-locate>Locate</button></div>
        `;
        bd.appendChild(row);
        row.querySelector('[data-locate]').addEventListener('click', () => locateInEditor(ed, p.el));
        row.querySelectorAll('.rcpi-pmid-insert').forEach(btn => btn.addEventListener('click', () => {
          insertPmidLink(ed, p.el, btn.dataset.pmid, btn.dataset.url);
          row.style.opacity = '0.5';
          row.querySelectorAll('.rcpi-pmid-insert').forEach(b => { b.disabled = true; b.textContent = 'Linked'; });
        }));
        row.querySelectorAll('.rcpi-pmid-copy').forEach(btn => btn.addEventListener('click', () => {
          navigator.clipboard.writeText(btn.dataset.url).then(() => {
            const o = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = o; }, 1800);
          }).catch(() => {});
        }));
      });
    }
  } else if (FEATURES.pmidLookup && FEATURES.pmidLookup.enabled) {
    const pmidNote = document.createElement('div');
    pmidNote.className = 'rcpi-old';
    pmidNote.style.margin = '8px 0';
    pmidNote.style.color = '#888';
    pmidNote.textContent = 'PubMed ID lookup still running in background…';
    bd.appendChild(pmidNote);
  }

  ft.innerHTML = `
    <span class="rcpi-prog">${withHits.length} with suggestions, ${alreadyHas.length} already linked, ${noHits.length} no match</span>
    <button class="rcpi-btn sec" data-exportcsv>CSV</button>
    <button class="rcpi-btn sec" data-rerun>Re-scan</button>
  `;

  ft.querySelector('[data-exportcsv]').addEventListener('click', () => {
    const rows = [['Reference text','DOI','Score','Mismatch warning']];
    results.forEach(r => {
      const top = r.items && r.items[0];
      rows.push([
        (r.queryText || '').slice(0, 200),
        top ? `https://doi.org/${top.DOI}` : '',
        top ? Math.round(top.score || 0) : '',
        r.mismatch || ''
      ]);
    });
    downloadCsv(rows, 'doi-check');
  });

  ft.querySelector('[data-rerun]').addEventListener('click', () => {
    doiCache = null;
    doiCacheEdId = null;
    doiRunning = false;
    doiRunPromise = null;
    pmidCache = null;
    pmidCacheEdId = null;
    bd.innerHTML = '';
    ft.innerHTML = '';
    renderDoi(bd, ft, ed, pane);
  });
}

 /* ================== HEADING OUTLINE EDITOR (paste this block) ============== */

// Detect level-increment violations in a flat list of heading levels.
// Returns [{idx, severity, msg}]. First heading deeper than h2 is a soft note;
// any +2-or-more jump is a warning.
function outlineDetectIssues(levels) {
  const out = [];
  for (let i = 0; i < levels.length; i++) {
    if (i === 0) {
      if (levels[i] > 2) out.push({ idx: i, severity: 'warn', msg: `Document starts at h${levels[i]} — usually h1 or h2 is the top level` });
      continue;
    }
    if (levels[i] > levels[i - 1] + 1) {
      out.push({ idx: i, severity: 'warn', msg: `h${levels[i - 1]} → h${levels[i]} skips ${levels[i] - levels[i - 1] - 1} level(s)` });
    }
  }
  return out;
}

function outlineClamp(l) { return Math.max(1, Math.min(6, l)); }

// Open the outline editor as a slide-over pane. `ed` is the TinyMCE editor.
// `onDone` (optional) is called after Apply so the caller can re-run the a11y
// scan and re-render.
function openOutlineEditor(ed, onDone) {
  const existing = document.getElementById('rcpi-outline-pane');
  if (existing) existing.remove();

  const headings = [...ed.getBody().querySelectorAll('h1,h2,h3,h4,h5,h6')];
  if (!headings.length) { toast('No headings to edit.'); return; }

  // Working model: original element + original level + current (editable) level.
  const model = headings.map(h => ({
    el: h,
    orig: parseInt(h.tagName[1], 10),
    level: parseInt(h.tagName[1], 10),
    text: (h.textContent || '').trim()
  }));

  const pane = document.createElement('div');
  pane.id = 'rcpi-outline-pane';
  pane.className = 'rcpi-pane';
  pane.style.width = 'min(560px, 48vw)';
  pane.innerHTML = `
    <div class="rcpi-hd">
      <h2>Heading outline</h2>
      <button class="rcpi-btn sec" data-close>Close</button>
    </div>
    <div class="rcpi-bd">
      <p style="margin:0 0 10px;color:#555;font-size:12px">
        Adjust levels with the ⬆/⬇ controls. Skipped-level warnings update live.
        Nothing changes in the document until you click <b>Apply</b>.
      </p>
      <div id="rcpi-outline-list"></div>
    </div>
    <div class="rcpi-ft">
      <span class="rcpi-prog" id="rcpi-outline-status"></span>
      <button class="rcpi-btn sec" data-reset>Reset</button>
      <button class="rcpi-btn" data-apply>Apply</button>
    </div>
  `;
  document.body.appendChild(pane);

  const listEl = pane.querySelector('#rcpi-outline-list');
  const statusEl = pane.querySelector('#rcpi-outline-status');

  function render() {
    const levels = model.map(m => m.level);
    const issues = outlineDetectIssues(levels);
    const issueByIdx = {};
    issues.forEach(is => { issueByIdx[is.idx] = is; });

    listEl.innerHTML = '';
    model.forEach((m, idx) => {
      const row = document.createElement('div');
      row.className = 'rcpi-row';
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 9px;margin-bottom:6px';
      // indent reflects level so the tree shape is visible
      const indent = (m.level - 1) * 16;
      const changed = m.level !== m.orig;
      const issue = issueByIdx[idx];
      row.innerHTML = `
        <div style="flex:0 0 auto;display:flex;gap:2px">
          <button class="rcpi-btn sec" data-up title="Promote (decrease level)" style="padding:2px 7px;font-size:13px">⬆</button>
          <button class="rcpi-btn sec" data-down title="Demote (increase level)" style="padding:2px 7px;font-size:13px">⬇</button>
        </div>
        <div style="flex:1;min-width:0;margin-left:${indent}px">
          <span style="display:inline-block;min-width:26px;font-weight:700;color:${changed ? '#0a5' : '#225'}">h${m.level}</span>
          <span style="color:#333">${esc(m.text || '(empty heading)')}</span>
          ${changed ? `<span class="rcpi-tag">was h${m.orig}</span>` : ''}
          ${issue ? `<div style="color:#856404;font-size:11px;margin-top:2px">⚠️ ${esc(issue.msg)}</div>` : ''}
        </div>
        <button class="rcpi-locate" data-locate title="Locate in editor" style="flex:0 0 auto">Locate</button>
      `;
      listEl.appendChild(row);

      row.querySelector('[data-up]').addEventListener('click', () => { m.level = outlineClamp(m.level - 1); render(); });
      row.querySelector('[data-down]').addEventListener('click', () => { m.level = outlineClamp(m.level + 1); render(); });
      row.querySelector('[data-locate]').addEventListener('click', () => locateInEditor(ed, m.el));
    });

    const changedCount = model.filter(m => m.level !== m.orig).length;
    statusEl.textContent = issues.length
      ? `${issues.length} level warning(s) · ${changedCount} pending change(s)`
      : `No level warnings · ${changedCount} pending change(s)`;
    statusEl.style.color = issues.length ? '#856404' : '#0a5';
  }

  pane.querySelector('[data-close]').addEventListener('click', () => pane.remove());
  pane.querySelector('[data-reset]').addEventListener('click', () => {
    model.forEach(m => { m.level = m.orig; });
    render();
  });
  pane.querySelector('[data-apply]').addEventListener('click', () => {
    let n = 0;
    model.forEach(m => {
      if (m.level !== m.orig) {
        const repl = changeTagName(ed, m.el, 'h' + m.level);
        if (repl) { m.el = repl; m.orig = m.level; n++; }
      }
    });
    if (n) {
      flagDirty(ed);
      // Invalidate the a11y cache so the next scan reflects the new structure.
      try { a11yCache = null; a11yCacheEdId = null; } catch {}
      toast(`Updated ${n} heading${n === 1 ? '' : ''}. Now click D2L's Save.`);
    } else {
      toast('No changes to apply.');
    }
    pane.remove();
    if (typeof onDone === 'function') onDone();
  });

  render();
}

  // ACCESSIBILITY TAB
  function renderA11y(bd, ft, ed, pane) {
    const edId = getEditorKey(ed);

    function doRender() {
      const cachedOk = a11yCache && a11yCacheEdId === edId;
      const { issues, headingTree, wordCount, readMins } = cachedOk ? a11yCache : runAndCacheA11y(ed);
        const liveIssues = issues.slice();

      bd.innerHTML = '';

      const treeDiv = document.createElement('div');
      treeDiv.className = 'rcpi-sec-title';
      treeDiv.textContent = 'Heading structure';
      bd.appendChild(treeDiv);

      if (!headingTree.length) {
        const n = document.createElement('div');
        n.className = 'rcpi-old';
        n.style.margin = '0 0 8px';
        n.textContent = 'No headings found.';
        bd.appendChild(n);
      } else {
        const tree = document.createElement('div');
        tree.className = 'rcpi-a11y-tree';
        headingTree.forEach(({ level, text, el }) => {
          const row = document.createElement('div');
          row.className = `h${level}`;
          row.textContent = `${'  '.repeat(level - 1)}h${level} ${text || '(empty)'}`;
          row.title = 'Click to locate';
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => locateInEditor(ed, el));
          tree.appendChild(row);
        });
        bd.appendChild(tree);
      }

      const errors = issues.filter(i => i.severity === 'error');
      const warnings = issues.filter(i => i.severity === 'warn');
      const infos = issues.filter(i => i.severity === 'info');

      const summary = document.createElement('div');
      summary.className = 'rcpi-sec-title';
      summary.textContent = `${issues.length} issue${issues.length===1?'':'s'} — ${errors.length} errors, ${warnings.length} warnings, ${infos.length} info`;
      bd.appendChild(summary);

      if (!issues.length) {
        const e = document.createElement('div');
        e.className = 'rcpi-empty';
        e.textContent = 'No accessibility issues found.';
        bd.appendChild(e);
      }

      const cats = {};
      issues
        .sort((a,b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
        .forEach(issue => {
          if (!cats[issue.category]) cats[issue.category] = [];
          cats[issue.category].push(issue);
        });

      Object.entries(cats).forEach(([cat, catIssues]) => {
        const ch = document.createElement('div');
        ch.className = 'rcpi-a11y-cat';
        ch.textContent = `${cat} (${catIssues.length})`;
        bd.appendChild(ch);

        catIssues.forEach(issue => {
          const row = document.createElement('div');
          row.className = 'rcpi-a11y-row';
          const sevClass = `rcpi-sev-${issue.severity}`;
          const sevLabel = issue.severity === 'error' ? 'ERROR' : issue.severity === 'warn' ? 'WARN' : 'INFO';

          // FIX 2: fixable is now driven by issue.fix, not category+msg string matching
          const fixable = !!issue.fix;

          let msg = issue.msg;
          // Append human hints for fixable issues
          if (issue.fix === 'i-to-em') msg += ' Suggested fix: change <i> to <em>.';
          else if (issue.fix === 'b-to-strong') msg += ' Suggested fix: change <b> to <strong>.';
          else if (issue.fix === 'remove-empty') msg += ' Suggested fix: remove the empty paragraph.';
          else if (issue.fix === 'fix-skipped-heading') msg += ' Suggested fix: promote this heading branch by one level.';
          else if (issue.fix === 'fix-bare-url') {
            const suggestion = suggestLinkText(issue.el);
            if (suggestion) msg += ` Suggested text: ${suggestion}.`;
            else msg += ' No safe automatic label suggestion found.';
          } else if (issue.fix === 'add-empty-alt') {
            msg += ' Suggested fix: add alt="".';
          }

          row.innerHTML = `<span class="${sevClass}">${sevLabel}</span><span class="rcpi-a11y-msg">${esc(msg)}</span><span class="rcpi-a11y-actions"></span>`;
          const actions = row.querySelector('.rcpi-a11y-actions');

          if (issue.el) {
            const lb = document.createElement('button');
            lb.className = 'rcpi-locate';
            lb.textContent = 'Locate';
            lb.title = 'Locate in editor';
            lb.addEventListener('click', () => locateInEditor(ed, issue.el));
            actions.appendChild(lb);
          }

          if (fixable) {
            const fb = document.createElement('button');
            fb.className = 'rcpi-btn sec';
            fb.textContent = 'Fix';
            fb.title = 'Apply suggested fix';
            fb.addEventListener('click', () => {
              const res = applyA11yFix(ed, issue);
              toast(res.msg);

              if (!res.ok) return;

              const idx = liveIssues.indexOf(issue);
              if (idx >= 0) liveIssues.splice(idx, 1);

              if (a11yCache && Array.isArray(a11yCache.issues)) {
                const cidx = a11yCache.issues.indexOf(issue);
                if (cidx >= 0) a11yCache.issues.splice(cidx, 1);
              }

              markA11yRowFixed(row, res.msg);
              refreshA11yFooter(ft, bd, ed, pane, liveIssues, wordCount, readMins);
            });
            actions.appendChild(fb);
          }

          bd.appendChild(row);
        });
      });

      refreshA11yFooter(ft, bd, ed, pane, liveIssues, wordCount, readMins);
    }

    const cachedOk = a11yCache && a11yCacheEdId === edId;
    if (cachedOk) {
      doRender();
      return;
    }

    bd.innerHTML = `<div class="rcpi-empty">Click Run to scan for accessibility issues.</div>`;
    ft.innerHTML = `<button class="rcpi-btn" data-run>Run accessibility check</button>`;
    ft.querySelector('[data-run]').addEventListener('click', () => {
      bd.innerHTML = '';
      ft.innerHTML = '';
      doRender();
    });
  }

  function exportA11yReport(issues, wordCount, readMins) {
    const pageTitle = document.title || location.href;
    const now = new Date().toLocaleString();
    const sevIcon = s => s === 'error' ? '⛔' : s === 'warn' ? '⚠️' : 'ℹ️';

    const cats = {};
    issues
      .sort((a,b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))
      .forEach(i => {
        if (!cats[i.category]) cats[i.category] = [];
        cats[i.category].push(i);
      });

    const catHtml = Object.entries(cats).map(([cat, items]) => `
      <h3>${esc(cat)} (${items.length})</h3>
      <table>
        <thead><tr><th>Sev</th><th>Issue</th></tr></thead>
        <tbody>${items.map(i => `<tr class="sev-${i.severity}"><td>${sevIcon(i.severity)}</td><td>${esc(i.msg)}</td></tr>`).join('')}</tbody>
      </table>
    `).join('');

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warn').length;
    const infos = issues.filter(i => i.severity === 'info').length;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Accessibility Report — ${esc(pageTitle)}</title>
<style>
body{font:14px/1.5 system-ui,Arial,sans-serif;margin:32px;color:#222}
h1{font-size:18px;margin-bottom:4px}
h3{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #eee;padding-bottom:3px}
.meta{color:#666;font-size:12px;margin-bottom:20px}
.summary{display:flex;gap:16px;margin-bottom:20px}
.badge{padding:6px 14px;border-radius:4px;font-weight:700;font-size:13px}
.badge.error{background:#f8d7da;color:#721c24}
.badge.warn{background:#fff3cd;color:#856404}
.badge.info{background:#d1ecf1;color:#0c5460}
table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px}
th{text-align:left;background:#f0f0f0;padding:5px 8px;font-weight:600}
td{padding:4px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top}
tr.sev-error td{background:#fff8f8}
tr.sev-warn td{background:#fffdf0}
.footer{margin-top:24px;font-size:11px;color:#aaa}
</style>
</head>
<body>
<h1>Accessibility Report</h1>
<div class="meta">
  <b>Page</b> ${esc(pageTitle)}<br>
  <b>URL</b> ${esc(location.href)}<br>
  <b>Generated</b> ${esc(now)}<br>
  <b>Word count</b> ${wordCount} words · ${readMins} min read
</div>
<div class="summary">
  <span class="badge error">${errors} error${errors===1?'':'s'}</span>
  <span class="badge warn">${warnings} warning${warnings===1?'':'s'}</span>
  <span class="badge info">${infos} info</span>
</div>
${catHtml || '<p>No issues found.</p>'}
<div class="footer">Generated by RCPI Brightspace Edit Toolkit</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `a11y-report-${Date.now()}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function updateFabBadge() {
    const fab = document.querySelector('.rcpi-fab button');
    if (!fab) return;
    let badge = fab.querySelector('.rcpi-fab-badge');
    if (!a11yCache) {
      if (badge) badge.remove();
      return;
    }
    const n = a11yCache.issues.filter(i => i.severity === 'error').length;
    if (!n) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'rcpi-fab-badge';
      fab.appendChild(badge);
    }
    badge.textContent = n;
  }

  function paintTabStatuses(tabs, ed) {
  const edId = getEditorKey(ed);

  let lintDone = false;
  let replaceDone = false;

  try {
    lintDone = collectLintMatches(ed).length === 0;
  } catch (e) {}

  try {
    replaceDone = collectReplaceMatches(ed).length === 0;
  } catch (e) {}

  tabs.forEach(t => {
    const name = t.dataset.t;
    let status = '';

    if (name === 'probe') {
      if (probeRunning && probeCacheEdId === edId) status = 'running';
      else if (probeCache && probeCacheEdId === edId) status = 'done';
    } else if (name === 'doi') {
      if (doiRunning && doiCacheEdId === edId) status = 'running';
      else if (doiCache && doiCacheEdId === edId) status = 'done';
    } else if (name === 'a11y') {
      if (a11yCache && a11yCacheEdId === edId) status = 'done';
    } else if (name === 'lint') {
      if (lintDone) status = 'done';
    } else if (name === 'replace') {
      if (replaceDone) status = 'done';
    }

    t.classList.toggle('done', status === 'done');
    t.classList.toggle('running', status === 'running');
    t.title =
      status === 'done' ? 'Finished in background' :
      status === 'running' ? 'Running in background' :
      '';
  });
}
  function patchOpenPanel() {
    window.rcpiOpenPanel = function(initialTab) {
      if (panelEl) {
        panelEl.remove();
        panelEl = null;
      }

      const ed = getEditor();
      if (!ed) {
        alert('TinyMCE editor not found.');
        return;
      }

      const pane = document.createElement('div');
      pane.className = 'rcpi-pane';
      panelEl = pane;

      pane.innerHTML = `
        <div class="rcpi-hd"><h2>Edit Toolkit</h2><button class="rcpi-btn sec" data-close>Close</button></div>
        <div class="rcpi-tabs">
          <div class="rcpi-tab" data-t="probe">Check 404s</div>
          <div class="rcpi-tab" data-t="lint">Fix URLs</div>
          <div class="rcpi-tab" data-t="replace">Find &amp; Replace</div>
          <div class="rcpi-tab" data-t="doi">Citations</div>
          <div class="rcpi-tab" data-t="a11y">Accessibility</div>
          <div class="rcpi-tab" data-t="settings">⚙ Settings</div>
        </div>
        <div class="rcpi-bd"></div>
        <div class="rcpi-ft"></div>
      `;

      pane.querySelector('[data-close]').addEventListener('click', () => { pane.remove(); panelEl = null; });

      const bd = pane.querySelector('.rcpi-bd');
      const ft = pane.querySelector('.rcpi-ft');
      const tabs = pane.querySelectorAll('.rcpi-tab');
      paintTabStatuses(tabs, ed);

      function setTab(name) {
        tabs.forEach(t => t.classList.toggle('active', t.dataset.t === name));
        bd.innerHTML = '';
        ft.innerHTML = '';

        if (name === 'replace') renderReplace(bd, ft, ed, pane);
        else if (name === 'lint') renderLint(bd, ft, ed, pane);
        else if (name === 'doi') renderDoi(bd, ft, ed, pane);
        else if (name === 'a11y') renderA11y(bd, ft, ed, pane);
        else if (name === 'settings') renderSettings(bd, ft, ed, pane);
        else renderProbe(bd, ft, ed, pane);
      }

      tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.t)));
      document.body.appendChild(pane);
      setTab(initialTab || 'probe');
    };

    // Keyboard shortcut: Alt+Shift+<shortcutKey>
    if (FEATURES.keyboardShortcut) {
      document.addEventListener('keydown', e => {
        if (e.altKey && e.shiftKey && e.key.toLowerCase() === (FEATURES.shortcutKey || 'e').toLowerCase()) {
          e.preventDefault();
          window.rcpiOpenPanel();
        }
      });
    }
  }

  // SETTINGS TAB
  function renderSettings(bd, ft, ed, pane) {
    const s = loadSettings();

    const boolRow = (key, label, desc, current) => `
      <div class="rcpi-row" style="padding:8px 10px">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <input type="checkbox" id="rcpi-s-${key}" style="margin-top:3px;flex:0 0 auto" ${current ? 'checked' : ''}>
          <div>
            <label for="rcpi-s-${key}" style="font-weight:600;font-size:12px;cursor:pointer">${esc(label)}</label>
            <div style="color:#666;font-size:11px;margin-top:2px">${esc(desc)}</div>
          </div>
        </div>
      </div>`;

    const numRow = (key, label, desc, current, unit) => `
      <div class="rcpi-row" style="padding:8px 10px">
        <label for="rcpi-s-${key}" style="font-weight:600;font-size:12px">${esc(label)}</label>
        <div style="color:#666;font-size:11px;margin:2px 0 5px">${esc(desc)}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="number" id="rcpi-s-${key}" value="${current}" min="1" style="width:90px;padding:4px 6px;border:1px solid #bbb;border-radius:3px;font:inherit;font-size:12px">
          <span style="color:#666;font-size:12px">${esc(unit)}</span>
        </div>
      </div>`;

    bd.innerHTML = `
      <div class="rcpi-sec-title">Link checker</div>
      ${boolRow('linkChecker-autoRunPageLoad', 'Auto-run 404 check on page load', 'Fires HEAD/GET at every link on editor load. Keep off unless you want background checking on every lesson.', FEATURES.linkChecker.autoRunPageLoad)}
      ${boolRow('probeHeadFirst', 'HEAD-first probing', 'Try HEAD before GET to reduce bandwidth. Disable only if servers reject HEAD.', FEATURES.probeHeadFirst)}
      ${boolRow('probeRetryOnce', 'Retry once on timeout/5xx', 'A single network blip won\'t immediately mark a link broken.', FEATURES.probeRetryOnce)}
      ${boolRow('probeFlagRedirect', 'Flag redirects', 'Warn on 3xx redirects — the target URL should be updated.', FEATURES.probeFlagRedirect)}
      ${boolRow('probeFlagMixed', 'Flag mixed content', 'Flag http:// links/images on this https page.', FEATURES.probeFlagMixed)}

      <div class="rcpi-sec-title" style="margin-top:12px">Citations</div>
      ${boolRow('doiLookup-autoRunPageLoad', 'Auto-run DOI lookup on page load', 'Queries Crossref for every reference-like paragraph on load.', FEATURES.doiLookup.autoRunPageLoad)}
      ${boolRow('pmidLookup-enabled', 'PubMed ID lookup', 'Detect bare PMIDs and offer PubMed links via NCBI E-utilities.', FEATURES.pmidLookup && FEATURES.pmidLookup.enabled)}

      <div class="rcpi-sec-title" style="margin-top:12px">Accessibility</div>
      ${boolRow('accessibility-autoRunPageLoad', 'Auto-run accessibility check on page load', 'Runs full a11y scan on load; powers the FAB error-count badge.', FEATURES.accessibility.autoRunPageLoad)}
      ${numRow('imageWidthPx', 'Max image width', 'Warn when an image is wider than this.', FEATURES.imageWidthPx, 'px')}
      ${numRow('imageSizeKB', 'Max image file size', 'Warn when a probed image\'s Content-Length exceeds this threshold.', FEATURES.imageSizeKB, 'KB')}

      <div class="rcpi-sec-title" style="margin-top:12px">General</div>
      ${boolRow('keyboardShortcut', 'Keyboard shortcut (Alt+Shift+E)', 'Open the panel without clicking the FAB button.', FEATURES.keyboardShortcut)}
      ${boolRow('beforeSave-enabled', 'Pre-save accessibility check', 'Intercept D2L Save and warn about errors/warnings before saving.', FEATURES.beforeSave.enabled)}

      <div class="rcpi-sec-title" style="margin-top:12px">Ignored domains (one per line)</div>
      <div style="color:#666;font-size:11px;margin-bottom:6px">Links on these domains are skipped by the 404 checker. Common paywalled journals are pre-seeded.</div>
      <textarea class="rcpi-ta" id="rcpi-s-ignoreDomains" style="min-height:140px">${esc(loadIgnoreDomains().join('\n'))}</textarea>
    `;

    ft.innerHTML = `
      <button class="rcpi-btn sec" data-reset>Reset all to defaults</button>
      <button class="rcpi-btn" data-save>Save settings</button>
    `;

    ft.querySelector('[data-save]').addEventListener('click', () => {
      const news = loadSettings();

      const bool = (key, featPath) => {
        const el = bd.querySelector(`#rcpi-s-${key}`);
        if (!el) return;
        const val = el.checked;
        const parts = featPath ? featPath.split('.') : key.replace('-', '.').split('.');
        if (parts.length === 2) {
          if (!news[parts[0]]) news[parts[0]] = {};
          news[parts[0]][parts[1]] = val;
          if (FEATURES[parts[0]]) FEATURES[parts[0]][parts[1]] = val;
        } else {
          news[key] = val;
          FEATURES[key] = val;
        }
      };

      const num = (key) => {
        const el = bd.querySelector(`#rcpi-s-${key}`);
        if (!el) return;
        const val = parseInt(el.value, 10);
        if (!isNaN(val) && val > 0) { news[key] = val; FEATURES[key] = val; }
      };

      bool('linkChecker-autoRunPageLoad', 'linkChecker.autoRunPageLoad');
      bool('probeHeadFirst');
      bool('probeRetryOnce');
      bool('probeFlagRedirect');
      bool('probeFlagMixed');
      bool('doiLookup-autoRunPageLoad', 'doiLookup.autoRunPageLoad');
      bool('pmidLookup-enabled', 'pmidLookup.enabled');
      bool('accessibility-autoRunPageLoad', 'accessibility.autoRunPageLoad');
      bool('keyboardShortcut');
      bool('beforeSave-enabled', 'beforeSave.enabled');
      num('imageWidthPx');
      num('imageSizeKB');

      const domainsTa = bd.querySelector('#rcpi-s-ignoreDomains');
      if (domainsTa) {
        const domains = domainsTa.value.split(/\n+/).map(d => d.trim()).filter(Boolean);
        saveIgnoreDomains(domains);
      }

      saveSettings(news);
      toast('Settings saved.');
    });

    ft.querySelector('[data-reset]').addEventListener('click', () => {
      if (!confirm('Reset all settings to defaults?')) return;
      GM_setValue(SETTINGS_KEY, '{}');
      GM_setValue(IGNORE_KEY, '');
      // Re-apply defaults
      FEATURES.linkChecker.autoRunPageLoad = false;
      FEATURES.probeHeadFirst = true;
      FEATURES.probeRetryOnce = true;
      FEATURES.probeFlagRedirect = true;
      FEATURES.probeFlagMixed = true;
      FEATURES.doiLookup.autoRunPageLoad = true;
      FEATURES.pmidLookup.enabled = true;
      FEATURES.accessibility.autoRunPageLoad = true;
      FEATURES.imageWidthPx = 2000;
      FEATURES.imageSizeKB = 1000;
      FEATURES.keyboardShortcut = true;
      FEATURES.beforeSave.enabled = true;
      toast('Settings reset to defaults.');
      bd.innerHTML = ''; ft.innerHTML = '';
      renderSettings(bd, ft, ed, pane);
    });
  }

  function showRules() {
    let rulePane = document.getElementById('rcpi-rules-pane');
    if (rulePane) {
      rulePane.remove();
      return;
    }

    rulePane = document.createElement('div');
    rulePane.id = 'rcpi-rules-pane';
    rulePane.className = 'rcpi-pane';
    rulePane.innerHTML = `
      <div class="rcpi-hd"><h2>Replacement rules JSON</h2><button class="rcpi-btn sec" data-close>x</button></div>
      <div class="rcpi-bd">
        <p style="margin:0 0 8px;color:#555;font-size:12px"><code>field</code>: href/text, either <code>match</code>: exact/contains, <code>replaceHref</code>/<code>replaceText</code>: null=leave unchanged</p>
        <textarea class="rcpi-ta" spellcheck="false"></textarea>
        <div data-err style="color:#c00;margin-top:5px;min-height:14px;font-size:12px"></div>
      </div>
      <div class="rcpi-ft">
        <button class="rcpi-btn danger" data-reset>Reset</button>
        <button class="rcpi-btn sec" data-close2>Cancel</button>
        <button class="rcpi-btn" data-save>Save rules</button>
      </div>
    `;

    const ta = rulePane.querySelector('.rcpi-ta');
    ta.value = JSON.stringify(loadRules(), null, 2);
    const err = rulePane.querySelector('[data-err]');
    const close = () => rulePane.remove();

    rulePane.querySelector('[data-close]').addEventListener('click', close);
    rulePane.querySelector('[data-close2]').addEventListener('click', close);
    rulePane.querySelector('[data-reset]').addEventListener('click', () => {
      ta.value = JSON.stringify(DEFAULT_RULES, null, 2);
    });
    rulePane.querySelector('[data-save]').addEventListener('click', () => {
      try {
        const p = JSON.parse(ta.value);
        if (!Array.isArray(p)) throw new Error('Must be an array.');
        saveRules(p);
        close();
        toast('Rules saved.');
      } catch (e) {
        err.textContent = `Invalid JSON: ${e.message}`;
      }
    });

    document.body.appendChild(rulePane);
  }

  function mountFab() {
    if (document.querySelector('.rcpi-fab')) return;
    const fab = document.createElement('div');
    fab.className = 'rcpi-fab';
    fab.innerHTML = `<button>Edit Toolkit</button>`;
    fab.querySelector('button').addEventListener('click', () => window.rcpiOpenPanel());
    document.body.appendChild(fab);
  }

  let pageLoadRan = false;
  let saveInterceptInstalled = false;

  function ensureMounted() {
    const ed = getEditor();
    const hasEditor = !!ed;
    const hasFab = !!document.querySelector('.rcpi-fab');

    if (hasEditor && !hasFab) mountFab();
    if (!hasEditor && hasFab) {
      const f = document.querySelector('.rcpi-fab');
      if (f) f.remove();
    }

  if (hasEditor && !pageLoadRan) {
  pageLoadRan = true;

  if (FEATURES.linkChecker && FEATURES.linkChecker.enabled && FEATURES.linkChecker.autoRunPageLoad) {
    setTimeout(() => {
      try { startProbeBackground(ed, () => {}); } catch (e) {}
    }, 1500);
  }

  if (FEATURES.doiLookup && FEATURES.doiLookup.enabled && FEATURES.doiLookup.autoRunPageLoad) {
    setTimeout(() => {
      try { startDoiBackground(ed); } catch (e) {}
    }, 800);
  }

  if (FEATURES.accessibility && FEATURES.accessibility.enabled && FEATURES.accessibility.autoRunPageLoad) {
    setTimeout(() => {
      try {
        runAndCacheA11y(ed);
        updateFabBadge();
      } catch (e) {}
    }, 1200);
  }

  if (FEATURES.beforeSave && FEATURES.beforeSave.enabled && !saveInterceptInstalled) {
    saveInterceptInstalled = true;
    installSaveIntercept(getEditor);
  }
}

        if (!hasEditor) {
      pageLoadRan = false;
      a11yCache = null;
      a11yCacheEdId = null;
      doiCache = null;
      doiCacheEdId = null;
      doiRunning = false;
      doiRunPromise = null;
      pmidCache = null;
      pmidCacheEdId = null;
      probeCache = null;
      probeCacheEdId = null;
      probeRunning = false;
      probeRunPromise = null;
    }
  }

  setInterval(ensureMounted, 1000);

  let lastUrl = location.pathname + location.search;
  setInterval(() => {
    const nowUrl = location.pathname + location.search;
    if (nowUrl !== lastUrl) {
      lastUrl = nowUrl;
      pageLoadRan = false;
      a11yCache = null;
      a11yCacheEdId = null;
      doiCache = null;
      doiCacheEdId = null;
      doiRunning = false;
      doiRunPromise = null;
      probeCache = null;
      probeCacheEdId = null;
      probeRunning = false;
      probeRunPromise = null;
      pmidCache = null;
      pmidCacheEdId = null;
      setTimeout(ensureMounted, 600);
    }
  }, 500);

  patchOpenPanel();
  ensureMounted();

    document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
  }
});
})();