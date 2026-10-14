// ==UserScript==
// @name         D2L File Path Copier
// @namespace    http://tampermonkey.net/
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/d2l-file-path-copier.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/d2l-file-path-copier.user.js
// @description  In Manage Files and Public Files, adds a "Show Path" button to each file row. Clicking it displays the full enforced path, full URL, and a ready-to-paste HTML snippet (<img> for images, <a> for everything else) — each with its own Copy button.
// @match        https://brightspace.rcpi.ie/d2l/lp/manageFiles/*
// @match        https://brightspace.rcpi.ie/d2l/lp/publicfiles/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// ⚠️ URL MAINTENANCE: The two @match lines above cover Manage Files and Public
// Files on this Brightspace instance. If your institution's domain differs from
// brightspace.rcpi.ie, update all @match lines. If D2L moves either tool to a
// new path, update the relevant @match — the script silently does nothing on
// pages it isn't matched to.

(function () {
  'use strict';

  // ============================================================
  // CONFIG — update these if D2L changes its Manage Files markup.
  // ============================================================
  const CFG = {
    // Checkbox whose `value` attribute holds the full enforced path.
    // Format: "f_/content/enforced/12345-Course/file.html"  (files)
    //      or "d_/content/enforced/12345-Course/folder/"    (folders)
    // For Public Files the prefix is "f_/content/shared/..." or similar.
    rowCheckbox: 'input[name="z_o_s"]',

    // Visual style for the injected button.
    btnStyle: `
      margin-left: 8px;
      padding: 1px 7px;
      font-size: 11px;
      cursor: pointer;
      background: #fff;
      border: 1px solid #a0aec0;
      border-radius: 3px;
      color: #2d3748;
      vertical-align: middle;
      white-space: nowrap;
    `,
  };

  // ============================================================
  // PATH EXTRACTION
  // Strip the leading type prefix (f_ / d_) that D2L adds to the
  // checkbox value. Everything after that prefix is the real path.
  // ============================================================
  function extractPath(rawValue) {
    return rawValue.replace(/^[a-z]_/, '');
  }

  // ============================================================
  // HTML SNIPPET GENERATION
  // Detect file type from extension and return a ready-to-paste
  // HTML snippet for use in the Brightspace HTML editor.
  // Images → <img src="..."> | Everything else → <a href="...">
  // ============================================================
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'];

  function getExtension(path) {
    return (path.split('.').pop() || '').toLowerCase().split('?')[0];
  }

  function getFilename(path) {
    return path.split('/').pop() || path;
  }

  function buildSnippet(path, fullUrl) {
    const ext = getExtension(path);
    const name = getFilename(path);
    if (IMAGE_EXTS.includes(ext)) {
      // Image — uses full URL; alt text is the filename as a sensible default
      // to edit before pasting.
      return `<img src="${fullUrl}" alt="${name}" />`;
    } else {
      // Link — opens in a new tab, standard for downloadable/viewable files.
      return `<a href="${fullUrl}" target="_blank" rel="noopener noreferrer">${name}</a>`;
    }
  }

  // ============================================================
  // BANNER
  // ============================================================
  function makeCopyBtn(textToCopy) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '📋 Copy';
    btn.style.cssText = `
      background: #3182ce;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 12px;
      white-space: nowrap;
      flex-shrink: 0;
    `;
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(textToCopy).then(() => {
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
      }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = textToCopy;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = '📋 Copy'; }, 2000);
      });
    });
    return btn;
  }

  function makeRow(label, value) {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:8px;width:100%;`;

    const lbl = document.createElement('span');
    lbl.style.cssText = `font-weight:bold;white-space:nowrap;flex-shrink:0;min-width:110px;`;
    lbl.textContent = label;

    const val = document.createElement('span');
    val.style.cssText = `flex:1;word-break:break-all;min-width:0;font-family:monospace;font-size:12px;`;
    val.textContent = value;

    row.appendChild(lbl);
    row.appendChild(val);
    row.appendChild(makeCopyBtn(value));
    return row;
  }

  function showBanner(path) {
    document.getElementById('d2l-path-banner')?.remove();

    const fullUrl = window.location.origin + path;
    const snippet = buildSnippet(path, fullUrl);
    const isImage = IMAGE_EXTS.includes(getExtension(path));
    const snippetLabel = isImage ? 'HTML (image):' : 'HTML (link):';

    const b = document.createElement('div');
    b.id = 'd2l-path-banner';
    b.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 99999;
      background: #ebf8ff;
      border-bottom: 2px solid #3182ce;
      padding: 10px 16px;
      font-family: sans-serif;
      font-size: 13px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: #1a365d;
      box-sizing: border-box;
    `;

    // Header row with title and close button
    const header = document.createElement('div');
    header.style.cssText = `display:flex;align-items:center;gap:8px;`;
    const title = document.createElement('span');
    title.style.cssText = `font-weight:bold;`;
    title.textContent = '📁 File Path';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      margin-left: auto;
      background: none;
      border: 1px solid #3182ce;
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      color: #1a365d;
      font-size: 12px;
    `;
    closeBtn.addEventListener('click', () => b.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);

    b.appendChild(header);
    b.appendChild(makeRow('Enforced path:', path));
    b.appendChild(makeRow('Full URL:', fullUrl));
    b.appendChild(makeRow(snippetLabel, snippet));

    document.body.insertAdjacentElement('afterbegin', b);
  }

  // ============================================================
  // BUTTON INJECTION
  // Find every file row that doesn't already have a "Show Path"
  // button and inject one next to the filename link.
  // ============================================================
  function injectButtons() {
    const checkboxes = document.querySelectorAll(CFG.rowCheckbox);
    checkboxes.forEach(cb => {
      const row = cb.closest('tr');
      if (!row) return;

      // Skip folders (checkbox value ends with /).
      const raw = cb.value || '';
      if (raw.endsWith('/')) return;

      // Skip rows we've already processed.
      if (row.dataset.pathBtnAdded) return;
      row.dataset.pathBtnAdded = '1';

      // Find the best anchor to attach the button to.
      const nameCell =
        row.querySelector('td[class*="col-Name"]') ||
        row.querySelector('td[headers*="Name"]');
      const anchor = (nameCell && nameCell.querySelector('a')) ||
                     row.querySelector('a');
      if (!anchor) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '⧉ Path';
      btn.title = 'Show full enforced path and HTML snippet';
      btn.style.cssText = CFG.btnStyle;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        showBanner(extractPath(raw));
      });

      anchor.insertAdjacentElement('afterend', btn);
    });
  }

  // ============================================================
  // OBSERVER — D2L lazy-loads rows as the user scrolls, and
  // reloads the whole table when navigating into a subfolder.
  // ============================================================
  function observe() {
    injectButtons();

    const observer = new MutationObserver(() => {
      injectButtons();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // ENTRY
  // ============================================================
  if (document.body) {
    observe();
  } else {
    document.addEventListener('DOMContentLoaded', observe, { once: true });
  }
})();
