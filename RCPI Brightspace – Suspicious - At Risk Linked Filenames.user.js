// ==UserScript==
// @name         RCPI Brightspace – Suspicious / At Risk Linked Filenames
// @namespace    rcpi-content-audit
// @description  Flags content topics whose linked file has a suspicious name (Untitled*, *Copy*, index/summary/overview/introduction, etc.). Content API only — no Manage Files. On-page report + CSV.
// @match        https://brightspace.rcpi.ie/d2l/*
// @version      1.0
// @grant        none
// ==/UserScript==

(async function () {
  'use strict';

  // ---- Config: tune freely ----
  const SUSPICIOUS = [
    { label: 'Untitled',        re: /^untitled/i },
    { label: 'Copy',            re: /(copy|\(\d+\)| - copy|_copy)/i },
    { label: 'New document',    re: /^new[\s._-]*(document|page|html|file)/i },
    { label: 'Generic default', re: /^(index|summary|overview|introduction|intro|home|default|content|page|document|template|welcome|untitled)\.html?$/i },
  ];

  // ---- Resolve course id (URL, then page scan); silent exit if not found ----
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

  // ---- Pull the content tree ----
  let version = '1.74';
  try { const v = await get('/d2l/api/le/versions/'); version = v?.LatestVersion || (Array.isArray(v) && v.at(-1)?.LatestVersion) || version; } catch (_) {}
  const versions = [...new Set([version, '1.74', '1.67', '1.50', '1.30'])];

  let flat = [], usedV = null;
  for (const v of versions) {
    for (const route of ['content/toc', 'content/root/']) {
      try {
        const data = await get(`/d2l/api/le/${v}/${ou}/${route}`);
        const acc = [];
        (function walk(n) {
          const x = Array.isArray(n) ? { Structure: n } : n;
          (x.Modules || []).forEach(walk);
          (x.Topics || []).forEach(t => acc.push(t));
          (x.Structure || []).forEach(s => (s.Type === 1 ? acc.push(s) : walk(s)));
        })(data);
        if (acc.length) { flat = acc; usedV = v; break; }
      } catch (_) {}
    }
    if (flat.length) break;
  }

  // ---- Normalise + match suspicious names ----
  const isQuicklink = (s) => /quicklink/i.test(s || '');
  const byFile = new Map();   // file path -> { filename, file, labels, topics:[...] }
  flat.forEach(t => {
    const id = t.TopicId ?? t.Id;
    const file = (t.Url || '').split('?')[0] || null;
    if (!file) return;
    const name = file.split('/').pop();
    if (isQuicklink(file) || isQuicklink(name)) return;
    const labels = SUSPICIOUS.filter(s => s.re.test(name)).map(s => s.label);
    if (!labels.length) return;
    const key = file.toLowerCase();
    if (!byFile.has(key)) byFile.set(key, { filename: name, file, labels, topics: [] });
    byFile.get(key).topics.push({
      id, title: t.Title || '(untitled)',
      modified: t.LastModifiedDate || null,
      link: `${location.origin}/d2l/le/lessons/${ou}/topics/${id}`
    });
  });
  const hits = [...byFile.values()].sort((a, b) => b.labels.length - a.labels.length || a.filename.localeCompare(b.filename));
  window.__rcpiSuspicious = { ou, version: usedV, hits };

  // ---- CSV ----
  function buildCsv() {
    const rows = [['filename', 'full_path', 'flags', 'topic_id', 'title', 'last_modified', 'link']];
    hits.forEach(h => h.topics.forEach(t =>
      rows.push([h.filename, h.file, h.labels.join('; '), t.id, t.title, t.modified || '', t.link])));
    return rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }
  function download() {
    const url = URL.createObjectURL(new Blob([buildCsv()], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `rcpi-suspicious-${ou}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Modal ----
  document.getElementById('rcpi-susp-host')?.remove();
  const host = document.createElement('div');
  host.id = 'rcpi-susp-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  const ok = hits.length === 0;

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483647; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; width: min(740px, 95vw); max-height: 88vh; display: flex; flex-direction: column; border-radius: 10px; box-shadow: 0 10px 34px rgba(0,0,0,.3); overflow: hidden; }
    .head { padding: 9px 14px; color: #fff; display: flex; align-items: center; gap: 10px; background: ${ok ? '#1f7a3d' : '#b3301c'}; }
    .head h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1; }
    .badge { background: rgba(255,255,255,.25); padding: 2px 9px; border-radius: 20px; font-size: 12px; }
    .x { cursor: pointer; font-size: 20px; line-height: 1; background: none; border: 0; color: #fff; opacity: .85; } .x:hover { opacity: 1; }
    .meta { padding: 6px 14px; font-size: 11px; color: #666; border-bottom: 1px solid #eee; }
    .body { padding: 6px 14px 12px; overflow: auto; }
    .clear { text-align: center; padding: 22px 10px; color: #1f7a3d; font-size: 14px; } .clear .big { font-size: 34px; display: block; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { text-align: left; padding: 5px 8px; border-top: 1px solid #f1f1f1; vertical-align: top; }
    th { color: #777; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; position: sticky; top: 0; background: #fff; }
    td.path { color: #888; font-size: 10.5px; word-break: break-all; }
    .pill { font-size: 10px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; margin-right: 3px; display: inline-block; background: #fde9a8; color: #6b4e00; }
    .topics a { color: #1a5fb4; text-decoration: none; } .topics a:hover { text-decoration: underline; }
    .topics .t { display: block; margin: 1px 0; }
    .foot { padding: 10px 14px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 9px; }
    button.act { font-size: 13px; padding: 7px 13px; border-radius: 7px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; }
    button.act.primary { background: #1a5fb4; color: #fff; border-color: #1a5fb4; } button.act:hover { filter: brightness(.97); }
  `;
  root.appendChild(style);

  const esc = (s) => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
  const fmtDate = (s) => s ? esc(String(s).replace('T', ' ').replace(/\..*/, '')) : '—';

  const bodyHtml = ok
    ? `<div class="clear"><span class="big">✓</span>No linked files match the suspicious-name patterns.</div>`
    : `<table>
        <tr><th>Flags</th><th>File</th><th>Path</th><th>Linked by (topics)</th></tr>
        ${hits.map(h => `
          <tr>
            <td>${h.labels.map(l => `<span class="pill">${esc(l)}</span>`).join('')}</td>
            <td>${esc(h.filename)}</td>
            <td class="path">${esc(h.file)}</td>
            <td class="topics">${h.topics.map(t => `<span class="t"><a href="${t.link}" target="_blank">${esc(t.title)}</a> <span style="color:#aaa">· ${fmtDate(t.modified)}</span></span>`).join('')}</td>
          </tr>`).join('')}
      </table>`;

  const wrap = document.createElement('div');
  wrap.className = 'backdrop';
  wrap.innerHTML = `
    <div class="card" role="dialog" aria-modal="true">
      <div class="head">
        <h2>RCPI suspicious / at risk filenames — course ${ou}</h2>
        <span class="badge">${ok ? 'All clear' : hits.length + ' file' + (hits.length === 1 ? '' : 's')}</span>
        <button class="x" title="Close">×</button>
      </div>
      <div class="meta">${flat.length} topics scanned${usedV ? ` · API v${usedV}` : ''} · ${hits.reduce((n, h) => n + h.topics.length, 0)} matching topics</div>
      <div class="body">${bodyHtml}</div>
      <div class="foot">
        <button class="act" data-close>Close</button>
        ${ok ? '' : '<button class="act primary" data-dl>Download report (CSV)</button>'}
      </div>
    </div>`;
  root.appendChild(wrap);

  const close = () => host.remove();
  wrap.querySelector('.x').onclick = close;
  wrap.querySelector('[data-close]').onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
  wrap.querySelector('[data-dl]')?.addEventListener('click', download);
})();