// ==UserScript==
// @name         RCPI Brightspace Audit Toolkit
// @namespace    rcpi-content-audit
// @description  View-mode content audit: WCAG a11y report, broken link/image checker, URL lint, DOI/PMID citation report, copyright/H5P image audit. Read-only — this script never writes to page or editor content; see the Edit Toolkit for fixes.
// @match        https://brightspace.rcpi.ie/*
// @version      4.1
// @require      https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/rcpi-shared-core.js
// @updateURL    https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/audit-toolkit.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/audit-toolkit.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const S = (typeof unsafeWindow !== 'undefined' && unsafeWindow.RCPIShared) ? unsafeWindow.RCPIShared : window.RCPIShared;
  if (!S) { console.error('[rcpi-audit] RCPIShared not loaded — check @require'); return; }

  // @match stays domain-wide (narrower patterns have silently failed to
  // match the real content-frame URL before) — decide per-page at runtime.
  // View mode ONLY. This script never mounts on an /edit/ URL.
  //
  // File topics render inside a content/enforced/*.html iframe nested in
  // the top lessons/topics shell — matched via the iframe's own URL below.
  // Unit pages (lessons/N/units/N) are also in scope; whether they render
  // through the same nested iframe or directly on the top-shell URL is
  // unconfirmed, so both are matched here. If the bar doesn't appear on a
  // unit page, check what the content iframe's own URL looks like there
  // and extend this pattern.
  const IS_VIEW_PATH = /\/content\/enforced\/.*\.html/i.test(location.pathname)
    || /\/d2l\/le\/lessons\/\d+\/folders\/\d+/i.test(location.pathname)
    || /\/d2l\/le\/lessons\/\d+\/units\/\d+/i.test(location.pathname);
  if (!IS_VIEW_PATH) return;

  // ─── FEATURES / SETTINGS ────────────────────────────────────────────
  const SETTINGS_KEY = 'rcpi-audit-settings-v1';
  const DEFAULTS = {
    probeAutoRun: false,     // 404 probe fires network requests; opt-in
    citationsAutoRun: true,
    a11yAutoRun: true,
  };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(GM_getValue(SETTINGS_KEY, '{}'))); }
    catch { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) { GM_setValue(SETTINGS_KEY, JSON.stringify(s)); }
  let FEATURES = loadSettings();

  // UI mounts on the real top document — position:fixed inside a nested
  // content iframe only pins to that iframe's own viewport otherwise.
  const uiMountDoc = S.findTopSameOriginDoc();

  // ─── localStorage HANDOFF (Edit Toolkit reads this) ─────────────────
  // Keyed by the shared core's canonical topic key so the Edit Toolkit,
  // opened later on the same topic/unit's /edit/ URL, can show "Audit
  // found N issues" without any direct call between the two scripts (GM
  // storage is isolated per-script; localStorage on this origin is shared).
  function writeHandoff(summary) {
    const bsUrl = S.getBrightspaceUrl();
    const tid = S.topicKeyFromViewUrl(bsUrl);
    if (!tid) return;
    try {
      localStorage.setItem('rcpi-audit:' + tid, JSON.stringify({
        scannedAt: Date.now(), url: bsUrl, ...summary
      }));
    } catch (e) {}
  }

  // ─── A11Y TAB ────────────────────────────────────────────────────────
  let a11yResult = null;
  function runA11yScan() {
    a11yResult = S.runA11y(document.body);
    return a11yResult;
  }

  function renderA11yTab(bodyEl) {
    bodyEl.innerHTML = `<div class="rcpi-tab-toolbar">
        <button class="rcpi-btn" data-rescan>Rescan</button>
        <button class="rcpi-btn sec" data-export-csv>Export CSV</button>
        <button class="rcpi-btn sec" data-export-md>Export Markdown</button>
      </div>
      <div class="rcpi-summary"></div>
      <div class="rcpi-list"></div>`;
    const summaryEl = bodyEl.querySelector('.rcpi-summary');
    const listEl = bodyEl.querySelector('.rcpi-list');

    function draw() {
      if (!a11yResult) runA11yScan();
      const { issues, wordCount, readMins } = a11yResult;
      const errors = issues.filter(i => i.severity === 'error').length;
      const warns = issues.filter(i => i.severity === 'warn').length;
      const infos = issues.filter(i => i.severity === 'info').length;
      summaryEl.innerHTML = `<div class="rcpi-sum-row">
          <span class="rcpi-badge err">${errors} error${errors===1?'':'s'}</span>
          <span class="rcpi-badge warn">${warns} warning${warns===1?'':'s'}</span>
          <span class="rcpi-badge info">${infos} info</span>
          <span class="rcpi-muted">${wordCount} words · ~${readMins} min read</span>
        </div>`;
      updateFabBadge();
      writeHandoff({ a11yErrors: errors, a11yWarnings: warns, a11yTotal: issues.length });

      const sorted = issues.slice().sort((a, b) => S.SEV_ORDER[a.severity] - S.SEV_ORDER[b.severity]);
      listEl.innerHTML = '';
      if (!sorted.length) { listEl.innerHTML = '<div class="rcpi-empty">No issues found.</div>'; return; }
      sorted.forEach(is => {
        const row = uiMountDoc.createElement('div');
        row.className = 'rcpi-row rcpi-sev-' + is.severity;
        row.innerHTML = `
          <div class="rcpi-row-main">
            <span class="rcpi-sev-dot"></span>
            <span class="rcpi-cat">${S.escapeHtml(is.category)}</span>
            <span class="rcpi-msg">${S.escapeHtml(is.msg)}</span>
          </div>
          <button class="rcpi-locate-btn" ${is.el ? '' : 'disabled'}>Locate</button>`;
        if (is.el) row.querySelector('.rcpi-locate-btn').addEventListener('click', () => S.locateInPage(is.el));
        listEl.appendChild(row);
      });
    }

    bodyEl.querySelector('[data-rescan]').addEventListener('click', () => { a11yResult = null; draw(); S.toast('Rescanned', uiMountDoc); });
    bodyEl.querySelector('[data-export-csv]').addEventListener('click', () => {
      if (!a11yResult) return;
      const rows = [['Severity', 'Category', 'Message']];
      a11yResult.issues.forEach(i => rows.push([i.severity, i.category, i.msg]));
      S.downloadCsv(rows, 'a11y-report', uiMountDoc);
    });
    bodyEl.querySelector('[data-export-md]').addEventListener('click', () => {
      if (!a11yResult) return;
      const md = ['# Accessibility report', '', `URL: ${location.href}`, ''].concat(
        a11yResult.issues.map(i => `- **${i.severity.toUpperCase()}** [${i.category}] ${i.msg}`)
      ).join('\n');
      S.downloadMarkdown(md, 'a11y-report', uiMountDoc);
    });

    draw();
  }

  // ─── LINKS & URLS TAB (probe + structural lint) ─────────────────────
  let probeResult = null;
  let probeRunning = false;
  function collectPageAnchorsImages() {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const images = S.collectImagesDeep(document);
    return { anchors, images };
  }

  function renderLinksTab(bodyEl) {
    bodyEl.innerHTML = `<div class="rcpi-tab-toolbar">
        <button class="rcpi-btn" data-run>Check links &amp; images</button>
        <button class="rcpi-btn sec" data-export-csv>Export CSV</button>
      </div>
      <div class="rcpi-progress" style="display:none"></div>
      <div class="rcpi-summary"></div>
      <div class="rcpi-list"></div>
      <div class="rcpi-sec-title" style="margin-top:14px">URL formatting issues</div>
      <div class="rcpi-list" data-lint></div>`;
    const progEl = bodyEl.querySelector('.rcpi-progress');
    const summaryEl = bodyEl.querySelector('.rcpi-summary');
    const listEl = bodyEl.querySelector('.rcpi-list:not([data-lint])');
    const lintEl = bodyEl.querySelector('[data-lint]');

    function drawLint() {
      const { anchors } = collectPageAnchorsImages();
      const matches = S.lintAnchors(anchors);
      lintEl.innerHTML = '';
      if (!matches.length) { lintEl.innerHTML = '<div class="rcpi-empty">None.</div>'; return; }
      matches.forEach(m => {
        const row = uiMountDoc.createElement('div');
        row.className = 'rcpi-row';
        row.innerHTML = `<div class="rcpi-row-main">
            <span class="rcpi-msg">${S.escapeHtml(m.oldHref)} → ${S.escapeHtml(m.newHref)}<br>
            <span class="rcpi-muted">${S.escapeHtml(m.reasons.join(', '))}</span></span>
          </div>
          <button class="rcpi-locate-btn">Locate</button>`;
        row.querySelector('.rcpi-locate-btn').addEventListener('click', () => S.locateInPage(m.a));
        lintEl.appendChild(row);
      });
    }

    function drawProbe() {
      summaryEl.innerHTML = '';
      listEl.innerHTML = '';
      if (!probeResult) { listEl.innerHTML = '<div class="rcpi-empty">Not run yet — click "Check links &amp; images". This makes live network requests.</div>'; return; }
      const broken = probeResult.filter(r => r.klass === 'broken');
      const redirect = probeResult.filter(r => r.klass === 'redirect');
      const warn = probeResult.filter(r => r.klass === 'warn');
      const uncertain = probeResult.filter(r => r.klass === 'uncertain');
      summaryEl.innerHTML = `<div class="rcpi-sum-row">
          <span class="rcpi-badge err">${broken.length} broken</span>
          <span class="rcpi-badge warn">${warn.length} warning${warn.length===1?'':'s'}</span>
          <span class="rcpi-badge info">${redirect.length} redirect${redirect.length===1?'':'s'}</span>
          <span class="rcpi-muted">${uncertain.length} uncertain</span>
        </div>`;
      writeHandoff({ linksBroken: broken.length, linksWarn: warn.length, linksChecked: probeResult.length });

      const groups = [['Broken', broken, 'err'], ['Warnings', warn, 'warn'], ['Redirects', redirect, 'info'], ['Uncertain', uncertain, 'info']];
      groups.forEach(([label, items, cls]) => {
        if (!items.length) return;
        const h = uiMountDoc.createElement('div');
        h.className = 'rcpi-sec-title';
        h.textContent = `${label} (${items.length})`;
        listEl.appendChild(h);
        items.forEach(r => {
          const els = [...(r.anchors || []), ...(r.imgs || [])];
          const row = uiMountDoc.createElement('div');
          row.className = 'rcpi-row rcpi-sev-' + cls;
          row.innerHTML = `<div class="rcpi-row-main">
              <span class="rcpi-msg">${S.escapeHtml(r.url)}<br><span class="rcpi-muted">${S.escapeHtml(r.reason || '')}</span></span>
            </div>
            <button class="rcpi-locate-btn" ${els.length ? '' : 'disabled'}>Locate</button>`;
          if (els.length) row.querySelector('.rcpi-locate-btn').addEventListener('click', () => S.locateInPage(els[0]));
          listEl.appendChild(row);
        });
      });
    }

    bodyEl.querySelector('[data-run]').addEventListener('click', async () => {
      if (probeRunning) return;
      probeRunning = true;
      progEl.style.display = 'block';
      progEl.textContent = 'Checking…';
      const { anchors, images } = collectPageAnchorsImages();
      probeResult = await S.runProbe({
        anchors, images,
        onProgress: (done, total) => { progEl.textContent = `Checking… ${done}/${total}`; },
        isCurrent: () => true
      });
      probeRunning = false;
      progEl.style.display = 'none';
      drawProbe();
      updateFabBadge();
    });
    bodyEl.querySelector('[data-export-csv]').addEventListener('click', () => {
      if (!probeResult) return;
      const rows = [['URL', 'Status', 'Class', 'Reason']];
      probeResult.forEach(r => rows.push([r.url, r.status, r.klass, r.reason || '']));
      S.downloadCsv(rows, 'link-check', uiMountDoc);
    });

    drawLint();
    drawProbe();
    if (FEATURES.probeAutoRun) bodyEl.querySelector('[data-run]').click();
  }

  // ─── CITATIONS TAB (DOI + PMID — report only, no linking) ───────────
  function renderCitationsTab(bodyEl) {
    bodyEl.innerHTML = `<div class="rcpi-tab-toolbar">
        <button class="rcpi-btn" data-run>Check citations</button>
      </div>
      <p class="rcpi-muted" style="margin:0 0 8px">Read-only — flags references without a linked DOI/PMID and suggests a match. Open the topic in the Edit Toolkit to insert the link.</p>
      <div class="rcpi-list"></div>`;
    const listEl = bodyEl.querySelector('.rcpi-list');

    async function run() {
      listEl.innerHTML = '<div class="rcpi-empty">Checking…</div>';
      const refs = S.collectReferenceEls(document.body);
      const shortRefs = S.collectShortReferenceCandidates(document.body);
      listEl.innerHTML = '';

      if (!refs.length && !shortRefs.length) { listEl.innerHTML = '<div class="rcpi-empty">No reference-list entries detected.</div>'; return; }

      for (const el of refs) {
        // Already fully identified by any citation id — nothing to flag.
        if (S.hasDoi(el) || S.hasPmidLink(el) || S.hasPmcidLink(el)) continue;

        const rawDoi = S.extractRawDoi(el);
        const pmids = S.collectPmids(el);

        const row = uiMountDoc.createElement('div');
        row.className = 'rcpi-row';
        const text = (el.textContent || '').trim().slice(0, 90);
        let statusHtml = '';

        if (rawDoi) {
          statusHtml = `<span class="rcpi-badge warn">DOI present as plain text</span> <a href="https://doi.org/${S.escapeHtml(rawDoi)}" target="_blank" rel="noopener">${S.escapeHtml(rawDoi)}</a>`;
        } else {
          statusHtml = '<span class="rcpi-badge err">No DOI found</span> <span class="rcpi-checking">looking up…</span>';
        }
        if (pmids.length) statusHtml += ` <span class="rcpi-badge warn">PMID ${S.escapeHtml(pmids[0])} unlinked</span>`;

        row.innerHTML = `<div class="rcpi-row-main"><span class="rcpi-msg">${S.escapeHtml(text)}…<br>${statusHtml}</span></div>
          <button class="rcpi-locate-btn">Locate</button>`;
        row.querySelector('.rcpi-locate-btn').addEventListener('click', () => S.locateInPage(el));
        listEl.appendChild(row);

        if (!rawDoi) {
          const q = S.refQueryText(el);
          S.crossrefQueryCached(q).then(items => {
            const checkingEl = row.querySelector('.rcpi-checking');
            if (!checkingEl) return;
            if (!items || !items.length) { checkingEl.textContent = 'no Crossref match'; return; }
            const best = items[0];
            const yearMismatch = S.extractYear(text) && S.extractYear(text) !== (best.published && best.published['date-parts'] && best.published['date-parts'][0] && best.published['date-parts'][0][0]);
            const band = S.scoreBand(best.score || 0, yearMismatch);
            checkingEl.outerHTML = `<span class="rcpi-badge ${band.cls === 'doi-high' ? 'ok' : 'warn'}">${band.label}</span> ${S.escapeHtml(S.fmtCrossref(best))} <a href="https://doi.org/${S.escapeHtml(best.DOI || '')}" target="_blank" rel="noopener">${S.escapeHtml(best.DOI || '')}</a>`;
          });
        }
      }

      if (shortRefs.length) {
        const h = uiMountDoc.createElement('div');
        h.className = 'rcpi-sec-title';
        h.textContent = `Too short to auto-check (${shortRefs.length})`;
        listEl.appendChild(h);
        shortRefs.forEach(el => {
          const row = uiMountDoc.createElement('div');
          row.className = 'rcpi-row';
          row.innerHTML = `<div class="rcpi-row-main"><span class="rcpi-msg">${S.escapeHtml((el.textContent || '').trim().slice(0, 90))}</span></div>
            <button class="rcpi-locate-btn">Locate</button>`;
          row.querySelector('.rcpi-locate-btn').addEventListener('click', () => S.locateInPage(el));
          listEl.appendChild(row);
        });
      }
    }

    bodyEl.querySelector('[data-run]').addEventListener('click', run);
    if (FEATURES.citationsAutoRun) run();
  }

  // ─── COPYRIGHT & H5P TAB ─────────────────────────────────────────────
  function renderCopyrightTab(bodyEl) {
    const session = S.loadAuditSession();
    bodyEl.innerHTML = `
      <p class="rcpi-muted" style="margin:0 0 8px">
        ${session.active
          ? `Recording. ${session.rows.length} image(s) captured so far. Navigate through the pages you want audited — this page's images are captured automatically. Then Stop &amp; Export.`
          : (session.rows.length
              ? `${session.rows.length} row(s) from a previous session are stored but not exported.`
              : `Not recording. Start, then browse the course pages you want audited.`)}
      </p>
      <div class="rcpi-tab-toolbar" data-actions></div>`;
    const actions = bodyEl.querySelector('[data-actions]');

    function draw() {
      const s = S.loadAuditSession();
      actions.innerHTML = '';
      if (s.active) {
        const stop = uiMountDoc.createElement('button');
        stop.className = 'rcpi-btn danger';
        stop.textContent = 'Stop & Export CSV';
        stop.addEventListener('click', () => {
          const cur = S.loadAuditSession();
          cur.active = false;
          S.saveAuditSession(cur);
          const rows = [['Date', 'Where used', 'Image', 'Source URL', 'Basis', 'Attribution line used', 'Changed?', 'Page URL', 'Brightspace URL']];
          cur.rows.forEach(r => rows.push([r.date, r.whereUsed, r.image, r.sourceUrl, r.basis, r.attribution, r.changed, r.pageUrl, r.brightspaceUrl || '']));
          S.downloadCsv(rows, 'copyright-audit', uiMountDoc);
          renderCopyrightTab(bodyEl);
        });
        actions.appendChild(stop);
      } else {
        const start = uiMountDoc.createElement('button');
        start.className = 'rcpi-btn';
        start.textContent = 'Start recording';
        start.addEventListener('click', () => {
          S.saveAuditSession({ active: true, rows: S.loadAuditSession().rows });
          appendThisPage();
          renderCopyrightTab(bodyEl);
        });
        const clear = uiMountDoc.createElement('button');
        clear.className = 'rcpi-btn sec';
        clear.textContent = 'Clear stored rows';
        clear.addEventListener('click', () => { S.saveAuditSession({ active: false, rows: [] }); renderCopyrightTab(bodyEl); });
        actions.appendChild(clear);
        actions.appendChild(start);
      }
    }
    draw();
  }

  function appendThisPage() {
    const session = S.loadAuditSession();
    if (!session.active) return;
    const seen = new Set(session.rows.map(r => r.pageUrl + '||' + r.image));
    const fresh = S.scanImagesForCopyright().filter(r => !seen.has(r.pageUrl + '||' + r.image));
    session.rows = session.rows.concat(fresh);
    S.saveAuditSession(session);

    // H5P images are cross-origin — fetched async, appended as they resolve.
    const iframes = Array.from(document.querySelectorAll('iframe[src*="h5p.com" i]'));
    if (!iframes.length) return;
    const pageUrl = location.href;
    const brightspaceUrl = S.getBrightspaceUrl();
    const dateStr = new Date().toISOString().slice(0, 10);
    iframes.forEach(async (iframe) => {
      let found;
      try { found = await S.scanH5PIframeForCopyright(iframe); } catch { found = []; }
      if (!found.length) return;
      const cur = S.loadAuditSession();
      if (!cur.active) return;
      const seen2 = new Set(cur.rows.map(r => r.pageUrl + '||' + r.image));
      found.forEach(f => {
        if (seen2.has(pageUrl + '||' + f.filename)) return;
        seen2.add(pageUrl + '||' + f.filename);
        cur.rows.push({ date: dateStr, whereUsed: (document.title || location.pathname) + (f.title ? ` (H5P: ${f.title})` : ' (H5P)'), image: f.filename, sourceUrl: f.sourceHint || '', basis: '', attribution: '', changed: '', pageUrl, brightspaceUrl });
      });
      S.saveAuditSession(cur);
      updateFabBadge();
    });
  }

  // ─── SETTINGS TAB ─────────────────────────────────────────────────────
  function renderSettingsTab(bodyEl) {
    bodyEl.innerHTML = `
      <label class="rcpi-set-row"><input type="checkbox" data-k="probeAutoRun"> Auto-run link/image check on page load (makes network requests)</label>
      <label class="rcpi-set-row"><input type="checkbox" data-k="citationsAutoRun"> Auto-run citation check on page load</label>
      <label class="rcpi-set-row"><input type="checkbox" data-k="a11yAutoRun"> Auto-run accessibility scan on page load</label>
      <div class="rcpi-sec-title" style="margin-top:14px">Ignore domains for link check</div>
      <textarea class="rcpi-textarea" data-ignore rows="6"></textarea>
      <button class="rcpi-btn sec" data-save-ignore style="margin-top:6px">Save ignore list</button>
    `;
    Object.keys(DEFAULTS).forEach(k => {
      const cb = bodyEl.querySelector(`[data-k="${k}"]`);
      cb.checked = !!FEATURES[k];
      cb.addEventListener('change', () => { FEATURES[k] = cb.checked; saveSettings(FEATURES); });
    });
    const ta = bodyEl.querySelector('[data-ignore]');
    ta.value = S.loadIgnoreDomains().join('\n');
    bodyEl.querySelector('[data-save-ignore]').addEventListener('click', () => {
      const list = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      S.saveIgnoreDomains(list);
      S.toast('Ignore list saved', uiMountDoc);
    });
  }

  // ─── SHELL / FAB BADGE ────────────────────────────────────────────────
  let shell = null;
  function updateFabBadge() {
    if (!shell) return;
    const errs = a11yResult ? a11yResult.issues.filter(i => i.severity === 'error').length : 0;
    const broken = probeResult ? probeResult.filter(r => r.klass === 'broken').length : 0;
    const n = errs + broken;
    shell.setBadge(n ? `<span class="rcpi-badge err">${n}</span>` : '');
  }

  function mount() {
    injectAuditCss(uiMountDoc);
    const tabs = [
      { id: 'a11y', label: 'Accessibility', render: renderA11yTab },
      { id: 'links', label: 'Links & URLs', render: renderLinksTab },
      { id: 'citations', label: 'Citations', render: renderCitationsTab },
      { id: 'copyright', label: 'Copyright & H5P', render: renderCopyrightTab },
      { id: 'settings', label: 'Settings', render: renderSettingsTab },
      ...S.CUSTOM_AUDIT_TABS, // expansion point — see shared core registerAuditTab()
    ];
    shell = S.createDockedShell({
      doc: uiMountDoc,
      side: 'right',
      idPrefix: 'rcpi-audit',
      title: '🔍 Audit Toolkit',
      minIcon: '⟩',
      width: 400,
      defaultMinimized: true,
      tabs
    });

    // Auto-run on load per settings (mirrors previous FAB auto-run behaviour,
    // now firing on mount since there's no click-to-open FAB any more).
    setTimeout(() => {
      try {
        if (FEATURES.a11yAutoRun) runA11yScan();
        appendThisPage(); // no-op if recording session isn't active
        updateFabBadge();
      } catch (e) {}
    }, 1000);

    uiMountDoc.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'e') shell.setMinimized(false);
    });
  }

  function injectAuditCss(doc) {
    if (doc.getElementById('rcpi-audit-css')) return;
    const s = doc.createElement('style');
    s.id = 'rcpi-audit-css';
    // Same button/spacing/colour tokens as the Edit Toolkit's .bb-btn family
    // (own class names to avoid any risk of colliding with bb- classes if
    // both scripts are ever present in the same top document).
    s.textContent = `
      .rcpi-tab-toolbar { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
      .rcpi-btn {
        padding: 3px 8px; border-radius: 4px; border: 1px solid;
        cursor: pointer; font-size: 11px; white-space: nowrap;
        background: #002d72; color: #fff; border-color: #002d72;
      }
      .rcpi-btn:hover { background: #0040a0; }
      .rcpi-btn.sec { background: #fff; color: #6e7477; border-color: #cdd5dc; }
      .rcpi-btn.sec:hover { background: #f8f9fa; }
      .rcpi-btn.danger { background: #dc3545; border-color: #dc3545; }
      .rcpi-sum-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
      .rcpi-badge { border-radius: 10px; padding: 2px 8px; font-size: 11px; font-weight: 700; color: #fff; }
      .rcpi-badge.err { background: #dc3545; }
      .rcpi-badge.warn { background: #fd7e14; }
      .rcpi-badge.info { background: #33607a; }
      .rcpi-badge.ok { background: #198754; }
      .rcpi-muted { color: #6e7477; font-size: 11px; }
      .rcpi-sec-title { font-weight: 700; margin: 14px 0 4px; padding-top: 10px; border-top: 1px solid #e5e9f0; font-size: 13px; color: #002d72; }
      .rcpi-sec-title:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
      .rcpi-empty { color: #6e7477; font-size: 12px; padding: 6px 0; }
      .rcpi-row {
        display: flex; align-items: flex-start; gap: 6px;
        padding: 4px 2px; border-bottom: 1px solid #f1f5fb; font-size: 12px;
      }
      .rcpi-row-main { flex: 1; min-width: 0; }
      .rcpi-sev-dot { display: none; } /* colour now carried by rcpi-cat text colour, matches .bb-audit-icon */
      .rcpi-sev-error .rcpi-cat, .rcpi-sev-err .rcpi-cat { color: #dc3545; }
      .rcpi-sev-warn  .rcpi-cat { color: #fd7e14; }
      .rcpi-sev-info  .rcpi-cat { color: #33607a; }
      .rcpi-cat { font-weight: 700; font-size: 11px; margin-right: 4px; }
      .rcpi-msg { font-size: 13px; color: #1b2733; word-break: break-word; }
      .rcpi-locate-btn {
        flex: 0 0 auto; background: #fff; border: 1px solid #cdd5dc; color: #6e7477;
        border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer;
      }
      .rcpi-locate-btn:hover { background: #f8f9fa; }
      .rcpi-locate-btn:disabled { opacity: .4; cursor: default; }
      .rcpi-progress { font-size: 12px; color: #6e7477; margin-bottom: 6px; }
      .rcpi-set-row { display: block; font-size: 13px; margin-bottom: 8px; }
      .rcpi-textarea { width: 100%; box-sizing: border-box; font: 12px monospace; border: 1px solid #cdd5dc; border-radius: 4px; padding: 6px; }
      .rcpi-checking { color: #6e7477; font-style: italic; }
    `;
    doc.head.appendChild(s);
  }

  mount();
})();
