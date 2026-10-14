// ==UserScript==
// @name         RCPI Brightspace – Broken Links & Images in Content Pages
// @namespace    rcpi-content-audit
// @description  Fetches every linked HTML page in a course, extracts its <a href>, <img src> and CSS url() references, and probes each for broken links/images. Uses GM_xmlhttpRequest to bypass CORS on external URLs. Modal report + CSV.
// @match        https://brightspace.rcpi.ie/d2l/*
// @version      1.5
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config ----
  const PAGE_CONCURRENCY  = 6;    // HTML pages fetched in parallel
  const PROBE_CONCURRENCY = 10;   // references probed in parallel
  const PROBE_TIMEOUT_MS  = 15000;
  const MAX_FRAME_DEPTH   = 3;    // how deep to follow same-origin embedded content pages
  const SKIP_SCHEMES = /^(mailto:|tel:|javascript:|data:|blob:|#|sms:|ftp:)/i;

  // ---- Shared ignore / media lists (keep identical to the Python script) ----
  const IGNORE = [
    'element_templates/', 'dynamic_templates/', 'html-template-library/',
    '/loadactivity/', 'quicklink.d2l', '/d2l/common/dialogs/',
  ];
  const MEDIA_HOSTS = [
    'panopto', 'youtube.com', 'youtu.be', 'ted.com', 'vimeo.com', 'wistia',
    'wcs/mp', 'mediaplayer.d2l',
  ];
  const STATUS_MEANING = {
    200: 'OK', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 406: 'Not Acceptable', 408: 'Request Timeout', 410: 'Gone',
    429: 'Too Many Requests', 451: 'Unavailable For Legal Reasons',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    504: 'Gateway Timeout', 522: 'Connection Timed Out (origin)',
  };
  const isIgnored = (u) => { const l = u.toLowerCase(); return IGNORE.some(f => l.includes(f)) || l.replace(/\/+$/, '').endsWith('/null'); };
  const isMediaHost = (u) => { const l = u.toLowerCase(); return MEDIA_HOSTS.some(h => l.includes(h)); };
  const isMalformed = (u) => {
    if (/^https?:\/\/https?:?\/?\//i.test(u)) return true;                 // doubled scheme
    if (/[)\]]$/.test(u) && !u.includes('(') && !u.includes('[')) return true;  // stray bracket in href
    return false;
  };
  const statusMeaning = (status, state) => {
    if (state === 'malformed-url') return 'Malformed URL (author error)';
    if (state === 'media-embed')   return 'Media embed — not checked';
    if (status === 0)              return 'No response';
    return STATUS_MEANING[status] || ('HTTP ' + status);
  };
  const classify = (status, external, finalUrl) => {
    if (/\/d2l\/login/i.test(finalUrl || '')) return 'auth';
    if (status === 404 || status === 410) return 'broken';
    if (!external && status >= 400) return 'broken';
    if (!external && status === 0) return 'check';
    if ([401, 403, 406, 451].includes(status)) return 'blocked';
    if ([500, 502, 503, 504, 522].includes(status)) return 'server-error';
    if (status === 429) return 'rate-limited';
    if (status >= 400 || status === 0) return 'check';
    return 'ok';
  };

  // Per-host throttle for EXTERNAL probing only (internal stays full-speed)
  const EXT_GAP = 400, EXT_PER_HOST = 3;
  const _extActive = new Map(), _extLast = new Map();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function throttleExternal(url) {
    let host; try { host = new URL(url).host.toLowerCase(); } catch (_) { host = url; }
    while ((_extActive.get(host) || 0) >= EXT_PER_HOST) await sleep(50);
    _extActive.set(host, (_extActive.get(host) || 0) + 1);
    const wait = (_extLast.get(host) || 0) + EXT_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    _extLast.set(host, Date.now());
    return host;
  }
  const releaseExternal = (host) => _extActive.set(host, Math.max(0, (_extActive.get(host) || 1) - 1));

  // GM_xmlhttpRequest wrapper -> { status, finalUrl, error }
  function gmRequest(method, url) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method, url, timeout: PROBE_TIMEOUT_MS,
        onload:    (r) => resolve({ status: r.status, finalUrl: r.finalUrl || url }),
        onerror:   ()  => resolve({ status: 0, finalUrl: url, error: 'network' }),
        ontimeout: ()  => resolve({ status: 0, finalUrl: url, error: 'timeout' }),
      });
    });
  }

  // Run an async worker pool over items
  async function pool(items, size, fn, onTick) {
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
        if (onTick) onTick();
      }
    }
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  }

  // ---- Resolve course id (URL, then page scan) ----
  function ouFromUrl() {
    return (location.href.match(/\/d2l\/le\/lessons\/(\d+)/)
         || location.href.match(/\/d2l\/le\/content\/(\d+)/)
         || location.href.match(/\/d2l\/home\/(\d+)/)
         || location.href.match(/[?&]ou=(\d+)/) || [])[1];
  }
  function ouFromDom() {
    for (const el of document.querySelectorAll('a[href],link[href],form[action]')) {
      const s = el.getAttribute('href') || el.getAttribute('action') || '';
      const m = s.match(/[?&]ou=(\d+)/) || s.match(/\/(?:lessons|content|home)\/(\d+)/);
      if (m) return m[1];
    }
    const m = document.documentElement.innerHTML.match(/[?&]ou=(\d+)/)
           || document.documentElement.innerHTML.match(/"orgUnitId"\s*:\s*"?(\d+)/i);
    return m ? m[1] : null;
  }

  const getJson = (path) =>
    fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(`${r.status} on ${path}`)));

  // Fetch raw text of a same-origin content page (cookie session)
  const getText = (url) =>
    fetch(url, { credentials: 'include' }).then(r => (r.ok ? r.text() : Promise.reject(r.status)));

  // ---- Main ----
  async function run() {
    let ou = null;
    for (let i = 0; i < 14 && !ou; i++) { ou = ouFromUrl() || ouFromDom(); if (!ou) await new Promise(r => setTimeout(r, 300)); }
    if (!ou) return;

    // Progress modal first
    const ui = mountModal(ou);

    // 1. Topic list from the content API
    let version = '1.74';
    try { const v = await getJson('/d2l/api/le/versions/'); version = v?.LatestVersion || (Array.isArray(v) && v.at(-1)?.LatestVersion) || version; } catch (_) {}
    const versions = [...new Set([version, '1.74', '1.67', '1.50', '1.30'])];

    let flat = [];
    for (const v of versions) {
      for (const route of ['content/toc', 'content/root/']) {
        try {
          const data = await getJson(`/d2l/api/le/${v}/${ou}/${route}`);
          const acc = [];
          (function walk(n) {
            const x = Array.isArray(n) ? { Structure: n } : n;
            (x.Modules || []).forEach(walk);
            (x.Topics || []).forEach(t => acc.push(t));
            (x.Structure || []).forEach(s => (s.Type === 1 ? acc.push(s) : walk(s)));
          })(data);
          if (acc.length) { flat = acc; break; }
        } catch (_) {}
      }
      if (flat.length) break;
    }

    // Keep only HTML pages we can read (same-origin enforced content, non-quicklink, non-package)
    const isPkg = (s) => /scorm|lms_?package|\/zip\//i.test(s || '');
    const pages = flat.map(t => {
      const id = t.TopicId ?? t.Id;
      const file = (t.Url || '').split('?')[0] || null;
      return { id, title: t.Title || '(untitled)', file,
               url: file ? new URL(file, location.origin).href : null,
               link: `${location.origin}/d2l/le/lessons/${ou}/topics/${id}` };
    }).filter(p => p.url && /\.html?$/i.test(p.file)
                && !/quicklink/i.test(p.file) && !isPkg(p.file));

    if (!pages.length) { ui.finish({ ou, pages: 0, refs: 0, results: [] }); return; }

    // Only dive into Brightspace-hosted content HTML (not external embeds or /d2l/ chrome)
    const recursable = (abs) => {
      try { const u = new URL(abs);
        return u.origin === location.origin && /\/content\/enforced\//i.test(u.pathname) && /\.html?$/i.test(u.pathname);
      } catch (_) { return false; }
    };
    const dedupeByUrl = (arr) => { const seen = new Set(); return arr.filter(f => !seen.has(f.url) && seen.add(f.url)); };

    // 2. Crawl pages, following same-origin embedded content pages up to MAX_FRAME_DEPTH
    const refs = [];   // { pageTitle, pageLink, kind, raw, absUrl, external, frame }
    const visited = new Set();
    let frontier = pages.map(p => ({ url: p.url, title: p.title, link: p.link, depth: 0 }));
    let docsDone = 0;

    while (frontier.length) {
      frontier = dedupeByUrl(frontier).filter(f => !visited.has(f.url));
      const nextLevel = [];
      ui.setStage(`Reading pages${frontier[0] && frontier[0].depth ? ` (embedded, depth ${frontier[0].depth})` : ''}… ${docsDone} read`);
      await pool(frontier, PAGE_CONCURRENCY, async (f) => {
        if (visited.has(f.url)) return;
        visited.add(f.url);
        let html;
        try { html = await getText(f.url); } catch (_) { return; }
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const base = f.url;
        const add = (raw, kind) => {
          if (!raw || SKIP_SCHEMES.test(raw.trim())) return;
          let abs; try { abs = new URL(raw, base).href; } catch (_) { return; }
          abs = abs.split('#')[0];
          if (!/^https?:/i.test(abs)) return;
          if (isIgnored(abs)) return;
          const external = !abs.startsWith(location.origin);
          refs.push({ pageTitle: f.title, pageLink: f.link, kind, raw, absUrl: abs, external, frame: f.depth > 0 ? f.url : '' });
          if (kind === 'iframe' && f.depth < MAX_FRAME_DEPTH && recursable(abs) && !visited.has(abs))
            nextLevel.push({ url: abs, title: f.title, link: f.link, depth: f.depth + 1 });
        };
        doc.querySelectorAll('a[href]').forEach(a => add(a.getAttribute('href'), 'link'));
        doc.querySelectorAll('img[src]').forEach(im => add(im.getAttribute('src'), 'image'));
        doc.querySelectorAll('img[srcset], source[srcset]').forEach(im =>
          (im.getAttribute('srcset') || '').split(',').forEach(part => add(part.trim().split(/\s+/)[0], 'image')));
        doc.querySelectorAll('iframe[src]').forEach(fr => add(fr.getAttribute('src'), 'iframe'));
        doc.querySelectorAll('video[src], audio[src], source[src], track[src]').forEach(m => add(m.getAttribute('src'), 'media'));
        doc.querySelectorAll('object[data]').forEach(o => add(o.getAttribute('data'), 'embed'));
        doc.querySelectorAll('embed[src]').forEach(e => add(e.getAttribute('src'), 'embed'));
        doc.querySelectorAll('link[href]').forEach(l => {
          const rel = (l.getAttribute('rel') || '').toLowerCase();
          if (/stylesheet|icon|preload/.test(rel)) add(l.getAttribute('href'), 'stylesheet');
        });
        // CSS url(...) in inline styles and <style> blocks
        const cssText = [...doc.querySelectorAll('[style]')].map(e => e.getAttribute('style')).join(';')
                      + [...doc.querySelectorAll('style')].map(e => e.textContent).join('\n');
        (cssText.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi) || []).forEach(m => {
          const u = m.replace(/url\(\s*['"]?/i, '').replace(/['"]?\s*\)$/, '');
          add(u, 'css');
        });
        docsDone++;
        ui.setStage(`Reading pages… ${docsDone} read`);
      });
      frontier = nextLevel;
    }


    // 3. De-duplicate references by absolute URL (probe each unique URL once)
    const uniq = new Map();   // absUrl -> { absUrl, external, kind, uses:[{pageTitle,pageLink,raw,kind,frame}] }
    refs.forEach(r => {
      if (!uniq.has(r.absUrl)) uniq.set(r.absUrl, { absUrl: r.absUrl, external: r.external, kind: r.kind, uses: [] });
      const e = uniq.get(r.absUrl);
      e.uses.push({ pageTitle: r.pageTitle, pageLink: r.pageLink, raw: r.raw, kind: r.kind, frame: r.frame });
      if (r.kind === 'image' && e.kind !== 'image') e.kind = 'image';   // prefer image label if any use is an image
    });
    const targets = [...uniq.values()];

    // 4. Probe each unique URL
    ui.setStage(`Checking ${targets.length} references…`);
    let probed = 0;
    const encodeUrl = (u) => { try { return encodeURI(decodeURI(u)); } catch (_) { try { return encodeURI(u); } catch (__) { return u; } } };
    await pool(targets, PROBE_CONCURRENCY, async (t) => {
      // Pre-classify without probing: author typos and media embeds.
      if (isMalformed(t.absUrl)) { t.state = 'malformed-url'; t.status = 0; probed++; return; }
      if (isMediaHost(t.absUrl)) { t.state = 'media-embed'; t.status = 0; probed++; return; }

      let res;
      const target = encodeUrl(t.absUrl);
      if (t.external) {                       // GM bypasses CORS; throttle per-host
        const host = await throttleExternal(target);
        try {
          res = await gmRequest('GET', target);
          if (res.status === 429) { await sleep(2000); res = await gmRequest('GET', target); }  // one polite retry
        } finally { releaseExternal(host); }
      } else {                                // same-origin: GET, abort body once headers arrive
        try {
          const ctrl = new AbortController();
          const r = await fetch(target, { method: 'GET', credentials: 'include', signal: ctrl.signal });
          res = { status: r.status, finalUrl: r.url };
          ctrl.abort();
        } catch (e) {
          res = (e && e.name === 'AbortError') ? { status: 200, finalUrl: target } : { status: 0, finalUrl: target };
        }
      }
      t.status = res.status;
      t.state = classify(res.status, t.external, res.finalUrl);
      probed++;
      if (probed % 5 === 0 || probed === targets.length) ui.setStage(`Checking references… ${probed}/${targets.length}`);
    });

    // 5. Results = anything not ok / not auth-bounce. Flatten to one row per (url, page).
    const actionFor = (state, external) => {
      if (state === 'broken' || state === 'malformed-url') return ['FIX', 0];
      if (!external && (state === 'server-error' || state === 'check')) return ['REVIEW', 1];
      if (state === 'media-embed') return ['INFO', 3];
      return ['LIKELY OK', 2];
    };
    const bad = targets.filter(t => t.state !== 'ok' && t.state !== 'auth');
    const results = [];
    bad.forEach(t => t.uses.forEach(u => {
      const [action, rank] = actionFor(t.state, t.external);
      results.push({
        action, rank, state: t.state, status: t.status, meaning: statusMeaning(t.status, t.state),
        kind: u.kind, external: t.external, url: t.absUrl, raw: u.raw,
        pageTitle: u.pageTitle, pageLink: u.pageLink, frame: u.frame || '',
      });
    }));
    const stOrder = { broken: 0, 'malformed-url': 1, blocked: 2, 'server-error': 3, 'rate-limited': 4, check: 5, 'media-embed': 6 };
    results.sort((a, b) => a.rank - b.rank || ((stOrder[a.state] ?? 9) - (stOrder[b.state] ?? 9)) || a.pageTitle.localeCompare(b.pageTitle));

    window.__rcpiLinkAudit = { ou, pages: pages.length, refs: targets.length, results, targets };
    ui.finish({ ou, pages: pages.length, refs: targets.length, results, authSeen: targets.some(t => t.state === 'auth') });
  }

  // ---- Modal (Shadow DOM) ----
  function mountModal(ou) {
    document.getElementById('rcpi-linkaudit-host')?.remove();
    const host = document.createElement('div');
    host.id = 'rcpi-linkaudit-host';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
      .backdrop { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      .card { position: fixed; top: 64px; right: 20px; pointer-events: auto; background: #fff; width: min(840px, 96vw); max-height: 86vh; display: flex; flex-direction: column; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.35); overflow: hidden; }
      .card.dragging { user-select: none; }
      .head { padding: 9px 14px; color: #fff; display: flex; align-items: center; gap: 10px; background: #34506b; cursor: move; }
      .head h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
      .badge { background: rgba(255,255,255,.25); padding: 2px 9px; border-radius: 20px; font-size: 12px; }
      .x { cursor: pointer; font-size: 20px; line-height: 1; background: none; border: 0; color: #fff; opacity: .85; } .x:hover { opacity: 1; }
      .meta { padding: 6px 14px; font-size: 11px; color: #666; border-bottom: 1px solid #eee; }
      .body { padding: 6px 14px 12px; overflow: auto; }
      .spin { padding: 26px 10px; text-align: center; color: #555; font-size: 13px; }
      .clear { text-align: center; padding: 22px 10px; color: #1f7a3d; font-size: 14px; } .clear .big { font-size: 34px; display: block; margin-bottom: 6px; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { text-align: left; padding: 5px 8px; border-top: 1px solid #f1f1f1; vertical-align: top; }
      th { color: #777; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; position: sticky; top: 0; background: #fff; }
      td.url { word-break: break-all; max-width: 320px; }
      td.url a { color: #1a5fb4; text-decoration: none; } td.url a:hover { text-decoration: underline; }
      .pill { font-size: 10px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; display: inline-block; }
      .s-broken { background: #f3c2bb; color: #7a1a0c; }
      .s-malformed-url { background: #e7c6f0; color: #5a1a6b; }
      .s-blocked, .s-rate-limited { background: #ffe1b0; color: #6b3e00; }
      .s-server-error, .s-check { background: #fff0c2; color: #6b5a00; }
      .s-media-embed { background: #d6e6f5; color: #1a4b78; }
      .k { color: #888; }
      .act-FIX { font-weight: 700; color: #7a1a0c; background: #f3c2bb; padding: 1px 7px; border-radius: 4px; font-size: 11px; }
      .act-REVIEW { color: #6b3e00; background: #ffe1b0; padding: 1px 7px; border-radius: 4px; font-size: 11px; }
      .act-LIKELY-OK { color: #555; background: #ececec; padding: 1px 7px; border-radius: 4px; font-size: 11px; }
      .act-INFO { color: #1a4b78; background: #d6e6f5; padding: 1px 7px; border-radius: 4px; font-size: 11px; }
      .ext { font-size: 9px; color: #946; border: 1px solid #d9bcd0; border-radius: 8px; padding: 0 5px; margin-left: 4px; }
      .foot { padding: 10px 14px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 9px; }
      button.act { font-size: 13px; padding: 7px 13px; border-radius: 7px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
      button.act.primary { background: #1a5fb4; color: #fff; border-color: #1a5fb4; } button.act:hover { filter: brightness(.97); }
    `;
    root.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'backdrop';
    wrap.innerHTML = `
      <div class="card" role="dialog" aria-modal="true">
        <div class="head"><h2>RCPI link &amp; image check — course ${ou}</h2><span class="badge" data-badge>working…</span><button class="x" title="Close">×</button></div>
        <div class="meta" data-meta>Starting…</div>
        <div class="body"><div class="spin" data-stage>Loading topic list…</div></div>
        <div class="foot"><button class="act" data-close>Close</button></div>
      </div>`;
    root.appendChild(wrap);
    const close = () => { document.removeEventListener('keydown', onEsc); host.remove(); };
    function onEsc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onEsc);
    wrap.querySelector('.x').onclick = close;
    // Close button lives in the footer (static at mount); bind via delegation so it works regardless of render order
    wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });

    // Drag the panel by its header (header is the handle; the × is excluded)
    const card = wrap.querySelector('.card');
    const head = wrap.querySelector('.head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('.x')) return;
      const rect = card.getBoundingClientRect();
      const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
      card.style.left = rect.left + 'px';
      card.style.top = rect.top + 'px';
      card.style.right = 'auto';
      card.classList.add('dragging');
      const move = (ev) => {
        const w = card.offsetWidth;
        const left = Math.max(90 - w, Math.min(ev.clientX - dx, window.innerWidth - 90));   // keep header grabbable
        const top  = Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - 40));
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      };
      const up = () => { card.classList.remove('dragging'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
    });

    const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };

    return {
      setStage(txt) { const el = root.querySelector('[data-stage]'); if (el) el.textContent = txt; },
      finish(data) {
        const { results, pages, refs, authSeen } = data;
        const nFix = results.filter(r => r.action === 'FIX').length;
        const counts = results.reduce((m, r) => (m[r.action] = (m[r.action] || 0) + 1, m), {});
        root.querySelector('[data-badge]').textContent = nFix ? `${nFix} to fix` : (results.length ? 'review items' : 'all ok');
        root.querySelector('[data-meta]').textContent =
          `${pages} HTML pages · ${refs} refs checked · ` +
          (['FIX', 'REVIEW', 'LIKELY OK', 'INFO'].filter(k => counts[k]).map(k => `${k}=${counts[k]}`).join(' · ') || 'all ok') +
          (authSeen ? ' · some login bounces' : '');
        const body = root.querySelector('.body');
        if (!results.length) {
          body.innerHTML = `<div class="clear"><span class="big">✓</span>No broken links or images found in any content page.</div>`;
        } else {
          body.innerHTML = `
            <table>
              <tr><th>Action</th><th>State</th><th>Meaning</th><th>Type</th><th>Reference URL</th><th>On page</th></tr>
              ${results.map(r => `
                <tr>
                  <td><span class="act-${esc(r.action.replace(/ /g, '-'))}">${esc(r.action)}</span></td>
                  <td><span class="pill s-${esc(r.state)}">${esc(r.state)}${r.status ? ' ' + r.status : ''}</span></td>
                  <td class="k">${esc(r.meaning)}</td>
                  <td class="k">${esc(r.kind)}</td>
                  <td class="url"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a>${r.external ? '<span class="ext">ext</span>' : ''}</td>
                  <td class="url"><a href="${esc(r.pageLink)}" target="_blank">${esc(r.pageTitle)}</a>${r.frame ? '<span class="ext" title="' + esc(r.frame) + '">in embed</span>' : ''}</td>
                </tr>`).join('')}
            </table>`;
        }
        const foot = root.querySelector('.foot');
        if (results.length && !foot.querySelector('[data-dl]')) {
          const btn = document.createElement('button');
          btn.className = 'act primary'; btn.setAttribute('data-dl', '1'); btn.textContent = 'Download report (CSV)';
          btn.onclick = () => {
            const head = ['state', 'status', 'meaning', 'action', 'reference_url', 'course_page', 'type', 'external', 'as_written', 'on_page_title', 'found_in_frame'];
            const rows = [head, ...results.map(r => [r.state, r.status, r.meaning, r.action, r.url, r.pageLink, r.kind, r.external, r.raw, r.pageTitle, r.frame])];
            const csv = rows.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
            const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
            const ts = new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
            const a = Object.assign(document.createElement('a'), { href: url, download: `rcpi-linkcheck_ou${data.ou}_${ts}.csv` });
            document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          };
          foot.insertBefore(btn, foot.firstChild.nextSibling);
        }
      },
    };
  }

  run();
})();