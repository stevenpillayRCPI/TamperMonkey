// ==UserScript==
// @name         RCPI Brightspace – File Store Audit (suspicious names + orphan HTML)
// @namespace    rcpi-content-audit
// @description  Walks the whole course file store (Manage Files), flags suspicious filenames (Untitled*, Copy, New Document, generic defaults) and HTML pages linked by no topic. On-page report + CSV.
// @match        https://brightspace.rcpi.ie/d2l/*
// @version      1.0
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  // ---- Config: tune these freely ----
  const MAX_CALLS = 1500;                       // safety cap on folder/listing requests
  const SUSPICIOUS = [
    { label: 'Untitled',        re: /^untitled[\s._-]*\d*/i },
    { label: 'Copy',            re: /(-copy|\bcopy of\b| - copy|\((\d+)\)|_copy)/i },
    { label: 'New document',    re: /^new[\s._-]*(document|page|html|file)/i },
    { label: 'Generic default', re: /^(overview|summary|introduction|intro|index|home|default|content|page|document|template|welcome|untitled)\.html?$/i },
  ];

  // ---- Resolve course id (URL, then page scan), then exit silently if not found ----
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
  let ou = null;
  for (let i = 0; i < 14 && !ou; i++) { ou = ouFromUrl() || ouFromDom(); if (!ou) await new Promise(r => setTimeout(r, 300)); }
  if (!ou) return;

  const get = (path) =>
    fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : Promise.reject(`${r.status} on ${path}`)));

  const lpVersions = ['1.74', '1.67', '1.50', '1.43'];
  const leVersions = ['1.74', '1.67', '1.50', '1.30'];

  // ---- 1. Find an LP version whose Manage Files route works here ----
  async function findLp() {
    for (const v of lpVersions) {
      try {
        const r = await get(`/d2l/api/lp/${v}/${ou}/managefiles/structure/?path=%2F`);
        if (r && (Array.isArray(r) || r.Items || r.Objects || r.PagingInfo)) return v;
      } catch (_) {}
    }
    return null;
  }
  const lpV = await findLp();

  // ---- 2. Walk the file store recursively (handles paging + subfolders) ----
  let calls = 0;
  async function listDir(path) {
    let items = [], bookmark = null, guard = 0;
    do {
      if (calls++ > MAX_CALLS) break;
      const u = `/d2l/api/lp/${lpV}/${ou}/managefiles/structure/?path=${encodeURIComponent(path)}`
              + (bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : '');
      let resp; try { resp = await get(u); } catch (_) { break; }
      items = items.concat(Array.isArray(resp) ? resp : (resp.Items || resp.Objects || []));
      const pg = Array.isArray(resp) ? null : resp.PagingInfo;
      bookmark = pg && pg.HasMoreItems ? pg.Bookmark : null;
    } while (bookmark && ++guard < 80);
    return items;
  }
  async function walkStore() {
    const files = [];
    async function rec(path) {
      if (calls > MAX_CALLS) return;
      for (const it of await listDir(path)) {
        const name = it.Name || it.FileName || '';
        if (!name) continue;
        const type = String(it.Type ?? '').toLowerCase();
        const isDir = type.startsWith('dir') || type === 'folder' || it.Type === 0
                   || (!/\.[a-z0-9]{1,6}$/i.test(name) && it.Size == null);
        const child = (path === '/' ? '' : path) + '/' + name;
        if (isDir) await rec(child);
        else files.push({ relPath: child, name, modified: it.LastModified || it.LastModifiedDate || null, size: it.Size ?? null });
      }
    }
    await rec('/');
    return files;
  }

  // ---- 3. Linked topics (le content) → map of content-relative paths in active use ----
  async function linkedPaths() {
    const linked = new Map();   // lowercased relPath -> count of topics
    for (const v of leVersions) {
      for (const route of ['content/toc', 'content/root/']) {
        try {
          const data = await get(`/d2l/api/le/${v}/${ou}/${route}`);
          const flat = [];
          (function walk(n) {
            const x = Array.isArray(n) ? { Structure: n } : n;
            (x.Modules || []).forEach(walk);
            (x.Topics || []).forEach(t => flat.push(t));
            (x.Structure || []).forEach(s => (s.Type === 1 ? flat.push(s) : walk(s)));
          })(data);
          if (flat.length) {
            flat.forEach(t => {
              const url = (t.Url || '').split('?')[0];
              const m = url.match(/\/content\/enforced\/[^/]+\/(.+)$/i);
              if (m) { const k = ('/' + m[1]).toLowerCase(); linked.set(k, (linked.get(k) || 0) + 1); }
            });
            return linked;       // first route that yields topics wins
          }
        } catch (_) {}
      }
    }
    return linked;
  }

  // ---- 4. Run ----
  const files = lpV ? await walkStore() : [];
  const linked = await linkedPaths();
  const isHtml = (n) => /\.html?$/i.test(n);

  const rows = files.map(f => {
    const labels = SUSPICIOUS.filter(s => s.re.test(f.name)).map(s => s.label);
    const linkedCount = linked.get(f.relPath.toLowerCase()) || 0;
    const orphan = isHtml(f.name) && linkedCount === 0;
    return { ...f, labels, linkedCount, orphan, suspicious: labels.length > 0 };
  });
  const flagged = rows.filter(r => r.suspicious || r.orphan)
    .sort((a, b) =>
      ((b.orphan ? 2 : 0) + (b.suspicious ? 1 : 0)) - ((a.orphan ? 2 : 0) + (a.suspicious ? 1 : 0))
      || a.relPath.localeCompare(b.relPath));

  window.__rcpiFileAudit = { ou, lpVersion: lpV, files: rows, flagged, linkedCount: linked.size };

  // ---- 5. CSV ----
  function csv(list) {
    const head = ['relative_path', 'filename', 'flags', 'linked_by_topics', 'last_modified', 'size_bytes'];
    const body = list.map(r => [
      r.relPath, r.name,
      [r.orphan ? 'ORPHAN-HTML' : '', ...r.labels].filter(Boolean).join('; '),
      r.linkedCount, r.modified || '', r.size ?? ''
    ]);
    return [head, ...body].map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- 6. Modal ----
  document.getElementById('rcpi-fileaudit-host')?.remove();
  const host = document.createElement('div');
  host.id = 'rcpi-fileaudit-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const noAccess = lpV === null;
  const ok = !noAccess && flagged.length === 0;
  const headColor = noAccess ? '#8a6d00' : (ok ? '#1f7a3d' : '#b3301c');

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; width: min(780px, 95vw); max-height: 88vh; display: flex; flex-direction: column;
      border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,.3); overflow: hidden; }
    .head { padding: 9px 14px; color: #fff; display: flex; align-items: center; gap: 10px; background: ${headColor}; }
    .head h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .badge { background: rgba(255,255,255,.25); padding: 2px 9px; border-radius: 20px; font-size: 12px; }
    .x { cursor: pointer; font-size: 20px; line-height: 1; background: none; border: 0; color: #fff; opacity: .85; }
    .x:hover { opacity: 1; }
    .meta { padding: 6px 14px; font-size: 11px; color: #666; border-bottom: 1px solid #eee; }
    .body { padding: 6px 14px 12px; overflow: auto; }
    .notice { padding: 18px 6px; font-size: 13px; color: #555; line-height: 1.5; }
    .clear { text-align: center; padding: 22px 10px; color: #1f7a3d; font-size: 14px; }
    .clear .big { font-size: 34px; display: block; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 4px 8px; border-top: 1px solid #f1f1f1; vertical-align: top; }
    th { color: #777; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; position: sticky; top: 0; background: #fff; }
    td.path { color: #888; font-size: 10.5px; word-break: break-all; }
    .pill { font-size: 10px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; margin-right: 3px; display: inline-block; }
    .pill.orphan { background: #f3c2bb; color: #7a1a0c; font-weight: 600; }
    .pill.susp { background: #fde9a8; color: #6b4e00; }
    .foot { padding: 10px 14px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 9px; }
    button.act { font-size: 13px; padding: 7px 13px; border-radius: 7px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
    button.act.primary { background: #1a5fb4; color: #fff; border-color: #1a5fb4; }
    button.act:hover { filter: brightness(.97); }
  `;
  root.appendChild(style);

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
  const fmtDate = (s) => s ? esc(String(s).replace('T', ' ').replace(/\..*/, '')) : '—';
  const fmtSize = (n) => n == null ? '—' : (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  let bodyHtml;
  if (noAccess) {
    bodyHtml = `<div class="notice">Couldn't read the file store. The Manage Files API route is either disabled for this tenant or your account lacks the <b>Manage Files</b> permission in this course. Nothing was changed.</div>`;
  } else if (ok) {
    bodyHtml = `<div class="clear"><span class="big">✓</span>No suspicious filenames and no unlinked HTML pages found in the file store.</div>`;
  } else {
    bodyHtml = `
      <table>
        <tr><th>Flags</th><th>File</th><th>Path</th><th>Linked by</th><th>Modified</th><th>Size</th></tr>
        ${flagged.map(r => `
          <tr>
            <td>${r.orphan ? '<span class="pill orphan">orphan HTML</span>' : ''}${r.labels.map(l => `<span class="pill susp">${esc(l)}</span>`).join('')}</td>
            <td>${esc(r.name)}</td>
            <td class="path">${esc(r.relPath)}</td>
            <td>${r.linkedCount}</td>
            <td>${fmtDate(r.modified)}</td>
            <td>${fmtSize(r.size)}</td>
          </tr>`).join('')}
      </table>`;
  }

  const wrap = document.createElement('div');
  wrap.className = 'backdrop';
  wrap.innerHTML = `
    <div class="card" role="dialog" aria-modal="true">
      <div class="head">
        <h2>RCPI file store audit — course ${ou}</h2>
        <span class="badge">${noAccess ? 'No access' : (ok ? 'All clear' : flagged.length + ' flagged')}</span>
        <button class="x" title="Close">×</button>
      </div>
      <div class="meta">${noAccess ? 'Manage Files unavailable' :
        `${files.length} files scanned (LP v${lpV}) · ${flagged.filter(f => f.orphan).length} orphan HTML · ${flagged.filter(f => f.suspicious).length} suspicious names`}${calls > MAX_CALLS ? ' · ⚠ hit scan cap, results partial' : ''}</div>
      <div class="body">${bodyHtml}</div>
      <div class="foot">
        <button class="act" data-close>Close</button>
        ${noAccess ? '' : `<button class="act" data-all>Download all files (CSV)</button>
        <button class="act primary" data-flagged>Download flagged (CSV)</button>`}
      </div>
    </div>`;
  root.appendChild(wrap);

  const close = () => host.remove();
  wrap.querySelector('.x').onclick = close;
  wrap.querySelector('[data-close]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
  wrap.querySelector('[data-flagged]')?.addEventListener('click', () => download(`rcpi-filestore-flagged-${ou}.csv`, csv(flagged)));
  wrap.querySelector('[data-all]')?.addEventListener('click', () => download(`rcpi-filestore-all-${ou}.csv`, csv(rows)));
})();