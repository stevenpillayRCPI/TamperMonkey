// ==UserScript==
// @name         Brightspace Topic ID Puller
// @namespace    rcpi-dlt
// @version      1.2
// @updateURL    https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/Brightspace%20Topic%20ID%20Puller.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/Brightspace%20Topic%20ID%20Puller.user.js
// @description  Pull topic IDs from a Brightspace course. Tick whole units/lessons, filter by keyword, copy IDs, export CSVs (including for the bulk completion tool).
// @match        *://*/d2l/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.top !== window.self) return; // don't run inside iframes

  const DEFAULT_KEYWORD = ''; // e.g. 'Summary' to pre-filter
  const FALLBACK_LE_VERSION = '1.67';

  // ---------- course id + API ----------
  function getOrgUnitId() {
    const m = location.pathname.match(/\/d2l\/(?:le\/content|le\/lessons|lms\/content\/[^/]+|home|le)\/(\d+)/i)
           || location.pathname.match(/\/(\d{3,})(?:\/|$)/);
    return m ? m[1] : null;
  }

  async function getVersion(code, fallback) {
    try {
      const r = await fetch('/d2l/api/versions/', { credentials: 'same-origin' });
      const list = await r.json();
      const p = list.find(x => x.ProductCode === code);
      if (p && p.LatestVersion) return p.LatestVersion;
    } catch (e) { /* fall through */ }
    return fallback;
  }
  const getLeVersion = () => getVersion('le', FALLBACK_LE_VERSION);

  async function whoAmI() {
    const v = await getVersion('lp', '1.43');
    const r = await fetch(`/d2l/api/lp/${v}/users/whoami`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).Identifier;
  }

  async function fetchToc(orgUnitId) {
    const ver = await getLeVersion();
    const r = await fetch(`/d2l/api/le/${ver}/${orgUnitId}/content/toc`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('TOC request failed: HTTP ' + r.status);
    return r.json();
  }

  // ---------- tree model ----------
  // node = { kind:'module'|'topic', title, id, children:[], el:{...}, parent }
  function buildTree(modules, parent) {
    return (modules || []).map(m => {
      const node = { kind: 'module', title: m.Title, id: m.ModuleId || m.Id, parent, children: [] };
      const subModules = buildTree(m.Modules, node);
      const topics = (m.Topics || []).map(t => ({
        kind: 'topic',
        title: t.Title,
        id: String(t.TopicId || t.Id),
        type: t.TypeIdentifier || '',
        parent: node,
        children: []
      }));
      // keep the order Brightspace uses: topics first, then sub-modules
      node.children = [...topics, ...subModules];
      return node;
    });
  }

  function leaves(node, out = []) {
    if (node.kind === 'topic') out.push(node);
    else node.children.forEach(c => leaves(c, out));
    return out;
  }

  function pathOf(node) {
    const parts = [];
    for (let n = node.parent; n; n = n.parent) parts.unshift(n.title);
    return parts;
  }

  // ---------- UI ----------
  let panel = null;
  let roots = [];
  let courseId = '';
  const selected = new Set(); // topic ids

  function css(el, s) { el.style.cssText = s; return el; }
  function make(tag, s, text) {
    const e = document.createElement(tag);
    if (s) e.style.cssText = s;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function addLauncher() {
    if (document.getElementById('rc-topicid-btn')) return;
    const b = make('button',
      'position:fixed;right:16px;bottom:16px;z-index:99998;padding:8px 14px;border:none;border-radius:20px;' +
      'background:#006fbf;color:#fff;font:600 13px sans-serif;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3);',
      'Topic IDs');
    b.id = 'rc-topicid-btn';
    b.addEventListener('click', openPanel);
    document.body.appendChild(b);
  }

  async function openPanel() {
    if (panel) { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; return; }

    panel = make('div',
      'position:fixed;right:16px;bottom:56px;width:460px;max-width:95vw;height:640px;max-height:85vh;z-index:99999;' +
      'background:#fff;color:#222;border:1px solid #888;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
      'display:flex;flex-direction:column;font:13px sans-serif;');
    document.body.appendChild(panel);

    // header
    const header = make('div', 'display:flex;align-items:center;padding:8px 10px;background:#f0f0f0;border-bottom:1px solid #ccc;border-radius:8px 8px 0 0;');
    header.appendChild(make('strong', 'flex:1;', 'Topic ID Puller'));
    const closeBtn = make('button', 'border:none;background:none;font-size:16px;cursor:pointer;', '✕');
    closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = make('div', 'padding:10px;overflow:auto;flex:1;');
    body.textContent = 'Loading course content…';
    panel.appendChild(body);

    let orgUnitId = getOrgUnitId();
    if (!orgUnitId) orgUnitId = prompt('Could not detect the course id from the URL. Enter the orgUnitId:');
    if (!orgUnitId) { body.textContent = 'No course id.'; return; }
    courseId = orgUnitId;

    let toc;
    try { toc = await fetchToc(orgUnitId); }
    catch (e) { body.textContent = 'Error: ' + e.message; return; }

    roots = buildTree(toc.Modules, null);
    body.textContent = '';
    buildPanelBody(body);
  }

  function buildPanelBody(body) {
    // --- controls row ---
    const controls = make('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;');

    const keyword = make('input', 'padding:3px 6px;border:1px solid #999;border-radius:4px;width:140px;');
    keyword.type = 'text';
    keyword.placeholder = 'keyword filter';
    keyword.value = DEFAULT_KEYWORD;

    const typeSel = make('select', 'padding:3px 6px;border:1px solid #999;border-radius:4px;');
    typeSel.innerHTML = '<option value="">All types</option>';
    [...new Set(roots.flatMap(r => leaves(r)).map(t => t.type).filter(Boolean))].sort()
      .forEach(t => { const o = document.createElement('option'); o.value = t; o.textContent = t; typeSel.appendChild(o); });

    const selAll = make('button', 'padding:3px 8px;cursor:pointer;', 'Select shown');
    const selNone = make('button', 'padding:3px 8px;cursor:pointer;', 'Clear');
    const expand = make('button', 'padding:3px 8px;cursor:pointer;', 'Expand all');
    const collapse = make('button', 'padding:3px 8px;cursor:pointer;', 'Collapse all');
    [keyword, typeSel, selAll, selNone, expand, collapse].forEach(e => controls.appendChild(e));
    body.appendChild(controls);

    // --- tree ---
    const treeBox = make('div', 'border:1px solid #ddd;border-radius:4px;padding:6px;max-height:300px;overflow:auto;');
    body.appendChild(treeBox);

    // --- output ---
    const outRow = make('div', 'display:flex;gap:6px;align-items:center;margin:8px 0 4px;');
    const fmt = make('select', 'padding:3px 6px;border:1px solid #999;border-radius:4px;');
    [['ids-line', 'IDs, comma-separated'],
     ['ids-lines', 'IDs, one per line'],
     ['tsv', 'Title ⇥ ID (paste to sheet)'],
     ['path-tsv', 'Unit ⇥ Lesson ⇥ Title ⇥ ID'],
     ['json', 'JSON']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; fmt.appendChild(o);
    });
    const countLbl = make('span', 'flex:1;color:#666;text-align:right;');
    const copyBtn = make('button', 'padding:3px 12px;cursor:pointer;font-weight:600;', 'Copy');
    const csvBtn = make('button', 'padding:3px 12px;cursor:pointer;font-weight:600;', 'Download CSV');
    csvBtn.title = 'Downloads the selected topics (or all topics matching the filter if none are selected)';
    outRow.appendChild(fmt); outRow.appendChild(countLbl); outRow.appendChild(csvBtn); outRow.appendChild(copyBtn);
    body.appendChild(outRow);

    const out = make('textarea', 'width:100%;height:110px;box-sizing:border-box;font:12px monospace;');
    out.readOnly = true;
    body.appendChild(out);

    // --- completion tool export (orgUnitId,topicId,userId,date) ---
    const compBox = make('div', 'margin-top:8px;padding:8px;border:1px solid #ddd;border-radius:4px;background:#fafafa;');
    compBox.appendChild(make('div', 'font-weight:600;margin-bottom:4px;', 'Completion tool CSV'));
    const compRow = make('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;');
    const userIds = make('input', 'padding:3px 6px;border:1px solid #999;border-radius:4px;flex:1;min-width:150px;');
    userIds.type = 'text';
    userIds.placeholder = 'D2L UserId(s), comma or space separated';
    try { userIds.value = localStorage.getItem('bsTopicIds.userIds') || ''; } catch (e) { /* ignore */ }
    const meBtn = make('button', 'padding:3px 8px;cursor:pointer;', 'Use my ID');
    const dateIn = make('input', 'padding:3px 6px;border:1px solid #999;border-radius:4px;');
    dateIn.type = 'date';
    dateIn.value = new Date().toISOString().slice(0, 10);
    const compBtn = make('button', 'padding:3px 12px;cursor:pointer;font-weight:600;', 'Download completion CSV');
    compBtn.title = 'One row per user × selected topic, with the headers the completion widget expects';
    [userIds, meBtn, dateIn, compBtn].forEach(e => compRow.appendChild(e));
    compBox.appendChild(compRow);
    body.appendChild(compBox);

    // ---------- tree rendering ----------
    const matches = t => {
      const k = keyword.value.trim().toLowerCase();
      return (!k || t.title.toLowerCase().includes(k)) && (!typeSel.value || t.type === typeSel.value);
    };
    const visibleLeaves = node => leaves(node).filter(matches);

    function render(node, container, depth) {
      if (node.kind === 'topic') {
        const row = make('label', `display:flex;align-items:center;gap:6px;padding:1px 0 1px ${depth * 16 + 18}px;cursor:pointer;`);
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          cb.checked ? selected.add(node.id) : selected.delete(node.id);
          refresh();
        });
        row.appendChild(cb);
        row.appendChild(make('span', '', node.title));
        if (node.type) row.appendChild(make('span', 'color:#888;font-size:11px;', node.type));
        node.el = { row, cb };
        container.appendChild(row);
        return;
      }

      const wrap = document.createElement('div');
      const head = make('div', `display:flex;align-items:center;gap:6px;padding:2px 0 2px ${depth * 16}px;font-weight:${depth === 0 ? 700 : 600};`);
      const arrow = make('span', 'cursor:pointer;width:12px;user-select:none;', '▸');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const title = make('span', 'cursor:pointer;', node.title);
      const cnt = make('span', 'color:#888;font-weight:400;font-size:11px;');
      head.appendChild(arrow); head.appendChild(cb); head.appendChild(title); head.appendChild(cnt);

      const kids = make('div', 'display:none;');
      node.children.forEach(c => render(c, kids, depth + 1));

      const toggle = () => {
        const open = kids.style.display === 'none';
        kids.style.display = open ? 'block' : 'none';
        arrow.textContent = open ? '▾' : '▸';
      };
      arrow.addEventListener('click', toggle);
      title.addEventListener('click', toggle);

      // ticking a module selects/deselects every matching topic beneath it
      cb.addEventListener('change', () => {
        visibleLeaves(node).forEach(t => cb.checked ? selected.add(t.id) : selected.delete(t.id));
        refresh();
      });

      node.el = { wrap, head, cb, cnt, kids, arrow, toggle };
      wrap.appendChild(head); wrap.appendChild(kids);
      container.appendChild(wrap);
    }

    // sync checkbox / visibility state; returns whether node is visible
    function sync(node) {
      if (node.kind === 'topic') {
        const vis = matches(node);
        node.el.row.style.display = vis ? 'flex' : 'none';
        node.el.cb.checked = selected.has(node.id);
        return vis;
      }
      let anyVisible = false;
      node.children.forEach(c => { if (sync(c)) anyVisible = true; });
      node.el.wrap.style.display = anyVisible ? 'block' : 'none';

      const vl = visibleLeaves(node);
      const n = vl.filter(t => selected.has(t.id)).length;
      node.el.cb.checked = vl.length > 0 && n === vl.length;
      node.el.cb.indeterminate = n > 0 && n < vl.length;
      node.el.cnt.textContent = vl.length ? `(${n}/${vl.length})` : '';
      return anyVisible;
    }

    // ---------- output ----------
    function allLeavesInOrder() { return roots.flatMap(r => leaves(r)); }

    function buildOutput() {
      const picked = allLeavesInOrder().filter(t => selected.has(t.id));
      countLbl.textContent = picked.length + ' selected';
      switch (fmt.value) {
        case 'ids-lines': return picked.map(t => t.id).join('\n');
        case 'tsv': return picked.map(t => t.title + '\t' + t.id).join('\n');
        case 'path-tsv': return picked.map(t => {
          const p = pathOf(t);
          return [p[0] || '', p.slice(1).join(' > '), t.title, t.id].join('\t');
        }).join('\n');
        case 'json': return JSON.stringify(picked.map(t => ({ id: t.id, title: t.title, path: pathOf(t) })), null, 2);
        default: return picked.map(t => t.id).join(',');
      }
    }

    function refresh() {
      roots.forEach(sync);
      out.value = buildOutput();
    }

    roots.forEach(r => render(r, treeBox, 0));

    keyword.addEventListener('input', refresh);
    typeSel.addEventListener('change', refresh);
    fmt.addEventListener('change', refresh);
    selAll.addEventListener('click', () => {
      roots.flatMap(r => visibleLeaves(r)).forEach(t => selected.add(t.id));
      refresh();
    });
    selNone.addEventListener('click', () => { selected.clear(); refresh(); });

    const walkModules = (nodes, fn) => nodes.forEach(n => { if (n.kind === 'module') { fn(n); walkModules(n.children, fn); } });
    expand.addEventListener('click', () => walkModules(roots, n => {
      n.el.kids.style.display = 'block'; n.el.arrow.textContent = '▾';
    }));
    collapse.addEventListener('click', () => walkModules(roots, n => {
      n.el.kids.style.display = 'none'; n.el.arrow.textContent = '▸';
    }));

    const csvCell = v => {
      const s = String(v === undefined || v === null ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    csvBtn.addEventListener('click', () => {
      let rows = allLeavesInOrder().filter(t => selected.has(t.id));
      if (!rows.length) rows = roots.flatMap(r => visibleLeaves(r)); // nothing ticked: export what's shown
      if (!rows.length) { alert('No topics to export.'); return; }

      const lines = [['Unit', 'Lesson', 'Title', 'Type', 'Topic ID']];
      rows.forEach(t => {
        const p = pathOf(t);
        lines.push([p[0] || '', p.slice(1).join(' > '), t.title, t.type, t.id]);
      });
      const csv = '\uFEFF' + lines.map(r => r.map(csvCell).join(',')).join('\r\n'); // BOM so Excel reads UTF-8

      const stamp = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      a.download = `topic-ids-${courseId || 'course'}-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    meBtn.addEventListener('click', async () => {
      try { userIds.value = String(await whoAmI()); }
      catch (e) { alert('Could not look up your user ID: ' + e.message); }
    });

    compBtn.addEventListener('click', () => {
      const ids = userIds.value.split(/[\s,;]+/).filter(Boolean);
      if (!ids.length) { alert('Enter at least one D2L UserId.'); return; }
      if (!dateIn.value) { alert('Pick a completion date.'); return; }

      let topics = allLeavesInOrder().filter(t => selected.has(t.id));
      if (!topics.length) topics = roots.flatMap(r => visibleLeaves(r));
      if (!topics.length) { alert('No topics to export.'); return; }

      const total = ids.length * topics.length;
      if (total > 200 && !confirm(`This creates ${total} rows. The widget sends every request at once. Continue?`)) return;

      try { localStorage.setItem('bsTopicIds.userIds', userIds.value); } catch (e) { /* ignore */ }

      // Headers must match the widget exactly (case-sensitive); date must be a full ISO UTC timestamp.
      const iso = dateIn.value + 'T00:00:00Z';
      const lines = [['orgUnitId', 'topicId', 'userId', 'date']];
      ids.forEach(u => topics.forEach(t => lines.push([courseId, t.id, u, iso])));
      // no BOM and no trailing newline: a trailing newline makes the widget add a blank row
      const csv = lines.map(r => r.join(',')).join('\r\n');

      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
      a.download = `completion-${courseId || 'course'}-${dateIn.value}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(out.value); }
      catch (e) { out.select(); document.execCommand('copy'); }
      const old = copyBtn.textContent;
      copyBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyBtn.textContent = old; }, 1200);
    });

    refresh();
  }

  // ---------- init ----------
  const wait = setInterval(() => {
    if (document.body) { clearInterval(wait); addLauncher(); }
  }, 300);
})();
