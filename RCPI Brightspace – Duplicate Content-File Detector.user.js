// ==UserScript==
// @name         RCPI Brightspace – Duplicate Content-File Detector
// @namespace    rcpi-content-audit
// @description  Finds nav objects (topics) in a single course that point at the same content file (e.g. Untitled.html clobbered by an import). Compact on-page report; highlights clashes where titles differ; optional CSV download.
// @match        https://brightspace.rcpi.ie/d2l/*
// @version      2.4
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  const DIVERGENCE_FLAG = 0.5;   // groups with title divergence >= this get the "titles differ" flag

  // ---- 1. Resolve the course id: URL first, then scan the page, retrying while the SPA settles ----
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
    const html = document.documentElement.innerHTML;
    const m = html.match(/[?&]ou=(\d+)/) || html.match(/"orgUnitId"\s*:\s*"?(\d+)/i);
    return m ? m[1] : null;
  }
  async function resolveOu() {
    for (let i = 0; i < 14; i++) {
      const v = ouFromUrl() || ouFromDom();
      if (v) return v;
      await new Promise(r => setTimeout(r, 300));
    }
    return null;
  }
  const ou = await resolveOu();
  if (!ou) return;                             // can't detect the course — do nothing, no popup

  const get = (path) =>
    fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(`${r.status} on ${path}`)));

  // ---- 2. Find a supported LE API version ----
  let version = '1.74';
  try {
    const v = await get('/d2l/api/le/versions/');
    version = v?.LatestVersion || (Array.isArray(v) && v.at(-1)?.LatestVersion) || version;
  } catch (_) {}
  const versionsToTry = [...new Set([version, '1.74', '1.67', '1.50', '1.30'])];

  // ---- 3. Pull the whole content tree (try toc, fall back to root) ----
  async function pullTree() {
    for (const v of versionsToTry) {
      for (const route of ['content/toc', 'content/root/']) {
        try {
          const data = await get(`/d2l/api/le/${v}/${ou}/${route}`);
          const flat = [];
          (function walk(node) {
            const n = Array.isArray(node) ? { Structure: node } : node;
            (n.Modules || []).forEach(walk);
            (n.Topics  || []).forEach(t => flat.push(t));
            (n.Structure || []).forEach(s => (s.Type === 1 ? flat.push(s) : walk(s)));
          })(data);
          if (flat.length) return { v, route, flat };
        } catch (_) {}
      }
    }
    return { flat: [] };
  }

  const { v, route, flat } = await pullTree();
  if (!flat.length) { alert('Content API returned no topics. Course may be empty, or you lack Manage Content rights here.'); return; }

  // ---- 4. Normalise; drop quicklinks ----
  const isQuicklink = (s) => /quicklink/i.test(s || '');
  const norm = flat.map(t => {
    const id   = t.TopicId ?? t.Id;
    const url  = t.Url || null;
    const file = url ? url.split('?')[0] : null;
    const name = file ? file.split('/').pop() : null;
    return {
      id, title: t.Title || '(untitled)', file, filename: name,
      key: file ? file.toLowerCase() : null,
      modified: t.LastModifiedDate || null,
      broken: t.IsBroken === true,
      isPackage: t.TopicType === 7 || /scorm|lms_?package|\/zip\//i.test(file || '') || /\.zip$/i.test(name || ''),
      link: `${location.origin}/d2l/le/lessons/${ou}/topics/${id}`
    };
  }).filter(t => !isQuicklink(t.key) && !isQuicklink(t.filename));

  // ---- 4b. Actively confirm each linked file resolves (catches dead links the API doesn't flag) ----
  async function confirmLiveness(list) {
    const targets = list.filter(t => t.key && !t.isPackage && !t.broken);
    let i = 0, authBounced = false;
    async function worker() {
      while (i < targets.length) {
        const t = targets[i++];
        try {
          let r = await fetch(t.file, { method: 'HEAD', credentials: 'include' });
          if (r.status === 405 || r.status === 501)
            r = await fetch(t.file, { method: 'GET', credentials: 'include', headers: { Range: 'bytes=0-0' } });
          if (/\/d2l\/login/i.test(r.url)) { authBounced = true; continue; }  // session bounce, not a content 404
          if (r.status >= 400) t.broken = true;
        } catch (_) { t.broken = true; }
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker));
    return { probed: targets.length, authBounced };
  }
  const probe = await confirmLiveness(norm);

  // ---- 5. Title-divergence helpers ----
  const toks = (s) => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean));
  function jaccard(a, b) {
    const A = toks(a), B = toks(b);
    if (!A.size && !B.size) return 1;
    let inter = 0; A.forEach(x => B.has(x) && inter++);
    const uni = A.size + B.size - inter;
    return uni ? inter / uni : 1;
  }
  function divergence(list) {                 // worst pairwise (1 - similarity)
    let worst = 0;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        worst = Math.max(worst, 1 - jaccard(list[i].title, list[j].title));
    return worst;
  }

  // ---- 6. Group file-backed topics by target file ----
  const groups = {};
  norm.filter(t => t.key).forEach(t => (groups[t.key] = groups[t.key] || []).push(t));
  const collisions = Object.values(groups)
    .filter(list => list.length > 1)
    .map(list => {
      const sorted = [...list].sort((a, b) =>
        (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0) || b.id - a.id);
      const d = divergence(sorted);
      return { list: sorted, divergence: d, differ: d >= DIVERGENCE_FLAG };
    })
    .sort((a, b) => (b.divergence - a.divergence) || (b.list.length - a.list.length));
  const broken = norm.filter(t => t.broken && t.key);

  window.__rcpiAudit = { ou, version: v, route, topics: norm, collisions, broken };

  // ---- 7. CSV ----
  function buildCsv() {
    const rows = [['type', 'course_ou', 'filename', 'full_path', 'topic_id', 'title', 'last_modified', 'broken', 'group_size', 'title_divergence_pct', 'link']];
    if (collisions.length || broken.length) {
      collisions.forEach(c => c.list.forEach(t =>
        rows.push(['collision', ou, t.filename, t.file, t.id, t.title, t.modified, t.broken, c.list.length, Math.round(c.divergence * 100), t.link])));
      broken.forEach(t => rows.push(['broken', ou, t.filename, t.file, t.id, t.title, t.modified, true, '', '', t.link]));
    } else {
      norm.filter(t => t.key).forEach(t => rows.push(['inventory', ou, t.filename, t.file, t.id, t.title, t.modified, t.broken, '', '', t.link]));
    }
    return rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  // ---- 8. Modal (Shadow DOM) ----
  document.getElementById('rcpi-audit-host')?.remove();
  const host = document.createElement('div');
  host.id = 'rcpi-audit-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const issues = collisions.length + broken.length;
  const ok = issues === 0;

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; width: min(680px, 94vw); max-height: 88vh; display: flex; flex-direction: column;
      border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,.3); overflow: hidden; }
    .head { padding: 9px 14px; color: #fff; display: flex; align-items: center; gap: 10px;
      background: ${ok ? '#1f7a3d' : '#b3301c'}; }
    .head h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .badge { background: rgba(255,255,255,.25); padding: 2px 9px; border-radius: 20px; font-size: 12px; }
    .x { cursor: pointer; font-size: 20px; line-height: 1; background: none; border: 0; color: #fff; opacity: .85; }
    .x:hover { opacity: 1; }
    .meta { padding: 6px 14px; font-size: 11px; color: #666; border-bottom: 1px solid #eee; }
    .body { padding: 4px 14px 12px; overflow: auto; }
    .group { border: 1px solid #e3e3e3; border-radius: 7px; margin-top: 8px; }
    .group.differ { border-color: #e0a0a0; border-left: 4px solid #b3301c; }
    .group > .file { padding: 6px 10px; background: #faf3f1; border-bottom: 1px solid #eee; border-radius: 6px 6px 0 0;
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .file .name { font-weight: 600; color: #b3301c; font-size: 13px; }
    .file .path { font-size: 10.5px; color: #888; word-break: break-all; flex-basis: 100%; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 4px 10px; border-top: 1px solid #f1f1f1; vertical-align: top; }
    th { color: #777; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
    .pill { font-size: 10px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; }
    .pill.new { background: #fde9a8; color: #6b4e00; }
    .pill.diff { background: #f3c2bb; color: #7a1a0c; font-weight: 600; }
    .pill.brk { background: #f3c2bb; color: #7a1a0c; }
    a { color: #1a5fb4; }
    .clear { text-align: center; padding: 22px 10px; color: #1f7a3d; font-size: 14px; }
    .clear .big { font-size: 34px; display: block; margin-bottom: 6px; }
    .sec { margin-top: 14px; font-weight: 600; font-size: 12px; color: #b3301c; }
    .lead { margin: 8px 0 0; color: #333; font-size: 12.5px; }
    .foot { padding: 10px 14px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 9px; }
    button.act { font-size: 13px; padding: 7px 13px; border-radius: 7px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
    button.act.primary { background: #1a5fb4; color: #fff; border-color: #1a5fb4; }
    button.act:hover { filter: brightness(.97); }
  `;
  root.appendChild(style);

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
  const fmtDate = (s) => s ? esc(s.replace('T', ' ').replace(/\..*/, '')) : '—';
  const topicRows = (list) => `
    <table>
      <tr><th></th><th>Topic ID</th><th>Title</th><th>Last modified</th><th></th></tr>
      ${list.map((t, i) => `
        <tr>
          <td>${i === 0 && list.length > 1 ? '<span class="pill new">newest</span>' : ''}</td>
          <td>${t.id}</td>
          <td>${esc(t.title)}${t.broken ? ' <span class="pill brk">broken</span>' : ''}</td>
          <td>${fmtDate(t.modified)}</td>
          <td><a href="${t.link}" target="_blank">open</a></td>
        </tr>`).join('')}
    </table>`;

  const bodyHtml = ok
    ? `<div class="clear"><span class="big">✓</span>No two nav objects point at the same file, and no broken topics found.</div>`
    : `
      ${collisions.length ? `<p class="lead">${collisions.length} file(s) targeted by more than one nav object (most-divergent titles first):</p>` : ''}
      ${collisions.map(c => `
        <div class="group${c.differ ? ' differ' : ''}">
          <div class="file">
            <span class="name">${esc(c.list[0].filename)}</span>
            ${c.differ ? `<span class="pill diff">⚠ titles differ (${Math.round(c.divergence * 100)}%)</span>` : ''}
            <span class="path">${esc(c.list[0].file)} — ${c.list.length} topics</span>
          </div>
          ${topicRows(c.list)}
        </div>`).join('')}
      ${broken.length ? `<div class="sec">${broken.length} broken topic(s) — dead file reference:</div>
        <div class="group">${topicRows(broken)}</div>` : ''}
    `;

  const wrap = document.createElement('div');
  wrap.className = 'backdrop';
  wrap.innerHTML = `
    <div class="card" role="dialog" aria-modal="true">
      <div class="head">
        <h2>RCPI content audit — course ${ou}</h2>
        <span class="badge">${ok ? 'All clear' : issues + ' issue' + (issues === 1 ? '' : 's')}</span>
        <button class="x" title="Close">×</button>
      </div>
      <div class="meta">Scanned ${norm.length} topics (${norm.filter(t => t.key).length} file-backed, quicklinks ignored) · ${probe.probed} links checked · API v${v} · ${route}${probe.authBounced ? ' · ⚠ some links bounced to login (session); re-run if needed' : ''}</div>
      <div class="body">${bodyHtml}</div>
      <div class="foot">
        <button class="act" data-close>Close</button>
        <button class="act primary" data-dl>${ok ? 'Download full inventory' : 'Download report (CSV)'}</button>
      </div>
    </div>`;
  root.appendChild(wrap);

  const close = () => host.remove();
  wrap.querySelector('.x').onclick = close;
  wrap.querySelector('[data-close]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });

  wrap.querySelector('[data-dl]').onclick = () => {
    const url = URL.createObjectURL(new Blob([buildCsv()], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `rcpi-audit-${ou}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();