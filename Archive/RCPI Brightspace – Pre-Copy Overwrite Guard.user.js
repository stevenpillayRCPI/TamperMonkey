// ==UserScript==
// @name         RCPI Brightspace – Pre-Copy Overwrite Guard
// @namespace    rcpi-content-audit
// @description  On the Import/Export/Copy Components pages: as soon as a SOURCE (sending) course is chosen, compares its course-file paths against the TARGET (receiving) course and warns about files that would be overwritten. Tiers hits into "overwrites a LIVE topic" vs "overwrites a stored file". Slim bottom banner fires ASAP; click for detail + CSV. Companion to the v2.x single-course duplicate-file detector.
// @match        https://brightspace.rcpi.ie/d2l/lms/importExport/*
// @version      1.1
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- config ----------------
  const TTL_MS = 15 * 60 * 1000;
  const AUTO_OPEN_ON_LIVE = true;
  const CASE_INSENSITIVE = true;

  // ---------------- tiny helpers ----------------
  const qs    = (n) => new URLSearchParams(location.search).get(n);
  const field = (n) => document.querySelector(`[name="${n}"]`)?.value || null;
  const lc    = (s) => (CASE_INSENSITIVE ? String(s).toLowerCase() : String(s));

  const apiGet = (path) =>
    fetch(path, { credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (r) => ({ ok: r.ok, status: r.status, body: r.ok ? await r.json().catch(() => null) : null }));

  const ENFORCED = /^\/content\/enforced\/\d+-[^/]+\//i;
  const topicRel = (u) => '/' + String(u).replace(ENFORCED, '').replace(/^\/+/, '');

  // ---------------- API version resolution (cached) ----------------
  let _lp, _le;
  async function lpVersion() {
    if (_lp) return _lp;
    _lp = '1.60';
    try { const j = await apiGet('/d2l/api/lp/versions/');
      if (j.ok) _lp = j.body?.LatestVersion || (Array.isArray(j.body) && j.body.at(-1)?.LatestVersion) || _lp; } catch {}
    return _lp;
  }
  async function leVersion() {
    if (_le) return _le;
    _le = '1.74';
    try { const j = await apiGet('/d2l/api/le/versions/');
      if (j.ok) _le = j.body?.LatestVersion || (Array.isArray(j.body) && j.body.at(-1)?.LatestVersion) || _le; } catch {}
    return _le;
  }

  // ---------------- walkers ----------------
  // FIX 1: strip leading slash from rel before encoding to avoid %2F prefix rejection
  async function walkFiles(ou) {
    const lp = await lpVersion();
    const files = []; let denied = null;
    async function list(rel) {
      const cleanRel = rel ? rel.replace(/^\/+/, '') : '';
      let url = `/d2l/api/lp/${lp}/${ou}/managefiles/` + (cleanRel ? `?path=${encodeURIComponent(cleanRel)}` : '');
      while (url) {
        const res = await apiGet(url);
        if (!res.ok) { if (!denied) denied = String(res.status); return; }
        for (const it of (res.body?.Objects || [])) {
          const full = (cleanRel ? cleanRel : '') + '/' + it.Name;
          if (it.FileSystemObjectType === 1) await list(full);
          else files.push('/' + full.replace(/^\/+/, ''));
        }
        const n = res.body?.Next;
        url = n ? (/^https?:/.test(n) ? n : location.origin + n) : null;
      }
    }
    await list('');
    return { files, denied };
  }

  async function walkTopics(ou) {
    const le = await leVersion();
    const out = [];
    let r = await apiGet(`/d2l/api/le/${le}/${ou}/content/toc`);
    if (!r.ok) r = await apiGet(`/d2l/api/le/${le}/${ou}/content/root/`);
    if (!r.ok) return { topics: out, denied: String(r.status) };
    (function w(node) {
      const n = Array.isArray(node) ? { Structure: node } : node;
      (n.Modules || []).forEach(w);
      (n.Topics || []).forEach((t) => {
        const id = t.TopicId ?? t.Id, url = t.Url;
        if (url) out.push({ id, title: t.Title || '(untitled)', url });
      });
      (n.Structure || []).forEach((s) => (s.Type === 1 && s.Url
        ? out.push({ id: s.TopicId ?? s.Id, title: s.Title || '(untitled)', url: s.Url })
        : w(s)));
    })(r.body);
    return { topics: out, denied: null };
  }

  function extractRefs(html, baseUrlPath, enforcedRe) {
    const out = new Set();
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { return out; }
    const base = location.origin + baseUrlPath;
    const add = (raw) => {
      if (!raw) return;
      raw = raw.trim();
      if (!raw || /^(#|mailto:|javascript:|data:|tel:)/i.test(raw)) return;
      let abs;
      try { abs = decodeURIComponent(new URL(raw, base).pathname); } catch { return; }
      if (!enforcedRe.test(abs) || /\/d2l\//i.test(abs)) return;
      out.add('/' + abs.replace(enforcedRe, ''));
    };
    const attr = (sel, a) => doc.querySelectorAll(sel).forEach((el) => add(el.getAttribute(a)));
    attr('img[src]', 'src'); attr('source[src]', 'src'); attr('video[src]', 'src'); attr('audio[src]', 'src');
    attr('script[src]', 'src'); attr('iframe[src]', 'src'); attr('embed[src]', 'src'); attr('object[data]', 'data');
    attr('link[href]', 'href'); attr('a[href]', 'href');
    doc.querySelectorAll('img[srcset],source[srcset]').forEach((el) =>
      (el.getAttribute('srcset') || '').split(',').forEach((s) => add(s.trim().split(/\s+/)[0])));
    const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    const scanCss = (s) => { let m; while ((m = urlRe.exec(s || ''))) add(m[1]); };
    doc.querySelectorAll('[style]').forEach((el) => scanCss(el.getAttribute('style')));
    doc.querySelectorAll('style').forEach((el) => scanCss(el.textContent));
    return out;
  }

  async function buildTargetEmbedMap(ou, topics) {
    const htmlTopics = topics.filter((t) => /\.html?(\?|$)/i.test(t.url) && !/\/d2l\//i.test(t.url));
    const enforcedRe = new RegExp(`^/content/enforced/${ou}-[^/]+/`, 'i');
    const map = new Map();
    let i = 0;
    async function worker() {
      while (i < htmlTopics.length) {
        const t = htmlTopics[i++];
        let html;
        try {
          const r = await fetch(location.origin + t.url, { credentials: 'include', cache: 'no-store' });
          if (!r.ok || /\/d2l\/login/i.test(r.url)) continue;
          html = await r.text();
        } catch { continue; }
        for (const rel of extractRefs(html, t.url, enforcedRe)) {
          const k = lc(rel);
          if (!map.has(k)) map.set(k, new Map());
          map.get(k).set(t.id, { id: t.id, title: t.title });
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    const out = new Map();
    for (const [k, m] of map) out.set(k, [...m.values()]);
    return out;
  }

  // ---------------- session cache ----------------
  function cacheGet(k) { try { const j = JSON.parse(sessionStorage.getItem(k)); if (j && Date.now() - j.ts < TTL_MS) return j.v; } catch {} return null; }
  function cacheSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify({ ts: Date.now(), v })); } catch {} }

  async function gather(ou, useCache) {
    const fk = `rcpiOwFiles_${ou}`, tk = `rcpiOwTopics_${ou}`;
    let f = useCache ? cacheGet(fk) : null;
    let t = useCache ? cacheGet(tk) : null;
    if (!f) { f = await walkFiles(ou);  if (useCache) cacheSet(fk, f); }
    if (!t) { t = await walkTopics(ou); if (useCache) cacheSet(tk, t); }
    return { ou, files: f.files, filesDenied: f.denied, topics: t.topics, topicsDenied: t.denied };
  }

  // ---------------- analysis ----------------
  function analyze(src, tgt) {
    const degradedSource = !!src.filesDenied;
    const degradedTarget = !!tgt.filesDenied;

    const srcPaths = degradedSource ? src.topics.map((t) => topicRel(t.url)) : src.files;
    const tgtPaths = degradedTarget ? tgt.topics.map((t) => topicRel(t.url)) : tgt.files;

    const tgtSet = new Set(tgtPaths.map(lc));
    const overwrite = srcPaths.filter((p) => tgtSet.has(lc(p)));

    const topicMap = new Map();
    tgt.topics.forEach((t) => topicMap.set(lc(topicRel(t.url)), { id: t.id, title: t.title, url: t.url }));

    const rows = [...new Set(overwrite.map(lc))].map((k) => {
      const original = overwrite.find((p) => lc(p) === k);
      return { path: original, topic: topicMap.get(k) || null, embeds: [] };
    }).sort((a, b) => a.path.localeCompare(b.path));

    const res = {
      source: src.ou, target: tgt.ou,
      sourceCount: srcPaths.length, targetCount: tgtPaths.length,
      degradedSource, degradedTarget,
      scannedAt: new Date().toLocaleTimeString(),
      rows, embedsChecked: false, embedsChecking: false,
    };
    return retier(res);
  }

  function retier(res) {
    res.tier1 = res.rows.filter((r) => r.topic);
    res.tierEmbed = res.rows.filter((r) => !r.topic && r.embeds && r.embeds.length);
    res.tier2 = res.rows.filter((r) => !r.topic && (!r.embeds || !r.embeds.length));
    res.liveCount = res.tier1.length + res.tierEmbed.length;
    res.total = res.rows.length;
    return res;
  }

  function applyEmbeds(res, embedMap) {
    res.rows.forEach((r) => { if (!r.topic) r.embeds = embedMap.get(lc(r.path)) || []; });
    res.embedsChecked = true;
    return retier(res);
  }

  // ---------------- CSV ----------------
  function buildCsv(res) {
    const rows = [['tier', 'source_ou', 'target_ou', 'path', 'target_topic_id', 'target_topic_title', 'shown_on_target_pages', 'link']];
    res.tier1.forEach((r) => rows.push(['live-topic', res.source, res.target, r.path, r.topic.id, r.topic.title, '', `${location.origin}/d2l/le/lessons/${res.target}/topics/${r.topic.id}`]));
    (res.tierEmbed || []).forEach((r) => rows.push(['live-asset', res.source, res.target, r.path, '', '', r.embeds.map((e) => e.title).join(' | '), '']));
    res.tier2.forEach((r) => rows.push(['stored-file', res.source, res.target, r.path, '', '', '', '']));
    return rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  // ---------------- UI (Shadow DOM) ----------------
  function hostEl() {
    let host = document.getElementById('rcpi-ow-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'rcpi-ow-host';
      document.body.appendChild(host);
      host.attachShadow({ mode: 'open' });
    }
    return host;
  }
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };

  const BASE_CSS = `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647; padding: 9px 16px;
      display: flex; align-items: center; gap: 12px; color: #fff; font-size: 13px;
      box-shadow: 0 -2px 10px rgba(0,0,0,.25); }
    .bar.checking { background: #555; } .bar.clean { background: #1f7a3d; }
    .bar.warn { background: #b3301c; } .bar.error { background: #7a1a0c; }
    .bar .msg { flex: 1; } .bar .msg b { font-weight: 700; }
    .bar .sp { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.4);
      border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .bar button { font-size: 12px; padding: 5px 11px; border-radius: 6px; border: 1px solid rgba(255,255,255,.5);
      background: rgba(255,255,255,.15); color: #fff; cursor: pointer; }
    .bar button:hover { background: rgba(255,255,255,.28); }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; width: min(720px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
      border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,.3); overflow: hidden; }
    .head { padding: 9px 14px; color: #fff; display: flex; align-items: center; gap: 10px; }
    .head h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .head .badge { background: rgba(255,255,255,.25); padding: 2px 9px; border-radius: 20px; font-size: 12px; }
    .head .x { cursor: pointer; font-size: 20px; line-height: 1; background: none; border: 0; color: #fff; opacity: .85; }
    .head .x:hover { opacity: 1; }
    .meta { padding: 6px 14px; font-size: 11px; color: #666; border-bottom: 1px solid #eee; line-height: 1.5; }
    .body { padding: 4px 14px 12px; overflow: auto; }
    .sec { margin-top: 14px; font-weight: 700; font-size: 12px; }
    .sec.hi { color: #b3301c; } .sec.lo { color: #6b4e00; }
    .lead { margin: 8px 0 0; color: #333; font-size: 12.5px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    th, td { text-align: left; padding: 4px 10px; border-top: 1px solid #f1f1f1; vertical-align: top; word-break: break-all; }
    th { color: #777; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
    .pill { font-size: 10px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; }
    .pill.live { background: #f3c2bb; color: #7a1a0c; font-weight: 600; }
    a { color: #1a5fb4; }
    .clear { text-align: center; padding: 22px 10px; color: #1f7a3d; font-size: 14px; }
    .clear .big { font-size: 34px; display: block; margin-bottom: 6px; }
    .foot { padding: 10px 14px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 9px; }
    button.act { font-size: 13px; padding: 7px 13px; border-radius: 7px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
    button.act.primary { background: #1a5fb4; color: #fff; border-color: #1a5fb4; }
    button.act:hover { filter: brightness(.97); }
  `;

  let lastResult = null, modalOpen = false;

  // FIX 3: reset modalOpen on every banner re-render to prevent stale-flag reopening
  function showBanner(opts) {
    modalOpen = false;
    const root = hostEl().shadowRoot;
    root.innerHTML = `<style>${BASE_CSS}</style>`;
    const bar = document.createElement('div');

    if (opts.state === 'checking') {
      bar.className = 'bar checking';
      bar.innerHTML = `<span class="sp"></span><div class="msg">Checking overwrite risk: course <b>${esc(opts.source)}</b> → <b>${esc(opts.target)}</b>…</div>
        <button data-x>Dismiss</button>`;
    } else if (opts.state === 'error') {
      bar.className = 'bar error';
      bar.innerHTML = `<div class="msg">Overwrite check failed: ${esc(opts.msg)}</div><button data-x>Dismiss</button>`;
    } else {
      const r = opts.result; lastResult = r;
      const total = r.total;
      if (total === 0) {
        bar.className = 'bar clean';
        bar.innerHTML = `<div class="msg">✓ No file overwrites: nothing in course <b>${esc(r.source)}</b> shares a path with <b>${esc(r.target)}</b>.</div>
          <button data-detail>Details</button><button data-rescan>Re-scan</button><button data-x>Dismiss</button>`;
      } else {
        bar.className = 'bar warn';
        const liveTxt = r.liveCount ? ` — <b>${r.liveCount}</b> would overwrite LIVE content` : '';
        const checking = r.embedsChecking ? ` <span class="sp"></span>checking associated files…` : '';
        bar.innerHTML = `<div class="msg">⚠ <b>${total}</b> file${total === 1 ? '' : 's'} from course <b>${esc(r.source)}</b> would overwrite <b>${esc(r.target)}</b>${liveTxt}.${checking}</div>
          <button data-detail>View ${total}</button><button data-rescan>Re-scan</button><button data-x>Dismiss</button>`;
      }
    }
    root.appendChild(bar);
    bar.querySelector('[data-x]')?.addEventListener('click', () => hostEl().remove());
    bar.querySelector('[data-detail]')?.addEventListener('click', () => lastResult && openModal(lastResult));
    bar.querySelector('[data-rescan]')?.addEventListener('click', rescan);
  }

  function rowTable(rows, kind, target) {
    const link = (id, label) => `<a href="${location.origin}/d2l/le/lessons/${target}/topics/${id}" target="_blank">${esc(label)}</a>`;
    const head = kind === 'topic' ? '<th>Path</th><th>Live topic</th><th></th>'
      : kind === 'embed' ? '<th>Path</th><th>Shown on live target page(s)</th>'
        : '<th>Path</th>';
    const body = rows.map((r) => {
      if (kind === 'topic') return `<tr><td>${esc(r.path)}</td>
        <td>${esc(r.topic.title)} <span class="pill live">live</span></td>
        <td>${link(r.topic.id, 'open')}</td></tr>`;
      if (kind === 'embed') return `<tr><td>${esc(r.path)}</td>
        <td>${r.embeds.map((e) => link(e.id, e.title)).join(', ')} <span class="pill live">live</span></td></tr>`;
      return `<tr><td>${esc(r.path)}</td></tr>`;
    }).join('');
    return `<table><tr>${head}</tr>${body}</table>`;
  }

  function openModal(r) {
    const root = hostEl().shadowRoot;
    root.querySelector('.backdrop')?.remove();
    modalOpen = true;
    const total = r.total;
    const danger = r.liveCount > 0;
    const headBg = total === 0 ? '#1f7a3d' : (danger ? '#b3301c' : '#9a6a00');

    const degraded = [];
    if (r.degradedSource) degraded.push('source files not readable (Manage Files denied) — comparison used source <i>topics</i> only, so pure asset overwrites may be missed');
    if (r.degradedTarget) degraded.push('target files not readable — comparison used target <i>topics</i> only');

    const wrap = document.createElement('div');
    wrap.className = 'backdrop';
    wrap.innerHTML = `
      <div class="card" role="dialog" aria-modal="true">
        <div class="head" style="background:${headBg}">
          <h2>Pre-copy overwrite — ${esc(r.source)} → ${esc(r.target)}</h2>
          <span class="badge">${total === 0 ? 'No overwrites' : total + ' file' + (total === 1 ? '' : 's')}</span>
          <button class="x" title="Close">×</button>
        </div>
        <div class="meta">
          Source ${esc(r.source)}: ${r.sourceCount} files · Target ${esc(r.target)}: ${r.targetCount} files · matched on relative path${CASE_INSENSITIVE ? ' (case-insensitive)' : ''} · scanned ${esc(r.scannedAt)}.<br>
          ⓘ Upper bound — actual overwrites depend on which components you select and the "Include associated files" option. "Live" = the file backs a target topic, or is embedded in one; detection is from static HTML, so assets pulled in dynamically (query-string configs, JS-loaded images) may still appear under stored files.
          ${degraded.length ? '<br>⚠ ' + degraded.join('; ') + '.' : ''}
        </div>
        <div class="body">
          ${total === 0
            ? `<div class="clear"><span class="big">✓</span>No shared file paths. Copying this source will not overwrite existing files in the target.</div>`
            : `
              ${r.tier1.length ? `<div class="sec hi">${r.tier1.length} overwrite a live target topic:</div>
                ${rowTable(r.tier1, 'topic', r.target)}` : ''}
              ${r.tierEmbed.length ? `<div class="sec hi">${r.tierEmbed.length} overwrite an asset shown on live target page(s):</div>
                ${rowTable(r.tierEmbed, 'embed', r.target)}` : ''}
              ${!r.embedsChecked && r.tier2.length ? `<p class="lead">Checking which stored files are shown on live target pages…</p>` : ''}
              ${r.tier2.length ? `<div class="sec lo">${r.tier2.length} overwrite stored files${r.embedsChecked ? ' (no live target page references them)' : ''}:</div>
                ${rowTable(r.tier2, 'stored', r.target)}` : ''}
            `}
        </div>
        <div class="foot">
          <button class="act" data-close>Close</button>
          <button class="act primary" data-dl>Download report (CSV)</button>
        </div>
      </div>`;
    root.appendChild(wrap);

    const close = () => { modalOpen = false; wrap.remove(); };
    wrap.querySelector('.x').onclick = close;
    wrap.querySelector('[data-close]').onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    wrap.querySelector('[data-dl]').onclick = () => {
      const url = URL.createObjectURL(new Blob([buildCsv(r)], { type: 'text/csv' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `rcpi-overwrite-${r.source}-to-${r.target}.csv` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }

  // ---------------- orchestration ----------------
  const TARGET = qs('ou');
  let lastSource = null, running = false;

  function rescan() {
    Object.keys(sessionStorage).filter((k) => k.startsWith('rcpiOw')).forEach((k) => sessionStorage.removeItem(k));
    lastSource = null;
    run();
  }

  // FIX 2: wire up the embed scan phase after the initial banner render
  async function run() {
    const SOURCE = field('selectedCourseId') || qs('courseId');
    if (!TARGET || !SOURCE || SOURCE === TARGET) return;
    if (SOURCE === lastSource || running) return;
    lastSource = SOURCE; running = true;
    showBanner({ state: 'checking', source: SOURCE, target: TARGET });
    try {
      const [s, t] = await Promise.all([gather(SOURCE, true), gather(TARGET, false)]);
      const result = analyze(s, t);

      // Phase 1: show initial banner immediately (tier1 known, tier2 not yet promoted)
      result.embedsChecking = result.tier2.length > 0;
      showBanner({ state: 'done', result });
      if (AUTO_OPEN_ON_LIVE && result.tier1.length) openModal(result);

      // Phase 2: asynchronously scan target HTML topics to promote tier2 assets into tierEmbed
      if (result.tier2.length) {
        buildTargetEmbedMap(t.ou, t.topics).then((embedMap) => {
          applyEmbeds(result, embedMap);
          result.embedsChecking = false;
          lastResult = result;
          showBanner({ state: 'done', result });
          // re-open modal if it was open during the embed scan
          if (modalOpen) openModal(result);
        }).catch(() => {
          result.embedsChecking = false;
          result.embedsChecked = true;
          showBanner({ state: 'done', result });
        });
      }
    } catch (e) {
      showBanner({ state: 'error', msg: String(e) });
      lastSource = null;
    } finally { running = false; }
  }

  run();

  const iv = setInterval(() => { const s = field('selectedCourseId'); if (s && s !== lastSource) run(); }, 1000);
  setTimeout(() => clearInterval(iv), 60000);

  try {
    new MutationObserver(() => { const s = field('selectedCourseId'); if (s && s !== lastSource) run(); })
      .observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();