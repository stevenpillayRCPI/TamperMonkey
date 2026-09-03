// ==UserScript==
// @name         Block Builder Edit Toolkit
// @namespace    rcpi-block-builder
// @description  Alt+right-click toolkit for the RCPI block builder: tables, wrap+columns, convert, item-ops, row colour/insert/align, icon swap, image figure/decorative/transcript/search, fix/repair, outline, find & replace, citation linking, strip formatting, Alt-hint overlay, leader-key shortcuts, new-page filename slugify, backend filename display, Manage Files launcher + popup locator. Left dock. Alt-text copilot link.
// @match        https://brightspace.rcpi.ie/d2l/le/lessons/*/edit/*
// @match        https://brightspace.rcpi.ie/d2l/lms/content/*/edit/*
// @match        https://brightspace.rcpi.ie/d2l/lp/manageFiles/*
// @version      5.7
// @require      https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/rcpi-shared-core.js
// @updateURL    https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/edit-toolkit.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/edit-toolkit.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Shared detection/UI library (rcpi-shared-core.js via @require). This
  // toolkit is the only one of the two allowed to WRITE — every write below
  // still goes through tinyWrite; S is only ever used for detection/lookup.
  const S = (typeof unsafeWindow !== 'undefined' && unsafeWindow.RCPIShared) ? unsafeWindow.RCPIShared : window.RCPIShared;
  if (!S) console.error('[Edit Toolkit] RCPIShared not loaded — check @require. New Outline/Replace/Citations panels will be unavailable.');

  // ─── MANAGE FILES POPUP — early exit ───────────────────────────────────
  // Folded in from the standalone "D2L Manage Files Locator" script (see
  // runManageFilesLocator() near the bottom of this file) so everything
  // ships as one script instead of three. The Manage Files popup is a
  // completely different D2L tool with no TinyMCE/editor present, so none
  // of the block-builder code below applies there — this branch runs the
  // locator alone and returns before touching anything else.
  if (/\/d2l\/lp\/manageFiles\//i.test(location.pathname)) {
    runManageFilesLocator();
    return;
  }

  // These two are independent of TinyMCE/the block builder (they operate on
  // D2L's own title field and Save button, and on a background fetch
  // intercept), so they run immediately rather than waiting behind
  // waitForTinyMCE(init) below — on a brand-new page in particular, we want
  // the fetch intercept installed well before anyone can click Save.
  // Folded in from "New Page Unique Names" and "Edit Page Filename & Manage
  // Files" respectively; each is fully self-contained (own local helpers,
  // no shared state with the block-builder code) and no-ops when it
  // doesn't apply — see isNewPage() / isNewPageContext() inside each.
  initNewPageUniqueNames();
  initFilenameDisplayAndManageFiles();

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const BB_ORIGIN = '*'; // tighten to your block builder origin if known
  // Org Copilot agent — clicking the menu item copies the image to the
  // clipboard then opens this in a new tab. No URL-based prompt prefill is
  // used (Microsoft locked that down after the Reprompt disclosure), so you
  // paste the image and type your own prompt once the tab opens.
  const COPILOT_AGENT_URL = 'https://m365.cloud.microsoft/chat/?titleId=T_6347c6bd-ff19-7352-8a7a-2537a0566213';
  const HISTORY_MAX = 6;
  const AUDIT_DEBOUNCE_MS = 800;

  // ─── MASTER TOGGLES ─────────────────────────────────────────────────────────
  // Flip these without touching the rest of the code.
  // Small helpers to read persisted booleans (GM storage). Fall back to the
  // given default when unset or when GM storage is unavailable.
  function gmBool(key, dflt) {
    try { const v = GM_getValue(key, null); if (v === '1') return true; if (v === '0') return false; } catch {}
    return dflt;
  }

  const CONFIG = {
    // Direct-write is always on now: every editor write goes through
    // tinymce.activeEditor (one click, no paste), falling back to clipboard only
    // if the editor API is genuinely unreachable. (Previously a footer toggle.)
    USE_TINYMCE_API: true,

    // Verbose console logging ([BB]-prefixed). Code-level switch — flip to true
    // here when debugging. No longer surfaced in the panel.
    DEBUG: false,

    // Suppress TinyMCE's native right-click menu when our handler claims the
    // event. If you ever want D2L's menu back, set false.
    SUPPRESS_NATIVE_MENU: true,
  };

  function dbg(...args) { if (CONFIG.DEBUG) console.log('[BB]', ...args); }

  // ─── DIRECT-WRITE HELPER (TinyMCE API) ──────────────────────────────────────
  // Central place for all editor writes. Returns true on success, false if the
  // editor API is unavailable (caller then does the paste/clipboard fallback).
  // Every write flags the editor dirty + fires input so D2L's Save activates.
  // `opts.ungated` is retained for call-site clarity but no longer changes
  // behaviour, since direct-write is always attempted.
  function tinyWrite(mutateFn, label, opts) {
    const ed = getTinyEditor();
    if (!ed) {
      dbg('tinyWrite failed (no activeEditor):', label);
      return false;
    }
    try {
      const body = ed.getBody();
      if (!body) { dbg('tinyWrite failed (no body):', label); return false; }
      mutateFn(ed, body);
      ed.setDirty(true);
      ed.dispatch('input');
      dbg('tinyWrite OK:', label);
      return true;
    } catch (err) {
      dbg('tinyWrite threw:', label, err);
      return false;
    }
  }

  // ─── STATE ─────────────────────────────────────────────────────────────────
  let tinyDoc = null;       // TinyMCE iframe document
  let tinyWin = null;       // TinyMCE iframe window
  let tinyFrame = null;     // the iframe element itself
  let overlayEl = null;     // the floating + overlay div
  let iconPickTarget = null; // { iEl, context } for icon-swap modal
  let auditTimer = null;
  let clipHistory = [];     // [{label, html, ts}]

  // ─── GROUND-TRUTH TEMPLATES ─────────────────────────────────────────────────
  // Exact structures captured from the live block-builder output (DevTools dump),
  // cleaned of TinyMCE's bogus <br> padding and data-mce-* attributes. These are
  // FALLBACKS: when an action can clone a matching live component it does (so it
  // always matches whatever is actually on the page); only when nothing suitable
  // exists on the page do we fall back to these. {TXT} / {HTML} are substitution
  // points; uid-N marks where fresh ids are injected.
  const TPL = {
    // Empty row wrapper. The block builder uses <br> in the guards for caret
    // landing; we include them so the inserted row behaves identically.
    rowOpen: cls => `<div class="row${cls ? ' ' + cls : ''} wysiwyg-mode" contenteditable="false"><div class="deletion-guard" contenteditable="true"><br></div><div class="editable-row-content wysiwyg-mode" contenteditable="true">`,
    rowClose: `</div><div class="deletion-guard" contenteditable="true"><br></div></div>`,

    // Wrap a finished inner block in the standard row wrapper.
    wrapRow(innerHTML, cls) { return this.rowOpen(cls) + innerHTML + this.rowClose; },

    // Card (white / primary / secondary). Note the contenteditable="false"
    // wrapper div then col-12 then the card — matches the live dump exactly.
    card: (variant, txt) => `<div contenteditable="false"><div class="col-12"><div class="card card-${variant}" contenteditable="false"><div class="card-body"><div contenteditable="true"><h3 class="card-title">Title</h3><p class="card-text">${txt}</p></div></div></div></div></div>`,

    // Icon card (icon-left only — the only variant the builder produces).
    iconCard: (txt, variant = 'white') => `<div contenteditable="false"><div class="col-12"><div class="card card-${variant} card-with-icon" contenteditable="false"><div class="card-body d-flex"><div class="icon-column"><i class="bi bi-star-fill" style="color: var(--bs-tertiary-dark);"></i></div><div class="content-column"><div contenteditable="true"><h3 class="card-title">Title</h3><p class="card-text">${txt}</p></div></div></div></div></div></div>`,

    // Two-column image+text and text+image (image uses col-md-6).
    colImageText: txt => `<div contenteditable="false"><div class="image-column"><div class="col-12 col-md-6"><div class="figure-wrapper"><figure class="wysiwyg-mode"><div class="image-container" style="position: relative;" contenteditable="false"><div contenteditable="true"><img src="https://placehold.co/1920x1080/EEE/31343C" alt="REQUIRED" class="img-fluid"></div></div><figcaption contenteditable="false"><span contenteditable="true">Caption </span></figcaption></figure></div></div><div class="col-12 col-md-6" contenteditable="false"><div contenteditable="true"><p>${txt}</p></div></div></div></div>`,
    colTextImage: txt => `<div contenteditable="false"><div class="image-column"><div class="col-12 col-md-6" contenteditable="false"><div contenteditable="true"><p>${txt}</p></div></div><div class="col-12 col-md-6"><div class="figure-wrapper"><figure class="wysiwyg-mode"><div class="image-container" style="position: relative;" contenteditable="false"><div contenteditable="true"><img src="https://placehold.co/1920x1080/EEE/31343C" alt="REQUIRED" class="img-fluid"></div></div><figcaption contenteditable="false"><span contenteditable="true">Caption </span></figcaption></figure></div></div></div></div>`,

    // Two-column icon+text and text+icon (icon uses col-sm-6 + icon-container).
    colIconText: txt => `<div contenteditable="false"><div class="image-column"><div class="col-12 col-sm-6"><div class="icon-container" contenteditable="false" style="white-space: nowrap;"><div class="d-flex justify-content-center align-items-center h-100"><i class="bi bi-info icon-xl" aria-hidden="true"></i></div></div></div><div class="col-12 col-sm-6" contenteditable="false"><div contenteditable="true"><p>${txt}</p></div></div></div></div>`,
    colTextIcon: txt => `<div contenteditable="false"><div class="image-column"><div class="col-12 col-sm-6" contenteditable="false"><div contenteditable="true"><p>${txt}</p></div></div><div class="col-12 col-sm-6 icon-container" contenteditable="false" style="white-space: nowrap;"><div class="d-flex justify-content-center align-items-center h-100"><i class="bi bi-info icon-xl" aria-hidden="true"></i></div></div></div></div>`,

    // Accordion (plain). Header is a DIV with the h3 nested inside it.
    accordion(id, itemsHTML) {
      return `<div class="col-12"><div class="d-flex justify-content-end" contenteditable="false"><button class="btn btn-secondary mb-3 accordion-toggle-button" data-accordion-id="${id}">Open All</button></div><div class="accordion" id="${id}">${itemsHTML}</div></div>`;
    },
    accordionItem(id, i, heading, bodyHTML) {
      return `<div class="accordion-item"><div class="accordion-header" role="heading" aria-level="3" id="${id}-header-${i}"><div class="deletion-guard" contenteditable="true"><br></div><h3><button class="accordion-button collapsed" type="button" data-bs-toggle="collapse" data-bs-target="#${id}-collapse-${i}" aria-expanded="true" aria-controls="${id}-collapse-${i}" contenteditable="false"> <span contenteditable="true">${heading}</span> </button></h3></div><div id="${id}-collapse-${i}" class="accordion-collapse collapse show" aria-labelledby="${id}-header-${i}"><div class="deletion-guard" contenteditable="true"><br></div><div class="accordion-body"><div contenteditable="false"><div contenteditable="true">${bodyHTML}</div></div></div></div></div>`;
    },

    // Transcript accordion: a single-item accordion for an image's long
    // description / text transcript. NO "Open All" button, and the class
    // "transcript" is added alongside "accordion" on the same div. Lives in its
    // own row so it can be deleted independently of the image.
    transcriptAccordion(id, heading, bodyHTML) {
      const item = this.accordionItem(id, 0, heading || 'Image description', bodyHTML || '<p>Describe the image / transcribe its text here.</p>');
      return `<div class="col-12"><div class="accordion transcript" id="${id}">${item}</div></div>`;
    },

    // Horizontal tabs. Nav <ul> carries the classes; content in a separate div.
    horizontalTabs(id, navHTML, panesHTML) {
      return `<div class="col-12"><ul class="nav nav-tabs nav-fill horizontal-tabs wysiwyg-mode" id="${id}-nav" role="tablist" contenteditable="false">${navHTML}</ul><div class="tab-content border border-1 p-3 wysiwyg-mode" id="${id}-content" contenteditable="false">${panesHTML}</div></div>`;
    },
    hTabNav(id, i, heading, active) {
      return `<li class="nav-item" role="presentation"><span class="deletion-guard" contenteditable="true"></span> <button class="nav-link${active ? ' active' : ' '}" id="${id}-tab-${i}" data-bs-toggle="tab" data-bs-target="#${id}-content-${i}" role="tab" aria-controls="${id}-content-${i}" aria-selected="${active ? 'true' : 'false'}" type="button" contenteditable="false"><span class="deletion-guard" contenteditable="true">&nbsp;</span><span contenteditable="true">${heading}</span><span class="deletion-guard" contenteditable="true">&nbsp;</span></button><span class="deletion-guard" contenteditable="true"></span></li>`;
    },
    hTabPane(id, i, bodyHTML, active) {
      return `<div class="tab-pane${active ? ' active' : ' '}" id="${id}-content-${i}" role="tabpanel" aria-labelledby="${id}-tab-${i}"><div contenteditable="true">${bodyHTML}</div></div>`;
    },

    // Flip cards. The COLUMN class depends on the total card count (the block
    // builder rebalances: 2 -> col-12 col-sm-6; 3 -> col-12 col-md-4;
    // 4+ -> col-12 col-sm-6 col-lg-3). Pass the column class in.
    flipCards(cardsHTML) {
      return `<div class="flip-cards" contenteditable="false">${cardsHTML}</div>`;
    },
    flipCard(i, front, backHeading, backBody, colClass) {
      return `<div class="${colClass || 'col-12 col-sm-6'}"><div class="flip-card-container"><div class="flip-card mx-auto my-3 show" aria-labelledby="flip-card-title-${i}"><div class="flip-card-inner" aria-label="Flip card" tabindex="0"><div class="flip-card-front"><div class="flip-card-front-content"><div contenteditable="true"><h3 id="flip-card-title-${i}">${front}</h3></div></div></div><div class="flip-card-back"><div class="flip-card-back-content"><div class="flip-card-header-primary"><div contenteditable="true"><h3>${backHeading}</h3></div></div><div class="flip-card-back-body"><div contenteditable="true"><p>${backBody}</p></div></div></div></div></div></div></div></div>`;
    },

    // PDF embed. .pdf-container carries the aspect-ratio (modern CSS), the embed
    // points at the PDF (with #toolbar=0 by default). Lives in a col-12.
    // (Note: loading="lazy" isn't honoured on <embed>, so it's not set here;
    // it IS set on YouTube <iframe>s where it works.)
    pdfEmbed(src, ratioCss) {
      return `<div class="col-12"><div class="pdf-container" style="aspect-ratio: ${ratioCss};"><embed src="${src}" type="application/pdf" width="100%" height="100%"></div></div>`;
    },
  };

  // Aspect-ratio presets for PDF embeds. value = CSS aspect-ratio (width / height).
  // A4 portrait is 1 : √2 ≈ 1 : 1.414; landscape is the inverse.
  const PDF_RATIOS = [
    { label: 'A4 portrait (1 : 1.414)',  css: '1 / 1.414', default: true },
    { label: 'A4 landscape (1.414 : 1)', css: '1.414 / 1' },
    { label: '4 : 3',                    css: '4 / 3' },
    { label: '16 : 9',                   css: '16 / 9' },
    { label: 'Custom…',                  css: null },
  ];


  // The column class the block builder applies to each flip card given the TOTAL
  // number of cards. Matches the builder's responsive breakpoints.
  function flipColClass(count) {
    if (count <= 2) return 'col-12 col-sm-6';
    if (count === 3) return 'col-12 col-md-4';
    return 'col-12 col-sm-6 col-lg-3'; // 4 or more
  }

  // Re-apply the correct column class to every flip card in a .flip-cards
  // container, based on how many there are. Call after adding/removing a card.
  function rebalanceFlipCards(flipCardsEl) {
    const cols = flipCardsEl.querySelectorAll(':scope > [class*="col-"]');
    const cls = flipColClass(cols.length);
    cols.forEach(col => { col.className = cls; });
  }

  // ─── BOOTSTRAP ICONS (subset for the in-page picker) ───────────────────────
  // Full list deliberately omitted to keep script small; add more as needed
  const QUICK_ICONS = [
    'star-fill','check-circle-fill','info-circle-fill','exclamation-triangle-fill',
    'lightbulb-fill','heart-fill','bookmark-fill','gear-fill','person-fill',
    'people-fill','shield-fill','rocket-takeoff-fill','mortarboard-fill','trophy-fill',
    'clock-fill','calendar-fill','envelope-fill','telephone-fill','house-fill',
    'folder-fill','file-earmark-text-fill','bar-chart-fill','pie-chart-fill',
    'graph-up-arrow','arrow-right-circle-fill','plus-circle-fill','dash-circle-fill',
    'x-circle-fill','question-circle-fill','chat-dots-fill','megaphone-fill',
    'bell-fill','flag-fill','tag-fill','lock-fill','unlock-fill','key-fill',
    'tools','wrench-adjustable','cpu-fill','hdd-fill','wifi','bluetooth',
    'camera-fill','image-fill','play-circle-fill','music-note-beamed','film',
    'globe','globe2','map-fill','geo-alt-fill','compass','hospital-fill',
    'capsule-pill','heart-pulse-fill','activity','bandaid-fill','lungs-fill'
  ];

  // ─── UTILITY ───────────────────────────────────────────────────────────────
  function uid(prefix = 'bb') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  // Safe CSS identifier escaper. Uses native CSS.escape where available, with a
  // fallback so a missing CSS.escape can never throw mid-clone.
  function cssEsc(s) {
    s = String(s);
    try {
      if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
        return CSS.escape(s);
      }
    } catch {}
    return s.replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  }

  // Detect a Brightspace Creator+ embed / TinyMCE noneditable region. These
  // strip or scope out our CSS and classes, so fixes whose only effect comes
  // from a CSS class (e.g. a .visually-hidden span) must not be applied
  // inside one — the "hidden" text would render visible instead.
  function isInCreatorPlus(el) {
    return !!(el && el.closest && el.closest(
      '[class*="d2l-element"], [class^="d2l-cplus"], [class*=" d2l-cplus"], .mceNonEditable'
    ));
  }

  function copyToClipboard(html) {
    // Rich (WYSIWYG) copy — for history re-copy
    const blob = new Blob([html], { type: 'text/html' });
    const item = new ClipboardItem({ 'text/html': blob });
    navigator.clipboard.write([item]).catch(() => {
      navigator.clipboard.writeText(html);
    });
  }

  function copyAsText(text) {
    // Plain-text copy — for HTML source view paste
    navigator.clipboard.writeText(text).catch(err => {
      console.warn('[Edit Toolkit] clipboard.writeText failed', err);
    });
  }

  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.textContent = msg;
    Object.assign(el.style, {
      position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
      background: type === 'success' ? '#198754' : type === 'warn' ? '#fd7e14' : '#dc3545',
      color: '#fff', padding: '8px 18px', borderRadius: '6px', fontSize: '13px',
      zIndex: 2000000, pointerEvents: 'none', boxShadow: '0 2px 8px rgba(0,0,0,.3)'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  // ─── TINY MCE DETECTION ────────────────────────────────────────────────────
  // D2L exposes tinymce on the main page window. We use unsafeWindow to reach
  // through Tampermonkey's sandbox, then access the editor iframe document
  // directly via tinymce.activeEditor.getDoc() / iframeElement.

  function getTinyEditor() {
    try {
      const tm = unsafeWindow.tinymce;
      if (!tm) return null;
      return tm.activeEditor || (tm.editors && tm.editors[0]) || null;
    } catch { return null; }
  }

  function syncTinyRefs() {
    const ed = getTinyEditor();
    if (!ed) return false;
    try {
      tinyDoc   = ed.getDoc();
      tinyWin   = tinyDoc.defaultView;
      tinyFrame = ed.iframeElement;
      return !!(tinyDoc && tinyDoc.body);
    } catch { return false; }
  }

  function waitForTinyMCE(callback, attempts = 0) {
    if (attempts > 80) {
      // Give up waiting but still build the panel — shows "editor not found"
      console.warn('[Edit Toolkit] TinyMCE not found after 40s — building panel anyway');
      callback();
      return;
    }
    if (syncTinyRefs()) {
      callback();
    } else {
      setTimeout(() => waitForTinyMCE(callback, attempts + 1), 500);
    }
  }

  // ─── COMPONENT DETECTION ───────────────────────────────────────────────────
  // Detectors. `match(el)` (optional) is an extra predicate when a CSS selector
  // alone can't distinguish variants. The three accordions all share class
  // "accordion": numbered adds .numbered-accordion; icon is identified by its
  // .icon-header buttons; plain is neither.
  const COMPONENT_DETECTORS = [
    { type: 'Numbered Accordion', sel: '.accordion.numbered-accordion', itemSel: '.accordion-item' },
    { type: 'Icon Accordion',     sel: '.accordion',  itemSel: '.accordion-item',
      match: el => !el.classList.contains('numbered-accordion') && !!el.querySelector('.accordion-button.icon-header') },
    { type: 'Accordion',          sel: '.accordion',  itemSel: '.accordion-item',
      match: el => !el.classList.contains('numbered-accordion') && !el.querySelector('.accordion-button.icon-header') },
    { type: 'Horizontal Tabs',    sel: '.horizontal-tabs',      itemSel: '.nav-item' },
    { type: 'Vertical Tabs',      sel: '.vertical-tabs-wrapper',itemSel: '.nav-item' },
    { type: 'Flipcards',          sel: '.flip-cards',           itemSel: '.flip-card-container' },
    { type: 'Text Carousel',      sel: '.text-carousel',        itemSel: '.carousel-item' },
    { type: 'Image Carousel',     sel: '.image-carousel',       itemSel: '.carousel-item' },
    { type: 'Click and Reveal',   sel: '[class*="reveal-container"]', itemSel: null },
    { type: 'Reveal Table',       sel: '.reveal-table',         itemSel: 'tbody tr' },
    { type: 'Icon List',          sel: '.icon-list',            itemSel: 'li' },
    { type: 'Icon Card',          sel: '.card-with-icon',       itemSel: null },
    { type: 'Image',              sel: '.image-container',      itemSel: null },
    { type: 'Image Column',       sel: '.image-column',         itemSel: null },
  ];

  function detectComponents() {
    if (!tinyDoc) return [];
    const found = [];
    const seen = new Set(); // avoid double-listing an element under two detectors
    for (const d of COMPONENT_DETECTORS) {
      const els = tinyDoc.querySelectorAll(d.sel);
      els.forEach(el => {
        if (seen.has(el)) return;
        if (d.match && !d.match(el)) return;
        seen.add(el);
        const count = d.itemSel ? el.querySelectorAll(d.itemSel).length : null;
        found.push({ type: d.type, el, count, detector: d });
      });
    }
    // The loop above groups results by detector (all accordions, then all tabs,
    // …). Re-sort into the order the elements actually appear on the page, using
    // DOM position, so the panel list mirrors top-to-bottom page order.
    found.sort((a, b) => {
      if (a.el === b.el) return 0;
      const pos = a.el.compareDocumentPosition(b.el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1; // a before b
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;  // a after b
      return 0;
    });
    return found;
  }

  // ─── FIX / REPAIR PAGE (preview-first) ──────────────────────────────────────
  // Two phases: scanFixIssues() inspects the page WITHOUT mutating and returns a
  // structured list of (a) auto-fixable actions, each with an apply() closure and
  // an individual toggle, and (b) review-only flags needing human judgement.
  // showFixPreview() renders both as a checklist; only the toggled-on fixes run
  // when the user clicks Apply (all within one tinyWrite = one undo step).

  function scanFixIssues() {
    const ed = getTinyEditor();
    if (!ed) return null;
    const body = ed.getBody();
    const fixes = [];
    const reviews = [];
    let n = 0;
    const fid = () => 'fx' + (++n);

    // 1. Duplicate ids.
    {
      const seen = new Map();
      const dups = [];
      body.querySelectorAll('[id]').forEach(el => {
        if (!seen.has(el.id)) { seen.set(el.id, el); return; }
        dups.push(el);
      });
      dups.forEach(el => {
        const origId = el.id;
        fixes.push({
          id: fid(), category: 'Structure',
          label: `Duplicate id "${origId}" → make unique`,
          apply: () => {
            const scope = el.closest('.row.wysiwyg-mode') || body;
            const newId = origId + '-' + Math.random().toString(36).slice(2, 6);
            scope.querySelectorAll(`[data-bs-target="#${cssEsc(origId)}"]`).forEach(r => r.setAttribute('data-bs-target', '#' + newId));
            scope.querySelectorAll(`[aria-controls="${cssEsc(origId)}"]`).forEach(r => r.setAttribute('aria-controls', newId));
            scope.querySelectorAll(`[aria-labelledby="${cssEsc(origId)}"]`).forEach(r => r.setAttribute('aria-labelledby', newId));
            el.id = newId;
          }
        });
      });
    }

    // 2. "Open All" on single-item accordion.
    body.querySelectorAll('.accordion:not(.transcript)').forEach(acc => {
      if (acc.querySelectorAll('.accordion-item').length <= 1) {
        const btn = acc.parentElement && acc.parentElement.querySelector(`.accordion-toggle-button[data-accordion-id="${cssEsc(acc.id)}"]`);
        if (btn) fixes.push({
          id: fid(), category: 'Structure',
          label: 'Remove "Open All" from a single-item accordion',
          apply: () => { (btn.closest('.d-flex.justify-content-end') || btn).remove(); }
        });
      }
    });

    // 3. "Open All" on transcript accordion.
    body.querySelectorAll('.accordion.transcript').forEach(acc => {
      const btn = acc.parentElement && acc.parentElement.querySelector('.accordion-toggle-button');
      if (btn) fixes.push({
        id: fid(), category: 'Structure',
        label: 'Remove "Open All" from a transcript accordion',
        apply: () => { (btn.closest('.d-flex.justify-content-end') || btn).remove(); }
      });
    });

    // 4. Carousel desync.
    body.querySelectorAll('.text-carousel, .image-carousel').forEach(car => {
      const wrapper = car.classList.contains('carousel') ? car : car.querySelector('.carousel');
      fixes.push({
        id: fid(), category: 'Structure',
        label: 'Re-sync carousel indicators & slide labels',
        apply: () => { resequenceCarousel(wrapper || car); }
      });
    });

    // 4b. Accordion button self-contradicts (collapsed class vs aria-expanded)
    // — a WYSIWYG paste/clone artifact. Editor intent is "all open", so sync
    // the button to match aria-expanded rather than forcing closed; the
    // published page's own enforceCollapsedBaseline() will close everything
    // correctly at runtime regardless of what ships here.
    body.querySelectorAll('.accordion-button, .reveal-button').forEach(btn => {
      const ariaOpen = btn.getAttribute('aria-expanded') === 'true';
      const classOpen = !btn.classList.contains('collapsed');
      if (ariaOpen === classOpen) return;
      fixes.push({
        id: fid(), category: 'Structure',
        label: 'Accordion/reveal button state contradicts itself (collapsed class vs aria-expanded) → sync',
        apply: () => { btn.classList.toggle('collapsed', !ariaOpen); }
      });
    });

    // 5. Decorative image must have alt="" (auto-fixable).
    body.querySelectorAll('img').forEach(img => {
      const figure = img.closest('figure');
      const isDecorative = (figure && figure.classList.contains('decorative')) || img.classList.contains('decorative');
      if (isDecorative && img.getAttribute('alt') !== '') {
        fixes.push({
          id: fid(), category: 'Accessibility',
          label: 'Decorative image → alt=""',
          apply: () => { img.setAttribute('alt', ''); }
        });
      }
    });

    // 6. Image accessibility REVIEW flags (no safe auto-fix).
    body.querySelectorAll('img').forEach(img => {
      const figure = img.closest('figure');
      const cap = figure && figure.querySelector('figcaption');
      const hasCaption = !!cap;
      const isDecorative = (figure && figure.classList.contains('decorative')) || img.classList.contains('decorative');
      const alt = img.getAttribute('alt');
      const src = img.getAttribute('src') || '';
      const placeholder = /placehold/i.test(src);
      if (isDecorative) return;
      if (!hasCaption && (alt === '' || alt == null)) {
        reviews.push({ category: 'Accessibility', el: img,
          label: 'Informative image has no caption AND no alt — add a caption or alt text' + (placeholder ? ' (placeholder image)' : '') });
      } else if (hasCaption && alt && alt !== 'REQUIRED' && alt.trim() === (cap.textContent || '').trim()) {
        reviews.push({ category: 'Accessibility', el: img,
          label: 'Image alt duplicates its caption — consider alt="" to avoid double-reading' });
      } else if (alt === 'REQUIRED') {
        reviews.push({ category: 'Accessibility', el: img,
          label: 'Image still has placeholder alt "REQUIRED" — set real alt or make decorative' });
      }
    });

    // 7. Heading hierarchy: a heading that jumps more than one level below the
    // previous one (e.g. h2 → h4) can be promoted one level. Re-running catches
    // deeper chains.
    {
      const heads = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .filter(h => (h.textContent || '').trim() !== '');
      let prevLevel = null;
      heads.forEach(h => {
        const lvl = parseInt(h.tagName[1], 10);
        if (prevLevel !== null && lvl > prevLevel + 1) {
          const targetLvl = prevLevel + 1;
          fixes.push({
            id: fid(), category: 'Accessibility',
            label: `Heading skips a level (${h.tagName.toLowerCase()} after h${prevLevel}) → promote to h${targetLvl}`,
            apply: () => {
              const repl = tinyDoc.createElement('h' + targetLvl);
              for (const a of Array.from(h.attributes)) repl.setAttribute(a.name, a.value);
              while (h.firstChild) repl.appendChild(h.firstChild);
              h.replaceWith(repl);
            }
          });
          prevLevel = targetLvl;
        } else {
          prevLevel = lvl;
        }
      });
    }

    // 7b. Multiple <h1> elements: only one per page. Keep the first, downgrade
    // the rest to <h2> (the heading-hierarchy check above then catches any
    // resulting skip on a re-run).
    {
      const h1s = Array.from(body.querySelectorAll('h1'));
      if (h1s.length > 1) {
        const extra = h1s.slice(1);
        fixes.push({
          id: fid(), category: 'Accessibility',
          label: `${extra.length} extra <h1>(s) found → downgrade to <h2> (first one kept)`,
          apply: () => {
            extra.forEach(h => {
              const repl = tinyDoc.createElement('h2');
              for (const a of Array.from(h.attributes)) repl.setAttribute(a.name, a.value);
              while (h.firstChild) repl.appendChild(h.firstChild);
              h.replaceWith(repl);
            });
          }
        });
      }
    }

    // 7c. Links to PDF files should say so in the link text. If some form of
    // "pdf" is already present, normalise it to the standard "[PDF]" marker
    // instead of appending a second one.
    body.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!/\.pdf(?:[?#]|$)/i.test(href)) return;
      const text = (a.textContent || '').trim();
      if (!text || /\[PDF\]$/.test(text)) return;
      const hasPdfMention = /pdf/i.test(text);
      fixes.push({
        id: fid(), category: 'Links',
        label: (hasPdfMention ? 'Standardise PDF mention → "[PDF]": "' : 'Add "[PDF]" to link text: "') + text.slice(0, 30) + '"',
        apply: () => {
          if (hasPdfMention) {
            const walker = tinyDoc.createTreeWalker(a, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if (/pdf/i.test(node.nodeValue)) {
                node.nodeValue = node.nodeValue.replace(/\(?\s*pdf\s*\)?/i, '[PDF]');
                return;
              }
            }
            a.appendChild(tinyDoc.createTextNode(' [PDF]'));
          } else {
            a.appendChild(tinyDoc.createTextNode(' [PDF]'));
          }
        }
      });
    });

    // 8. Table accessibility: missing <caption>; header row not using
    // <th scope="col">; first-column row headers not using <th scope="row">.
    body.querySelectorAll('table').forEach(tbl => {
      if (!tbl.querySelector('caption')) {
        fixes.push({
          id: fid(), category: 'Accessibility',
          label: 'Table has no caption → add one (you fill in the text)',
          apply: () => {
            const cap = tinyDoc.createElement('caption');
            cap.textContent = 'Table caption';
            tbl.insertBefore(cap, tbl.firstChild);
          }
        });
      }
      const firstRow = tbl.querySelector('tr');
      if (firstRow) {
        const tds = firstRow.querySelectorAll('td');
        const thsNoScope = firstRow.querySelectorAll('th:not([scope])');
        if (tds.length) {
          fixes.push({
            id: fid(), category: 'Accessibility',
            label: 'Table header row uses <td> → convert to <th scope="col">',
            apply: () => {
              firstRow.querySelectorAll('td').forEach(td => {
                const th = tinyDoc.createElement('th');
                th.setAttribute('scope', 'col');
                for (const a of Array.from(td.attributes)) th.setAttribute(a.name, a.value);
                while (td.firstChild) th.appendChild(td.firstChild);
                td.replaceWith(th);
              });
            }
          });
        } else if (thsNoScope.length) {
          fixes.push({
            id: fid(), category: 'Accessibility',
            label: 'Table header cells missing scope → add scope="col"',
            apply: () => { firstRow.querySelectorAll('th:not([scope])').forEach(th => th.setAttribute('scope', 'col')); }
          });
        }
      }

      // Row-header pattern: every row's first cell is a <th> (common for
      // "spec sheet" style tables where the left column labels each row).
      // Handles the common single-header-column case automatically; a
      // table mixing both a header row AND a header column, or with
      // multi-level/spanning headers, is genuinely ambiguous and is left
      // for manual review rather than guessed at.
      const rows = [...tbl.querySelectorAll('tr')];
      if (rows.length > 1) {
        const allFirstCellsAreTh = rows.every(tr => tr.firstElementChild && tr.firstElementChild.tagName === 'TH');
        const bodyRows = rows.slice(firstRow && firstRow.querySelectorAll('th').length ? 1 : 0); // skip an already-handled header row
        const rowHeaderThsNoScope = bodyRows
          .map(tr => tr.firstElementChild)
          .filter(th => th && th.tagName === 'TH' && !th.getAttribute('scope'));
        if (allFirstCellsAreTh && rowHeaderThsNoScope.length) {
          fixes.push({
            id: fid(), category: 'Accessibility',
            label: `Row-header table: ${rowHeaderThsNoScope.length} first-column <th> missing scope → add scope="row"`,
            apply: () => { rowHeaderThsNoScope.forEach(th => th.setAttribute('scope', 'row')); }
          });
        }
      }
    });

    // 8b. Missing lang attribute on the page's <html> element → default to English.
    {
      const htmlEl = body.ownerDocument && body.ownerDocument.documentElement;
      if (htmlEl && !htmlEl.getAttribute('lang')) {
        fixes.push({
          id: fid(), category: 'Structure',
          label: 'No lang attribute on the page → set lang="en"',
          apply: () => { htmlEl.setAttribute('lang', 'en'); }
        });
      }
    }

    // 9. Link-text quality (review only): vague link text or bare URLs.
    body.querySelectorAll('a[href]').forEach(a => {
      const t = (a.textContent || '').trim().toLowerCase();
      if (!t) return;
      const vague = ['click here', 'here', 'read more', 'more', 'link', 'this', 'this link'];
      if (vague.includes(t)) {
        reviews.push({ category: 'Accessibility', el: a, label: `Vague link text "${a.textContent.trim()}" — describe the destination` });
      } else if (/^https?:\/\//i.test(a.textContent.trim())) {
        reviews.push({ category: 'Accessibility', el: a, label: 'Link text is a bare URL — use descriptive words instead' });
      }
    });

    // 10. Oversized images (review only): natural width far larger than ~1920.
    body.querySelectorAll('img').forEach(img => {
      const nw = img.naturalWidth || 0;
      if (nw && nw > 2400) {
        reviews.push({ category: 'Performance', el: img, label: `Large image (${nw}px wide source) — consider resizing to ~1920px` });
      }
    });

    // 11. Links carrying tracking params (page-wide strip).
    {
      const dirty = [];
      body.querySelectorAll('a[href]').forEach(a => {
        const r = stripTrackingFromUrl(a.getAttribute('href') || '');
        if (r.removed.length) dirty.push({ a, url: r.url, removed: r.removed });
      });
      if (dirty.length) {
        const total = dirty.reduce((s, d) => s + d.removed.length, 0);
        fixes.push({
          id: fid(), category: 'Links',
          label: `Strip tracking params from ${dirty.length} link(s) (${total} param(s))`,
          apply: () => { dirty.forEach(d => { d.a.setAttribute('href', d.url); d.a.removeAttribute('data-mce-href'); }); }
        });
      }
    }

    // 12. External links missing target/rel (page-wide).
    {
      const ext = [];
      body.querySelectorAll('a[href]').forEach(a => {
        if (isExternalHref(a.getAttribute('href') || '') && a.getAttribute('target') !== '_blank') ext.push(a);
      });
      if (ext.length) {
        fixes.push({
          id: fid(), category: 'Links',
          label: `Make ${ext.length} external link(s) open in a new tab (+ safe rel)`,
          apply: () => { ext.forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer'); }); }
        });
      }
    }

    // 13. Embeds without loading="lazy" (page-wide perf).
    {
      const eager = [];
      body.querySelectorAll('iframe:not([loading])').forEach(f => eager.push(f));
      if (eager.length) {
        fixes.push({
          id: fid(), category: 'Performance',
          label: `Add lazy-loading to ${eager.length} iframe embed(s)`,
          apply: () => { eager.forEach(f => f.setAttribute('loading', 'lazy')); }
        });
      }
    }

    // 14. Full WCAG 2.1 AA pass via the shared detection engine (same rules
    // the Audit Toolkit reports in view mode — kept in sync by living in
    // rcpi-shared-core.js instead of being hand-duplicated here). A handful
    // of categories have a safe, unambiguous auto-fix; everything else is
    // review-only, same as Audit's read-only report.
    if (S) {
      try {
        const a11y = S.runA11y(body);
        a11y.issues.forEach(is => {
          // Tables: this section's own check #8 (above) already owns
          // caption + scope handling with table-aware context (which row
          // is the header row, etc.) that the shared engine can't see —
          // skip here so the same table doesn't get flagged twice.
          if (is.category === 'Tables') return;
          // Multiple <h1>s: this section's own check #7b (above) already
          // owns this with a real fix — skip so it isn't also review-flagged
          // once per extra <h1>.
          if (is.category === 'Headings' && /Multiple h1/.test(is.msg)) return;
          // lang attribute: this section's own check #8b (above) already
          // owns this with a real fix.
          if (is.category === 'Structure' && /lang attribute/.test(is.msg)) return;
          if (!is.el) { if (is.severity !== 'info') reviews.push({ category: is.category, el: null, label: is.msg }); return; }
          if (is.fix === 'add-empty-alt') {
            fixes.push({ id: fid(), category: 'Accessibility', label: `Decorative image → alt="" — "${is.msg.slice(0, 40)}"`,
              apply: () => is.el.setAttribute('alt', '') });
          } else if (is.fix === 'b-to-strong') {
            fixes.push({ id: fid(), category: 'Semantics', label: `<b> → <strong>: "${is.el.textContent.trim().slice(0, 30)}"`,
              apply: () => { const r = tinyDoc.createElement('strong'); for (const a of Array.from(is.el.attributes)) r.setAttribute(a.name, a.value); while (is.el.firstChild) r.appendChild(is.el.firstChild); is.el.replaceWith(r); } });
          } else if (is.fix === 'remove-empty') {
            fixes.push({ id: fid(), category: 'Hygiene', label: 'Remove empty paragraph (paste artefact)', apply: () => is.el.remove() });
          } else if (is.fix === 'add-new-window-note') {
            // The visible new-tab icon on these links isn't itself
            // accessible text — a screen reader announces nothing extra
            // for it. Adds a visually-hidden note so the warning is heard
            // without changing what's visually on the page. Skip inside a
            // Creator+ embed: .visually-hidden's CSS is stripped there, so
            // the note would render as visible text instead of staying hidden.
            if (isInCreatorPlus(is.el)) return;
            fixes.push({ id: fid(), category: 'Links', label: `Add "(opens in a new tab)" note: "${is.el.textContent.trim().slice(0, 30)}"`,
              apply: () => { const span = tinyDoc.createElement('span'); span.className = 'visually-hidden'; span.textContent = ' (opens in a new tab)'; is.el.appendChild(span); } });
          } else if (is.severity !== 'info') {
            // No safe auto-fix — surface for human review, same bucket as
            // the existing image-alt review flags above.
            reviews.push({ category: is.category, el: is.el, label: is.msg });
          }
        });
      } catch (e) { dbg('shared a11y scan failed', e); }
    }

    // 15. Reveal items must stay expanded (.collapse.show) while editing.
    // Only the runtime cleanup script (bootstrap-custom-cleanup.js,
    // initRevealBaseline/enforceCollapsedBaseline) is meant to collapse
    // these — for view-mode learners. Inside the editor they should always
    // be visibly open; a panel missing either class means the author sees
    // it closed/hidden and may not realise there's content underneath.
    body.querySelectorAll('.reveal-item').forEach(item => {
      const panel = item.querySelector(':scope > div[id^="reveal-"]') || item.querySelector(':scope > div.collapse') || item.querySelector(':scope > div');
      if (!panel) return;
      const missingCollapse = !panel.classList.contains('collapse');
      const missingShow = !panel.classList.contains('show');
      if (missingCollapse || missingShow) {
        const missing = [missingCollapse && '"collapse"', missingShow && '"show"'].filter(Boolean).join(' and ');
        fixes.push({
          id: fid(), category: 'Structure',
          label: `Reveal item panel missing ${missing} class → expand it for editing`,
          apply: () => { panel.classList.add('collapse', 'show'); }
        });
      }
    });

    // Expansion point: anything registered via RCPIShared.registerFixCheck()
    // elsewhere gets merged in here automatically — add new fixes without
    // touching this function.
    if (S) {
      try {
        S.runCustomFixChecks({ body, ed: getTinyEditor(), doc: tinyDoc }).forEach(f => {
          fixes.push({ id: fid(), category: f.category || 'Custom', label: f.label, apply: f.apply });
        });
      } catch (e) { dbg('custom fix checks failed', e); }
    }

    return { fixes, reviews };
  }

  function showFixPreview() {
    syncTinyRefs();
    const scan = scanFixIssues();
    if (!scan) { toast('Editor API unavailable — cannot scan', 'error'); return; }
    const { fixes, reviews } = scan;

    if (!fixes.length && !reviews.length) {
      toast('✓ No issues found — page looks clean', 'success');
      return;
    }

    const byCat = (arr) => {
      const g = {};
      arr.forEach(x => { (g[x.category] = g[x.category] || []).push(x); });
      return g;
    };

    let html = '';
    if (fixes.length) {
      html += `<div class="bb-fix-sec-h">Will fix (${fixes.length}) — untick any you want to skip:</div>`;
      const groups = byCat(fixes);
      Object.keys(groups).forEach(cat => {
        html += `<div class="bb-fix-cat">${escapeHtml(cat)}</div>`;
        groups[cat].forEach(f => {
          html += `<label class="bb-fix-row"><input type="checkbox" class="bb-fix-chk" data-fix="${f.id}" checked> <span>${escapeHtml(f.label)}</span></label>`;
        });
      });
    }
    if (reviews.length) {
      html += `<div class="bb-fix-sec-h bb-fix-sec-review">Needs your attention (${reviews.length}) — no automatic fix:</div>`;
      const groups = byCat(reviews);
      Object.keys(groups).forEach(cat => {
        html += `<div class="bb-fix-cat">${escapeHtml(cat)}</div>`;
        groups[cat].forEach((r, i) => {
          const rid = 'rv' + i + '-' + cat.replace(/\s/g, '');
          r._rid = rid;
          html += `<div class="bb-fix-row bb-fix-review"><span>${escapeHtml(r.label)}</span>${r.el ? ` <button class="bb-fix-goto" data-rid="${rid}">↗</button>` : ''}</div>`;
        });
      });
    }
    html += `<div class="bb-fix-actions"><button id="bb-fix-apply" class="bb-btn bb-btn-img">Apply ticked fixes</button> <button id="bb-fix-cancel" class="bb-btn bb-btn-goto">Close</button></div>`;

    showModal('Page check & fix', html);

    const modal = document.getElementById('bb-modal');
    if (!modal) return;

    modal.querySelectorAll('.bb-fix-goto').forEach(btn => {
      btn.addEventListener('click', () => {
        const rid = btn.getAttribute('data-rid');
        const r = reviews.find(x => x._rid === rid);
        if (r && r.el) { try { r.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {} }
      });
    });

    const cancel = modal.querySelector('#bb-fix-cancel');
    if (cancel) cancel.addEventListener('click', () => modal.remove());

    const applyBtn = modal.querySelector('#bb-fix-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      const chosen = new Set();
      modal.querySelectorAll('.bb-fix-chk:checked').forEach(c => chosen.add(c.getAttribute('data-fix')));
      const toApply = fixes.filter(f => chosen.has(f.id));
      if (!toApply.length) { toast('No fixes ticked', 'warn'); modal.remove(); return; }
      const didWrite = tinyWrite((ed) => {
        const b = ed.getBody();
        toApply.forEach(f => { try { f.apply(b); } catch (err) { dbg('fix failed', f.label, err); } });
      }, 'apply page fixes', { ungated: true });
      modal.remove();
      if (didWrite) {
        toast(`✓ Applied ${toApply.length} fix${toApply.length > 1 ? 'es' : ''}`, 'success');
        scheduleAudit();
        refreshComponentList();
      } else {
        toast('Editor API unavailable — could not apply', 'error');
      }
    });
  }

  // The 🔧 button / shortcut now opens the preview-first flow.
  function runFixPage() { showFixPreview(); }

  // ── legacy (unused): kept temporarily for reference, not called ─────────────
  function runFixPageLegacy() {
    const report = { fixed: [], review: [] };

    const didWrite = tinyWrite((ed) => {
      const body = ed.getBody();

      // 1. Duplicate ids -> suffix later duplicates to make them unique.
      const seen = new Map();
      body.querySelectorAll('[id]').forEach(el => {
        const id = el.id;
        if (!seen.has(id)) { seen.set(id, el); return; }
        // duplicate: re-id this one and fix its internal references within its
        // nearest component/row so wiring stays consistent.
        const scope = el.closest('.row.wysiwyg-mode') || body;
        const newId = id + '-' + Math.random().toString(36).slice(2, 6);
        scope.querySelectorAll(`[data-bs-target="#${cssEsc(id)}"]`).forEach(r => r.setAttribute('data-bs-target', '#' + newId));
        scope.querySelectorAll(`[aria-controls="${cssEsc(id)}"]`).forEach(r => r.setAttribute('aria-controls', newId));
        scope.querySelectorAll(`[aria-labelledby="${cssEsc(id)}"]`).forEach(r => r.setAttribute('aria-labelledby', newId));
        el.id = newId;
        report.fixed.push(`Duplicate id "${id}" → made unique`);
      });

      // 2. Single-item accordion with an "Open All" button -> remove the button.
      // (Open All only makes sense with 2+ items.) Skip transcript accordions.
      body.querySelectorAll('.accordion:not(.transcript)').forEach(acc => {
        const items = acc.querySelectorAll('.accordion-item').length;
        if (items <= 1) {
          // the toggle button is a sibling above, in a d-flex wrapper
          const wrap = acc.parentElement && acc.parentElement.querySelector('.d-flex.justify-content-end');
          const btn = acc.parentElement && acc.parentElement.querySelector(`.accordion-toggle-button[data-accordion-id="${cssEsc(acc.id)}"]`);
          if (btn) {
            const container = btn.closest('.d-flex.justify-content-end') || btn;
            container.remove();
            report.fixed.push('Removed "Open All" from a single-item accordion');
          }
        }
      });

      // 3. Transcript accordions should never have an Open All button.
      body.querySelectorAll('.accordion.transcript').forEach(acc => {
        const btn = acc.parentElement && acc.parentElement.querySelector('.accordion-toggle-button');
        if (btn) {
          (btn.closest('.d-flex.justify-content-end') || btn).remove();
          report.fixed.push('Removed "Open All" from a transcript accordion');
        }
      });

      // 4. Carousels: repair indicator aria-controls / slide-to / labels and slide
      // ids so they all reference the carousel's real id.
      body.querySelectorAll('.text-carousel, .image-carousel').forEach(car => {
        const wrapper = car.classList.contains('carousel') ? car : car.querySelector('.carousel');
        resequenceCarousel(wrapper || car);
        report.fixed.push('Re-synced carousel indicators & slide labels');
      });

      // 5. Image accessibility review (report only — needs human judgement).
      body.querySelectorAll('img').forEach(img => {
        const figure = img.closest('figure');
        const hasCaption = !!(figure && figure.querySelector('figcaption'));
        const isDecorative = (figure && figure.classList.contains('decorative')) || img.classList.contains('decorative');
        const alt = img.getAttribute('alt');
        const src = img.getAttribute('src') || '';
        const placeholder = /placehold/i.test(src);

        if (isDecorative) {
          // decorative -> must have alt="" ; auto-fix that (safe).
          if (alt !== '') { img.setAttribute('alt', ''); report.fixed.push('Decorative image → alt=""'); }
        } else if (!hasCaption && (alt === '' || alt == null)) {
          report.review.push('Informative image has no caption AND empty/no alt — add a caption or alt text' + (placeholder ? ' (placeholder image)' : ''));
        } else if (hasCaption && alt && alt !== 'REQUIRED' && alt.trim() === (figure.querySelector('figcaption')?.textContent || '').trim()) {
          report.review.push('Image alt duplicates its caption — consider alt="" to avoid double-reading');
        } else if (alt === 'REQUIRED') {
          report.review.push('Image still has placeholder alt "REQUIRED" — set real alt or make decorative');
        }
      });
    }, 'fix page', { ungated: true });

    // Show the report
    if (!didWrite) { toast('Editor API unavailable — cannot run fix', 'error'); return; }
    scheduleAudit();
    refreshComponentList();
    showFixReport(report);
  }

  function showFixReport(report) {
    const total = report.fixed.length + report.review.length;
    if (total === 0) { toast('✓ No issues found — page looks clean', 'success'); return; }

    // De-duplicate repetitive messages with counts.
    const summarize = (arr) => {
      const counts = {};
      arr.forEach(m => { counts[m] = (counts[m] || 0) + 1; });
      return Object.entries(counts).map(([m, n]) => n > 1 ? `${m} ×${n}` : m);
    };
    const fixed = summarize(report.fixed);
    const review = summarize(report.review);

    let html = '';
    if (fixed.length) html += `<div style="font-weight:700;color:#198754;margin-bottom:4px;">Auto-fixed (${report.fixed.length}):</div><ul style="margin:0 0 8px;padding-left:18px;">${fixed.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`;
    if (review.length) html += `<div style="font-weight:700;color:#fd7e14;margin-bottom:4px;">Needs your review (${report.review.length}):</div><ul style="margin:0;padding-left:18px;">${review.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`;

    showModal('Page check & fix', html);
    toast(`Fixed ${report.fixed.length}, ${report.review.length} need review`, report.review.length ? 'warn' : 'success');
  }

  // Minimal modal for the fix report.
  function showModal(title, bodyHTML) {
    const old = document.getElementById('bb-modal');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'bb-modal';
    overlay.innerHTML = `
      <div class="bb-modal-card">
        <div class="bb-modal-head">${escapeHtml(title)}<button class="bb-modal-x">×</button></div>
        <div class="bb-modal-body">${bodyHTML}</div>
      </div>`;
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.bb-modal-x').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  // ─── CONTENT AUDIT ─────────────────────────────────────────────────────────
  function runAudit() {
    if (!tinyDoc) return { issues: [], warnings: 0, errors: 0 };
    const issues = [];

    // Images missing alt
    tinyDoc.querySelectorAll('img').forEach(img => {
      if (!img.hasAttribute('alt')) {
        issues.push({ type: 'error', el: img, msg: 'Image has no alt attribute' });
      } else if (img.alt.trim() === '' && !img.closest('.decorative')) {
        // blank alt is fine for decorative; flag if not inside .decorative
        if (!img.classList.contains('decorative') && !img.closest('figure.decorative')) {
          issues.push({ type: 'warn', el: img, msg: 'Image has empty alt — mark as decorative if intentional' });
        }
      } else if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(img.alt)) {
        issues.push({ type: 'warn', el: img, msg: `Alt text looks like a filename: "${img.alt}"` });
      }
    });

    // Empty headings
    tinyDoc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
      if (h.textContent.trim() === '') {
        issues.push({ type: 'error', el: h, msg: `Empty ${h.tagName.toLowerCase()} heading` });
      }
    });

    // Fake headings (short <p> that is entirely bold/strong)
    tinyDoc.querySelectorAll('p').forEach(p => {
      const text = p.textContent.trim();
      if (!text) return;
      const inner = p.innerHTML.trim();
      if (text.length < 80 && (inner.startsWith('<strong>') || inner.startsWith('<b>'))) {
        const strongText = p.querySelector('strong, b');
        if (strongText && strongText.textContent.trim() === text) {
          issues.push({ type: 'warn', el: p, msg: 'Possible fake heading — consider using a real h2/h3' });
        }
      }
    });

    // Non-descriptive links
    const badLinkText = ['click here','here','read more','more','link','this','learn more','see here','source','article'];
    tinyDoc.querySelectorAll('a[href]').forEach(a => {
      const t = a.textContent.trim().toLowerCase();
      if (badLinkText.includes(t)) {
        issues.push({ type: 'warn', el: a, msg: `Non-descriptive link text: "${a.textContent.trim()}"` });
      }
    });

    // Broken Bootstrap icon classes (bi class present but bi-* absent)
    tinyDoc.querySelectorAll('i.bi').forEach(i => {
      const hasBiIcon = [...i.classList].some(c => c.startsWith('bi-'));
      if (!hasBiIcon) {
        issues.push({ type: 'error', el: i, msg: 'Bootstrap icon element missing bi-* class' });
      }
    });

    // Empty accordion headers
    tinyDoc.querySelectorAll('.accordion-button span[contenteditable]').forEach(span => {
      if (!span.textContent.trim()) {
        issues.push({ type: 'warn', el: span, msg: 'Accordion item has empty heading' });
      }
    });

    // Empty tab labels
    tinyDoc.querySelectorAll('.nav-link span[contenteditable], .nav-link').forEach(el => {
      const t = el.textContent.trim();
      if (!t || t === 'Tab') {
        issues.push({ type: 'warn', el, msg: 'Tab label appears empty or default' });
      }
    });

    const errors   = issues.filter(i => i.type === 'error').length;
    const warnings = issues.filter(i => i.type === 'warn').length;
    return { issues, errors, warnings };
  }

  // ─── NEW ITEM HTML GENERATORS ───────────────────────────────────────────────
  // These mirror the utils.js addXxx functions but return HTML string (no DOM side-effects)

  function genAccordionItem(parentId, index) {
    const id = `${parentId}-item-${index}`;
    return `<div class="accordion-item">
  <div class="accordion-header" role="heading" aria-level="3">
    <div class="deletion-guard" contenteditable="true"></div>
    <h3>
      <button class="accordion-button collapsed" type="button"
              data-bs-toggle="collapse" data-bs-target="#${id}"
              aria-expanded="false" aria-controls="${id}" contenteditable="false">
        <span contenteditable="true">New Item </span>
      </button>
    </h3>
  </div>
  <div id="${id}" class="accordion-collapse collapse show">
    <div class="deletion-guard" contenteditable="true"></div>
    <div class="accordion-body">
      <div contenteditable="false"><div contenteditable="true"><p>Content </p></div></div>
    </div>
  </div>
</div>`;
  }

  function genNumberedAccordionItem(parentId, index) {
    const id = `${parentId}-item-${index}`;
    return `<div class="accordion-item">
  <div class="deletion-guard" contenteditable="true"></div>
  <h3 class="accordion-header" role="heading" aria-level="3">
    <button class="accordion-button collapsed" type="button"
            data-bs-toggle="collapse" data-bs-target="#${id}"
            aria-expanded="false" aria-controls="${id}" contenteditable="false">
      <span contenteditable="true">New Item </span>
    </button>
  </h3>
  <div id="${id}" class="accordion-collapse collapse show">
    <div class="deletion-guard" contenteditable="true"></div>
    <div class="accordion-body">
      <div contenteditable="false"><div contenteditable="true"><p>Content </p></div></div>
    </div>
  </div>
</div>`;
  }

  function genIconAccordionItem(parentId, index) {
    const collapseId = `${parentId}-collapse-${index}`;
    const headerId   = `${parentId}-header-${index}`;
    return `<div class="accordion-item">
  <div class="deletion-guard" contenteditable="true"></div>
  <h3 class="accordion-header" role="heading" aria-level="3" id="${headerId}">
    <button class="accordion-button collapsed d-flex align-items-center gap-2 icon-header"
            type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}"
            aria-expanded="false" aria-controls="${collapseId}" contenteditable="false">
      <i class="bi bi-star-fill icon"></i>
      <span contenteditable="true">New Item </span>
    </button>
  </h3>
  <div id="${collapseId}" class="accordion-collapse collapse show" aria-labelledby="${headerId}">
    <div class="deletion-guard" contenteditable="true"></div>
    <div class="accordion-body">
      <div contenteditable="false"><div contenteditable="true"><p>Content </p></div></div>
    </div>
  </div>
</div>`;
  }

  function genTabItem(parentId, index) {
    const tabId     = `${parentId}-tab-${index}`;
    const contentId = `${parentId}-content-${index}`;
    return {
      nav: `<li class="nav-item" role="presentation">
  <span class="deletion-guard" contenteditable="true"></span>
  <button class="nav-link" id="${tabId}" data-bs-toggle="tab" data-bs-target="#${contentId}"
          role="tab" aria-controls="${contentId}" aria-selected="false" type="button" contenteditable="false">
    <span class="deletion-guard" contenteditable="true">&nbsp;</span>
    <span contenteditable="true">New Tab </span>
    <span class="deletion-guard" contenteditable="true">&nbsp;</span>
  </button>
  <span class="deletion-guard" contenteditable="true"></span>
</li>`,
      content: `<div class="tab-pane" id="${contentId}" role="tabpanel" aria-labelledby="${tabId}">
  <div contenteditable="true"><h3>New Tab </h3><p>Content </p></div>
</div>`
    };
  }

  function genVerticalTabItem(parentId, index) {
    const tabId     = `vtab-${index}`;
    const contentId = `vtab-${index}-content`;
    return {
      nav: `<li class="nav-item" role="presentation">
  <button class="nav-link" id="${tabId}-tab" data-bs-toggle="tab" data-bs-target="#${contentId}"
          role="tab" aria-controls="${contentId}" aria-selected="false" type="button">
    <span class="deletion-guard" contenteditable="true"></span>
    <span contenteditable="true">New Tab</span>
    <span class="deletion-guard" contenteditable="true"></span>
  </button>
</li>`,
      content: `<div class="tab-pane" id="${contentId}" role="tabpanel" aria-labelledby="${tabId}-tab">
  <div class="deletion-guard" contenteditable="true"></div>
  <div contenteditable="true"><h3>New Tab </h3><p>Content </p></div>
  <div class="deletion-guard" contenteditable="true"></div>
</div>`
    };
  }

  function genFlipcard(index) {
    return `<div class="flip-card-wrapper mb-3">
  <div class="flip-card-container">
    <div class="flip-card mx-auto my-3 show" aria-labelledby="flip-card-title-${index}">
      <div class="flip-card-inner" aria-label="Flip card" tabindex="0">
        <div class="flip-card-front">
          <div class="flip-card-front-content">
            <div contenteditable="true"><h3 id="flip-card-title-${index}">Front Title </h3></div>
          </div>
        </div>
        <div class="flip-card-back">
          <div class="flip-card-back-content">
            <div class="flip-card-header-primary">
              <div contenteditable="true"><h3>Back Title </h3></div>
            </div>
            <div class="flip-card-back-body">
              <div contenteditable="true"><p>Content </p></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;
  }

  function genCarouselSlide(parentId, index) {
    return `<div class="carousel-item" id="${parentId}-item-${index}" role="tabpanel"
     aria-roledescription="slide" aria-label="${index + 1} of ?">
  <div class="deletion-guard" contenteditable="true"></div>
  <div class="carousel-image" contenteditable="false">
    <div contenteditable="true">
      <img src="https://placehold.co/600x400/EEE/31343C?text=Image" alt="" class="d-block w-100">
    </div>
  </div>
  <div class="deletion-guard" contenteditable="true"></div>
  <div class="carousel-caption d-md-block" contenteditable="false">
    <div contenteditable="true"><h3>Heading </h3><p>Caption </p></div>
  </div>
  <div class="deletion-guard" contenteditable="true"></div>
</div>`;
  }

  function genTextCarouselSlide(parentId, index) {
    return `<div class="carousel-item" id="${parentId}-item-${index}" role="tabpanel"
     aria-roledescription="slide" aria-label="${index + 1} of ?">
  <div class="deletion-guard" contenteditable="true"></div>
  <div class="text-carousel-content">
    <div contenteditable="true"><h3>New Slide </h3><p>Content </p></div>
  </div>
  <div class="deletion-guard" contenteditable="true"></div>
</div>`;
  }

  function genRevealItem() {
    const id = uid('reveal');
    return `<div class="reveal-container mb-4">
  <button class="btn btn-secondary reveal-button" id="reveal-button-${id}" type="button"
          data-bs-toggle="collapse" data-bs-target="#reveal-${id}"
          aria-expanded="true" aria-controls="reveal-${id}" contenteditable="false">
    <span contenteditable="true">Reveal</span>
  </button>
  <div class="row wysiwyg-mode">
    <div class="reveal-item">
      <div class="collapse show" id="reveal-${id}" role="region" aria-labelledby="reveal-button-${id}">
        <div contenteditable="false"><div contenteditable="true"><p>Content </p></div></div>
      </div>
    </div>
  </div>
</div>`;
  }

  function genRevealTableRow() {
    const id = uid('tableReveal');
    return `<tr>
  <td contenteditable="false" class="flex-column">
    <div contenteditable="true">Content</div>
    <button class="btn btn-secondary mt-2 mx-auto" type="button" id="cell-button-${id}"
            data-bs-toggle="collapse" data-bs-target="#cell-${id}"
            aria-expanded="true" aria-controls="cell-${id}" contenteditable="false">
      <span contenteditable="true">Reveal</span>
    </button>
  </td>
  <td>
    <div class="collapse table-collapse show" id="cell-${id}" role="region" aria-labelledby="cell-button-${id}">
      <div contenteditable="false"><div contenteditable="true">Reveal Content </div></div>
    </div>
  </td>
</tr>`;
  }

  function genIconListItem() {
    return `<li contenteditable="true">
  <i class="bi bi-check-circle-fill" aria-hidden="true"></i>
  <span contenteditable="true">New Item </span>
</li>`;
  }

  // Standard non-decorative figcaption content: editable caption text, plus a
  // dedicated license line styled by CSS (.image-license) instead of ad hoc
  // inline font-size spans. Add this CSS rule to bootstrap.css:
  //   .image-license { display: block; font-size: 16px; }
  // (display:block puts it on its own line without a manual <br>.)
  function captionHTML(text) {
    return `<span contenteditable="true">${text}<span class="image-license">License / attribution </span></span>`;
  }

  // Image placeholder (to replace an icon context)
  function genImagePlaceholder() {
    return `<figure class="">
  <div class="image-container" style="position: relative;" contenteditable="false">
    <img src="https://placehold.co/1920x1080/EEE/31343C" alt="ALT TEXT NEEDED" class="img-fluid">
  </div>
  <figcaption contenteditable="false">${captionHTML('Caption ')}</figcaption>
</figure>`;
  }

  // ─── INSERT COMPONENT LIBRARY ───────────────────────────────────────────────
  // Each shell builder returns a COMPLETE new row (already passed through
  // TPL.wrapRow) ready to be inserted as a sibling row, the same way insertRow()
  // inserts a plain/coloured row. Markup is sourced from RCPI-BS-Block-Builder.html
  // / utils.js ground truth, reusing the existing per-item generators for the
  // first item of multi-item components.

  function shellColumns2() {
    return TPL.wrapRow(`<div class="columns-2" contenteditable="false">
  <div class="col-12 col-sm-6"><div contenteditable="true"><p>Content </p></div></div>
  <div class="col-12 col-sm-6"><div contenteditable="true"><p>Content </p></div></div>
</div>`);
  }

  function shellColumns2NoLine() {
    return TPL.wrapRow(`<div class="columns-2-no-line" contenteditable="false">
  <div class="col-12 col-sm-6"><div contenteditable="true"><p>Content </p></div></div>
  <div class="col-12 col-sm-6"><div contenteditable="true"><p>Content </p></div></div>
</div>`);
  }

  function shellColumns3() {
    return TPL.wrapRow(`<div class="columns-3" contenteditable="false">
  <div class="col-12 col-md-4"><div contenteditable="true"><p>Content </p></div></div>
  <div class="col-12 col-md-4"><div contenteditable="true"><p>Content </p></div></div>
  <div class="col-12 col-md-4"><div contenteditable="true"><p>Content </p></div></div>
</div>`);
  }

  function shellLargeNumberList() {
    return TPL.wrapRow(`<div contenteditable="false">
  <ol class="large-number" contenteditable="true">
    <li contenteditable="true">Item </li>
    <li contenteditable="true">Item </li>
  </ol>
</div>`);
  }

  function shellIconList() {
    return TPL.wrapRow(`<div class="col-12"><div contenteditable="false">
  <ul class="icon-list" contenteditable="true">${genIconListItem()}</ul>
</div></div>`);
  }

  function shellImagePlaceholder() {
    return TPL.wrapRow(`<div class="col-12"><div class="figure-wrapper">
  <figure class="wysiwyg-mode" contenteditable="false">
    <div class="image-container" contenteditable="true">
      <img src="https://placehold.co/1920x1080/EEE/31343C" alt="REQUIRED" class="img-fluid">
    </div>
    <figcaption contenteditable="false">${captionHTML('Caption ')}</figcaption>
  </figure>
</div></div>`);
  }

  function shellDecorativeImagePlaceholder() {
    return TPL.wrapRow(`<div class="col-12"><div class="figure-wrapper">
  <figure class="decorative" contenteditable="false">
    <div class="image-container" contenteditable="true">
      <img src="https://placehold.co/1920x1080/EEE/31343C" alt="" class="img-fluid">
    </div>
  </figure>
</div></div>`);
  }

  function shellImageTextLeft()  { return TPL.wrapRow(TPL.colImageText('Content ')); }
  function shellImageTextRight() { return TPL.wrapRow(TPL.colTextImage('Content ')); }
  function shellIconTextLeft()   { return TPL.wrapRow(TPL.colIconText('Content ')); }
  function shellIconTextRight()  { return TPL.wrapRow(TPL.colTextIcon('Content ')); }

  function shellCard(variant)  { return TPL.wrapRow(TPL.card(variant, 'Content ')); }
  function shellIconCard(variant) { return TPL.wrapRow(TPL.iconCard('Content ', variant)); }

  function shellAccordion() {
    const id = uid('accordion');
    return TPL.wrapRow(TPL.accordion(id, genAccordionItem(id, 1)));
  }

  function shellNumberedAccordion() {
    const id = uid('numberedAccordion');
    return TPL.wrapRow(`<div class="accordion numbered-accordion" id="${id}">${genNumberedAccordionItem(id, 0)}</div>`);
  }

  function shellIconAccordion() {
    const id = uid('iconAccordion');
    return TPL.wrapRow(`<div class="accordion icon-accordion" id="${id}">${genIconAccordionItem(id, 0)}</div>`);
  }

  function shellHorizontalTabs() {
    const id = uid('tabs');
    const nav = TPL.hTabNav(id, 0, 'New Tab ', true);
    const pane = TPL.hTabPane(id, 0, '<h3>New Tab </h3><p>Content </p>', true);
    return TPL.wrapRow(TPL.horizontalTabs(id, nav, pane));
  }

  function shellVerticalTabs() {
    const wrapId = uid('vtabs');
    const t = genVerticalTabItem(wrapId, Date.now());
    const nav = t.nav.replace('class="nav-link"', 'class="nav-link active"')
                      .replace('aria-selected="false"', 'aria-selected="true"');
    const content = t.content.replace('class="tab-pane"', 'class="tab-pane active"');
    return TPL.wrapRow(`<div class="vertical-tabs-wrapper" contenteditable="false">
  <ul class="nav nav-tabs d-flex flex-row flex-md-column" id="${wrapId}-nav" role="tablist">${nav}</ul>
  <div class="tab-content">${content}</div>
</div>`);
  }

  function shellFlipCards() {
    const card = TPL.flipCard(0, 'Front Title ', 'Back Title ', 'Content ', flipColClass(1));
    return TPL.wrapRow(TPL.flipCards(card));
  }

  function shellTextCarousel() {
    const id = uid('textCarousel');
    const slide = genTextCarouselSlide(id, 0).replace('of ?', 'of 1');
    return TPL.wrapRow(`<div id="${id}" class="text-carousel carousel slide wysiwyg-mode col-12" aria-roledescription="carousel" aria-label="Text carousel">
  <div class="carousel-indicators text-carousel-indicators" role="tablist"><button type="button" data-bs-target="#${id}" data-bs-slide-to="0" role="tab" class="active" aria-selected="true" aria-current="true" aria-label="Slide 1"></button></div>
  <div class="text-carousel-container">
    <button class="text-carousel-control-prev btn btn-dark" type="button" data-bs-target="#${id}" data-bs-slide="prev" aria-label="Previous slide"><span class="carousel-control-prev-icon" aria-hidden="true"></span><span class="visually-hidden">Previous</span></button>
    <div class="carousel-inner">${slide}</div>
    <button class="text-carousel-control-next btn btn-dark" type="button" data-bs-target="#${id}" data-bs-slide="next" aria-label="Next slide"><span class="carousel-control-next-icon" aria-hidden="true"></span><span class="visually-hidden">Next</span></button>
  </div>
</div>`);
  }

  function shellImageCarousel() {
    const id = uid('carousel');
    const slide = genCarouselSlide(id, 0).replace('of ?', 'of 1');
    return TPL.wrapRow(`<div id="${id}" class="carousel image-carousel slide wysiwyg-mode col-12 col-md-10 offset-md-1" aria-roledescription="carousel" aria-label="Image carousel">
  <div class="carousel-inner">${slide}</div>
  <div class="d-flex"><button class="carousel-control-prev btn btn-dark w-1" type="button" data-bs-target="#${id}" data-bs-slide="prev"><span class="carousel-control-prev-icon" aria-hidden="true"></span><span class="visually-hidden">Previous</span></button> <button class="carousel-control-next btn btn-dark w-1" type="button" data-bs-target="#${id}" data-bs-slide="next"><span class="carousel-control-next-icon" aria-hidden="true"></span><span class="visually-hidden">Next</span></button></div>
</div>`);
  }

  function shellTable() {
    return TPL.wrapRow(`<div class="col-12"><div class="table-responsive"><table class="table"><caption>Header on Top</caption>
<thead><tr><th scope="col">Header</th><th scope="col">Header</th><th scope="col">Header</th></tr></thead>
<tbody><tr><td>Data</td><td>Data</td><td>Data</td></tr><tr><td>Data</td><td>Data</td><td>Data</td></tr></tbody>
</table></div></div>`);
  }

  function shellRevealTable() {
    return TPL.wrapRow(`<div class="col-12"><div class="table-responsive row reveal-table"><table class="table"><caption contenteditable="true">Caption</caption>
<thead><tr><th scope="row" contenteditable="true">Prompt</th><th scope="row" contenteditable="true">Reveal Content</th></tr></thead>
<tbody>${genRevealTableRow()}</tbody>
</table></div></div>`);
  }

  function shellClickAndReveal() {
    return TPL.wrapRow(genRevealItem());
  }

  // The insertable library, grouped by category for the menu. `build` returns
  // a full ready-to-insert row (see shell functions above).
  const INSERT_LIBRARY = [
    { category: 'Text & Lists', label: '2-Column Text',                build: shellColumns2 },
    { category: 'Text & Lists', label: '2-Column Text (No Line)',      build: shellColumns2NoLine },
    { category: 'Text & Lists', label: '3-Column Text',                build: shellColumns3 },
    { category: 'Text & Lists', label: 'Large Number List',            build: shellLargeNumberList },
    { category: 'Text & Lists', label: 'Icon List',                    build: shellIconList },

    { category: 'Images', label: 'Image Placeholder',                  build: shellImagePlaceholder },
    { category: 'Images', label: 'Decorative Image Placeholder',       build: shellDecorativeImagePlaceholder },
    { category: 'Images', label: 'Image + Text (Image Left)',          build: shellImageTextLeft },
    { category: 'Images', label: 'Image + Text (Image Right)',         build: shellImageTextRight },
    { category: 'Images', label: 'Icon + Text (Icon Left)',            build: shellIconTextLeft },
    { category: 'Images', label: 'Icon + Text (Icon Right)',           build: shellIconTextRight },

    { category: 'Cards', label: 'Card (White)',                        build: () => shellCard('white') },
    { category: 'Cards', label: 'Card (Primary)',                      build: () => shellCard('primary') },
    { category: 'Cards', label: 'Card (Secondary)',                    build: () => shellCard('secondary') },
    { category: 'Cards', label: 'Card (Tertiary)',                     build: () => shellCard('tertiary') },
    { category: 'Cards', label: 'Icon Card (White)',                   build: () => shellIconCard('white') },
    { category: 'Cards', label: 'Icon Card (Primary)',                 build: () => shellIconCard('primary') },
    { category: 'Cards', label: 'Icon Card (Secondary)',               build: () => shellIconCard('secondary') },
    { category: 'Cards', label: 'Icon Card (Tertiary)',                build: () => shellIconCard('tertiary') },

    { category: 'Accordions', label: 'Accordion',                      build: shellAccordion },
    { category: 'Accordions', label: 'Numbered Accordion',             build: shellNumberedAccordion },
    { category: 'Accordions', label: 'Icon Accordion',                 build: shellIconAccordion },

    { category: 'Tabs', label: 'Horizontal Tabs',                      build: shellHorizontalTabs },
    { category: 'Tabs', label: 'Vertical Tabs',                        build: shellVerticalTabs },

    { category: 'Carousels', label: 'Flip Cards',                      build: shellFlipCards },
    { category: 'Carousels', label: 'Text Carousel',                   build: shellTextCarousel },
    { category: 'Carousels', label: 'Image Carousel',                  build: shellImageCarousel },

    { category: 'Tables', label: 'Table',                              build: shellTable },
    { category: 'Tables', label: 'Reveal Table',                       build: shellRevealTable },

    { category: 'Interactive', label: 'Click and Reveal',              build: shellClickAndReveal },
  ];

  // ─── ADD-ITEM LOGIC ─────────────────────────────────────────────────────────
  function getAddItemHTML(component) {
    const { type, el } = component;
    const parentId = el.id || uid('comp');

    switch (type) {
      case 'Accordion': {
        const count = el.querySelectorAll('.accordion-item').length;
        return { html: genAccordionItem(parentId, count + 1), label: 'Accordion Item', tabType: null };
      }
      case 'Numbered Accordion': {
        const count = el.querySelectorAll('.accordion-item').length;
        return { html: genNumberedAccordionItem(parentId, count), label: 'Numbered Accordion Item', tabType: null };
      }
      case 'Icon Accordion': {
        const count = el.querySelectorAll('.accordion-item').length;
        return { html: genIconAccordionItem(parentId, count), label: 'Icon Accordion Item', tabType: null };
      }
      case 'Horizontal Tabs': {
        const count = el.querySelectorAll('.nav-item').length;
        const t = genTabItem(el.id || parentId, count);
        return { html: t.nav + '\n<!-- TAB CONTENT -->\n' + t.content, label: 'Tab (nav + content — paste nav into tab list, content into tab-content div)', tabType: 'horizontal', parts: t };
      }
      case 'Vertical Tabs': {
        const navEl = el.querySelector('ul.nav');
        const count = navEl ? navEl.querySelectorAll('.nav-item').length : 0;
        const t = genVerticalTabItem(parentId, count + 1);
        return { html: t.nav + '\n<!-- TAB CONTENT -->\n' + t.content, label: 'Vertical Tab (nav + content)', tabType: 'vertical', parts: t };
      }
      case 'Flipcards': {
        const count = el.querySelectorAll('.flip-card-wrapper').length;
        return { html: genFlipcard(count), label: 'Flipcard', tabType: null };
      }
      case 'Image Carousel': {
        const inner = el.querySelector('.carousel-inner');
        const count = inner ? inner.querySelectorAll('.carousel-item').length : 0;
        return { html: genCarouselSlide(parentId, count), label: 'Image Carousel Slide', tabType: null };
      }
      case 'Text Carousel': {
        const inner = el.querySelector('.carousel-inner');
        const count = inner ? inner.querySelectorAll('.carousel-item').length : 0;
        return { html: genTextCarouselSlide(parentId, count), label: 'Text Carousel Slide', tabType: null };
      }
      case 'Click and Reveal':
        return { html: genRevealItem(), label: 'Reveal Item', tabType: null };
      case 'Reveal Table':
        return { html: genRevealTableRow(), label: 'Reveal Table Row', tabType: null };
      case 'Icon List':
        return { html: genIconListItem(), label: 'Icon List Item', tabType: null };
      default:
        return null;
    }
  }

  // ─── MAIN PANEL UI ─────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('bb-toolkit-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'bb-toolkit-panel';
    panel.innerHTML = `
      <div id="bb-tk-header">
        <span id="bb-tk-title">🧱 Edit Toolkit</span>
        <span id="bb-tk-badges"></span>
        <button id="bb-tk-min" title="Minimise to a bar">⟨</button>
      </div>
      <div id="bb-tk-body">
        <div id="bb-tk-tabs">
          <button class="bb-tab active" data-tab="components">Components</button>
          <button class="bb-tab" data-tab="audit">Audit</button>
          <button class="bb-tab" data-tab="history">History</button>
        </div>
        <div id="bb-tk-panels">
          <div id="bb-tk-components" class="bb-tabpanel active">
            <p class="bb-hint">Components on this page. <b>⟳ +1</b> adds an item directly into the live component.<br>
            <b>Alt+right-click</b> in the editor for BB actions (plain right-click = normal TinyMCE menu):<br>
            <b>cell(s)</b> → table colours/structure · <b>selected text</b> → wrap / 2-columns · <b>component</b> → convert · <b>icon</b> → swap · <b>image</b> → figure/decorative · <b>link</b> → tracking/new-tab · <b>YouTube</b> → privacy · <b>PDF</b> → download link · <b>row</b> → colour / insert / PDF / snippet · <b>gap</b> → insert row.</p>
            <button id="bb-tk-fix" class="bb-btn bb-btn-fix" style="margin:0 0 10px;">🔧 Check &amp; fix page issues</button>
            <button id="bb-tk-insert-row" class="bb-btn bb-btn-plus" style="margin:0 0 8px;">+ Insert row at cursor</button>
            <button id="bb-tk-outline" class="bb-btn bb-btn-goto" style="margin:0 0 8px;">🗂 Heading outline</button>
            <button id="bb-tk-replace" class="bb-btn bb-btn-goto" style="margin:0 0 8px;">🔎 Find &amp; replace</button>
            <button id="bb-tk-citations" class="bb-btn bb-btn-goto" style="margin:0 0 8px;">📎 Link DOI / PMID citations</button>
            <button id="bb-tk-audit-launch" class="bb-btn bb-btn-goto" style="margin:0 0 8px;">🔍 Open Content Audit (view mode)</button>
            <div id="bb-tk-audit-banner" style="display:none;"></div>
            <div id="bb-tk-wordcount" class="bb-wordcount" title="Words / reading time in the editor content">—</div>
            <div class="bb-tk-toolrow">
              <button id="bb-tk-snapshot" class="bb-btn bb-btn-goto" title="Save a manual snapshot of the current editor content">📸 Snapshot now</button>
              <button id="bb-tk-snapshots" class="bb-btn bb-btn-goto" title="View and restore saved snapshots">🗂 Snapshots</button>
            </div>
            <div id="bb-tk-comp-list"></div>
          </div>
          <div id="bb-tk-audit" class="bb-tabpanel">
            <p class="bb-hint">Content quality checks. Click an item to highlight it in the editor.</p>
            <div id="bb-tk-audit-list"></div>
          </div>
          <div id="bb-tk-history" class="bb-tabpanel">
            <p class="bb-hint">Last ${HISTORY_MAX} components copied from the Block Builder.</p>
            <div id="bb-tk-hist-list"></div>
            <div class="bb-snip-divider">⭐ Saved snippets</div>
            <p class="bb-hint">Reusable rows you saved. Alt+right-click a row → “Save row as snippet”.</p>
            <div id="bb-tk-snip-list"></div>
          </div>
        </div>
        <div id="bb-tk-footer">
          <div class="bb-shortcut-hint" title="Press Alt+B, release, then the action key">⌨ Alt+B then: R row · F fix · M min</div>
        </div>
      </div>
    `;

    // Resize handle (right edge of the docked pane).
    const handle = document.createElement('div');
    handle.id = 'bb-tk-resize';
    panel.appendChild(handle);

    document.body.appendChild(panel);

    // Apply saved width.
    const savedW = parseInt(GM_getValue('bb-tk-width', ''), 10);
    if (savedW && savedW >= 280) panel.style.width = savedW + 'px';

    // Minimized bar (thin clickable strip on the left). Hidden until minimised.
    let minBar = document.getElementById('bb-tk-minbar');
    if (!minBar) {
      minBar = document.createElement('div');
      minBar.id = 'bb-tk-minbar';
      minBar.title = 'Open Edit Toolkit';
      minBar.innerHTML = '<span>🧱 BB&nbsp;Toolkit</span>';
      minBar.style.display = 'none';
      minBar.addEventListener('click', () => setMinimized(false));
      document.body.appendChild(minBar);
    }

    injectPanelStyles();

    // Insert-row-at-cursor button — opens the colour menu near the panel button,
    // inserting at wherever the caret currently sits in the editor.
    const insRowBtn = panel.querySelector('#bb-tk-insert-row');
    if (insRowBtn) {
      insRowBtn.addEventListener('click', () => {
        syncTinyRefs();
        if (!tinyDoc) { toast('Editor not found', 'error'); return; }
        const r = insRowBtn.getBoundingClientRect();
        // Page coords (absolute=true); caret-based insertion (anchorRow=null).
        openInsertRowMenu(r.left, r.bottom + 4, null, null, true);
      });
    }

    const fixBtn = panel.querySelector('#bb-tk-fix');
    if (fixBtn) {
      fixBtn.addEventListener('click', () => {
        syncTinyRefs();
        if (!tinyDoc) { toast('Editor not found', 'error'); return; }
        runFixPage();
      });
    }

    // Snapshot controls.
    const snapBtn = panel.querySelector('#bb-tk-snapshot');
    if (snapBtn) snapBtn.addEventListener('click', () => { takeSnapshot('manual'); });
    const snapsBtn = panel.querySelector('#bb-tk-snapshots');
    if (snapsBtn) snapsBtn.addEventListener('click', () => { showSnapshots(); });

    // The Audit Toolkit is now view-mode-only (it never mounts on an /edit/
    // URL), so there's nothing to call in-place any more — open this
    // topic/unit's view URL in a new tab, where Audit auto-mounts its own
    // right-docked bar and runs a fresh scan. Quizzes/discussions/etc. are
    // out of scope and return null here — this file/unit-only restriction
    // is deliberate, not a bug.
    const auditBtn = panel.querySelector('#bb-tk-audit-launch');
    if (auditBtn) {
      auditBtn.addEventListener('click', () => {
        const viewUrl = S ? S.editUrlToViewUrl(location.pathname) : null;
        if (!viewUrl) { toast('Could not identify this topic (only file topics and unit pages are audited)', 'warn'); return; }
        window.open(viewUrl, '_blank');
      });
    }

    const outlineBtn = panel.querySelector('#bb-tk-outline');
    if (outlineBtn) outlineBtn.addEventListener('click', () => { syncTinyRefs(); if (!tinyDoc) { toast('Editor not found', 'error'); return; } openOutlinePanel(); });

    const replaceBtn = panel.querySelector('#bb-tk-replace');
    if (replaceBtn) replaceBtn.addEventListener('click', () => { syncTinyRefs(); if (!tinyDoc) { toast('Editor not found', 'error'); return; } openFindReplacePanel(); });

    const citeBtn = panel.querySelector('#bb-tk-citations');
    if (citeBtn) citeBtn.addEventListener('click', () => { syncTinyRefs(); if (!tinyDoc) { toast('Editor not found', 'error'); return; } openCitationsPanel(); });

    // Tab switching
    panel.querySelectorAll('.bb-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.bb-tab').forEach(b => b.classList.remove('active'));
        panel.querySelectorAll('.bb-tabpanel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        panel.querySelector(`#bb-tk-${btn.dataset.tab}`).classList.add('active');
        if (btn.dataset.tab === 'components') refreshComponentList();
        if (btn.dataset.tab === 'audit') refreshAuditList();
        if (btn.dataset.tab === 'history') { refreshHistoryList(); refreshSnippetList(); }
      });
    });

    // Minimise to / restore from the thin left bar.
    panel.querySelector('#bb-tk-min').addEventListener('click', () => setMinimized(true));

    // Edge-drag to resize the docked pane width (persisted).
    const resizeHandle = panel.querySelector('#bb-tk-resize');
    let resizing = false;
    resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      // Pane is docked on the LEFT, so width = cursor X (clamped).
      const w = Math.max(280, Math.min(e.clientX, Math.floor(window.innerWidth * 0.9)));
      panel.style.width = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.userSelect = '';
      try { GM_setValue('bb-tk-width', String(parseInt(panel.style.width, 10) || 360)); } catch {}
    });

    // Initial render
    refreshComponentList();
    scheduleAudit();

    // Restore minimized state from last session.
    try { if (GM_getValue('bb-tk-minimized', '0') === '1') setMinimized(true); } catch {}
  }

  // Show/hide the pane vs the thin minimized bar.
  function setMinimized(min) {
    const panel = document.getElementById('bb-toolkit-panel');
    const bar = document.getElementById('bb-tk-minbar');
    if (!panel || !bar) return;
    panel.style.display = min ? 'none' : 'flex';
    bar.style.display = min ? 'flex' : 'none';
    try { GM_setValue('bb-tk-minimized', min ? '1' : '0'); } catch {}
  }

  // Component types the +1/-1/dup item controls apply to. Shared between the
  // docked panel list and the Alt+right-click component context menu.
  const COMP_NO_ADD_TYPES = ['Icon Card', 'Image', 'Image Column', 'Click and Reveal'];
  const COMP_REPLACEABLE_TYPES = ['Accordion', 'Numbered Accordion', 'Icon Accordion',
                       'Horizontal Tabs', 'Vertical Tabs', 'Flipcards',
                       'Text Carousel', 'Image Carousel', 'Reveal Table', 'Icon List'];

  function refreshComponentList() {
    const list = document.getElementById('bb-tk-comp-list');
    if (!list) return;
    list.innerHTML = '';

    if (!tinyDoc) {
      list.innerHTML = '<p class="bb-hint" style="color:#dc3545">TinyMCE not found — open the page editor.</p>';
      return;
    }

    const components = detectComponents();
    if (!components.length) {
      list.innerHTML = '<p class="bb-hint">No components detected yet.</p>';
      return;
    }

    components.forEach(comp => {
      const row = document.createElement('div');
      row.className = 'bb-comp-row';

      const label = document.createElement('span');
      label.className = 'bb-comp-label';
      label.textContent = comp.count !== null ? `${comp.type} (${comp.count})` : comp.type;

      const actions = document.createElement('span');
      actions.className = 'bb-comp-actions';

      // Component item-adding buttons
      const noAddTypes = COMP_NO_ADD_TYPES;
      const replaceable = COMP_REPLACEABLE_TYPES;

      if (!noAddTypes.includes(comp.type)) {
        // PRIMARY: replace-whole-component with +1 item, as a pasteable WYSIWYG row.
        // This avoids the fragile HTML-source-view cursor placement entirely.
        if (replaceable.includes(comp.type)) {
          const replBtn = document.createElement('button');
          replBtn.className = 'bb-btn bb-btn-plus';
          replBtn.title = 'Add one item to this component. With Direct-write mode ON: '
                        + 'appends straight into the live component (no paste). OFF: copies a '
                        + 'rebuilt row to paste beside the original, then delete the old row.';
          replBtn.textContent = '⟳ +1';
          replBtn.addEventListener('click', () => {
            try {
              // Always try direct-write first — it appends straight into the live
              // component (no paste, no chrome loss). This works even with the
              // global Direct-write toggle off, because adding an item is safe.
              if (addItemDirect(comp)) {
                toast('✓ Added one item to the live component', 'success');
                scheduleAudit();
                refreshComponentList();
                return;
              }
              // Fallback (editor not reachable): copy a rebuilt row to paste.
              // NOTE: TinyMCE's paste filter may strip the outer row wrapper on
              // paste; if you see that, the direct-write path above is the fix.
              const row = buildReplacementRow(comp);
              if (!row) { toast('Cannot rebuild this component type', 'error'); return; }
              copyToClipboard(row);
              toast('✓ Copied (+1 item). If the row wrapper is missing on paste, the editor API was unavailable — see console.', 'warn');
            } catch (err) {
              console.error('[Edit Toolkit] +1 failed', err);
              toast('Could not add item — see console', 'error');
            }
          });
          actions.appendChild(replBtn);

          // −1 and dup: direct API edits (deleting/duplicating a single item
          // mid-component is clumsy as a paste, clean as an API edit). Always
          // shown now; if the editor API is ever unreachable they emit a clear
          // failure toast rather than silently doing nothing.
          if (comp.count && comp.count > 1) {
            const delBtn = document.createElement('button');
            delBtn.className = 'bb-btn bb-btn-goto';
            delBtn.title = 'Delete the last item of this component (direct edit)';
            delBtn.textContent = '−1';
            delBtn.addEventListener('click', () => deleteLastItem(comp));
            actions.appendChild(delBtn);
          }
          if (comp.count && comp.count >= 1) {
            const dupBtn = document.createElement('button');
            dupBtn.className = 'bb-btn bb-btn-goto';
            dupBtn.title = 'Duplicate the last item of this component (direct edit)';
            dupBtn.textContent = 'dup';
            dupBtn.addEventListener('click', () => duplicateLastItem(comp));
            actions.appendChild(dupBtn);
          }
        }

        // SECONDARY (tabs only): individual nav / pane copies as plain text for
        // users who prefer to hand-place in the HTML source view.
        const isTab = comp.type === 'Horizontal Tabs' || comp.type === 'Vertical Tabs';
        if (isTab) {
          const navBtn = document.createElement('button');
          navBtn.className = 'bb-btn bb-btn-goto';
          navBtn.title = 'Advanced: copy just the tab <li> as plain text for the HTML source view';
          navBtn.textContent = 'li';
          navBtn.addEventListener('click', () => {
            const result = getAddItemHTML(comp);
            if (!result) { toast('Cannot generate item', 'error'); return; }
            copyAsText(result.parts.nav);
            toast('✓ Tab <li> copied (plain text) — paste in HTML view inside the nav <ul>', 'success');
          });
          const paneBtn = document.createElement('button');
          paneBtn.className = 'bb-btn bb-btn-goto';
          paneBtn.title = 'Advanced: copy just the tab pane <div> as plain text for the HTML source view';
          paneBtn.textContent = 'pane';
          paneBtn.addEventListener('click', () => {
            const result = getAddItemHTML(comp);
            if (!result) { toast('Cannot generate item', 'error'); return; }
            copyAsText(result.parts.content);
            toast('✓ Tab pane copied (plain text) — paste in HTML view inside tab-content', 'success');
          });
          actions.appendChild(navBtn);
          actions.appendChild(paneBtn);
        }
      }

      // Up/down arrows to move this component's ROW among the page's rows.
      const compRow = comp.el.closest('.row.wysiwyg-mode') || comp.el.closest('.row');
      if (compRow) {
        const summary = rowContentSummary(compRow);
        const multi = summary.pieces > 1;
        if (multi) {
          // Flag rows that hold more than just this one component, so the user
          // knows the move carries extra content along.
          row.classList.add('bb-comp-row-multi');
          const bits = [];
          if (summary.comps > 1) bits.push(`${summary.comps} components`);
          if (summary.images) bits.push(`${summary.images} image${summary.images > 1 ? 's' : ''}`);
          if (summary.textBlocks) bits.push(`${summary.textBlocks} text block${summary.textBlocks > 1 ? 's' : ''}`);
          label.title = 'This row also contains: ' + bits.join(', ') + ' — moving the row moves all of it together.';
          const flag = document.createElement('span');
          flag.className = 'bb-multi-flag';
          flag.textContent = '⧉';
          flag.title = label.title;
          label.appendChild(document.createTextNode(' '));
          label.appendChild(flag);
        }

        const upBtn = document.createElement('button');
        upBtn.className = 'bb-btn bb-btn-goto bb-move';
        upBtn.textContent = '↑';
        upBtn.title = multi ? 'Move this row up (carries all its content)' : 'Move this row up';
        if (!rowHasSibling(compRow, -1)) upBtn.disabled = true;
        upBtn.addEventListener('click', () => moveRow(compRow, -1));
        actions.appendChild(upBtn);

        const downBtn = document.createElement('button');
        downBtn.className = 'bb-btn bb-btn-goto bb-move';
        downBtn.textContent = '↓';
        downBtn.title = multi ? 'Move this row down (carries all its content)' : 'Move this row down';
        if (!rowHasSibling(compRow, 1)) downBtn.disabled = true;
        downBtn.addEventListener('click', () => moveRow(compRow, 1));
        actions.appendChild(downBtn);
      }

      // Scroll-to button
      const scrollBtn = document.createElement('button');
      scrollBtn.className = 'bb-btn bb-btn-goto';
      scrollBtn.title = 'Scroll to in editor';
      scrollBtn.textContent = '↗';
      scrollBtn.addEventListener('click', () => {
        try { comp.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
      });
      actions.appendChild(scrollBtn);

      row.appendChild(label);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function refreshAuditList() {
    const list = document.getElementById('bb-tk-audit-list');
    if (!list) return;
    list.innerHTML = '';

    if (!tinyDoc) {
      list.innerHTML = '<p class="bb-hint" style="color:#dc3545">TinyMCE not found.</p>';
      return;
    }

    const { issues, errors, warnings } = runAudit();
    updateBadges(errors, warnings);

    if (!issues.length) {
      list.innerHTML = '<p class="bb-hint" style="color:#198754">✓ No issues found.</p>';
      return;
    }

    issues.forEach(issue => {
      const row = document.createElement('div');
      row.className = `bb-audit-row bb-audit-${issue.type}`;

      const icon = issue.type === 'error' ? '✕' : '⚠';
      row.innerHTML = `<span class="bb-audit-icon">${icon}</span><span class="bb-audit-msg">${issue.msg}</span>`;

      if (issue.el) {
        row.style.cursor = 'pointer';
        row.title = 'Click to highlight in editor';
        row.addEventListener('click', () => {
          try {
            issue.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            issue.el.style.outline = '3px solid #fd7e14';
            setTimeout(() => { issue.el.style.outline = ''; }, 2500);
          } catch {}
        });
      }

      list.appendChild(row);
    });
  }

  function refreshHistoryList() {
    const list = document.getElementById('bb-tk-hist-list');
    if (!list) return;
    list.innerHTML = '';
    loadHistory();

    if (!clipHistory.length) {
      list.innerHTML = '<p class="bb-hint">Nothing copied yet from the Block Builder.</p>';
      return;
    }

    clipHistory.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'bb-comp-row';

      const label = document.createElement('span');
      label.className = 'bb-comp-label';
      label.textContent = item.label || `Component ${i + 1}`;

      const btn = document.createElement('button');
      btn.className = 'bb-btn bb-btn-plus';
      btn.textContent = '⎘ re-copy';
      btn.title = 'Copy to clipboard again';
      btn.addEventListener('click', () => {
        copyToClipboard(item.html);
        toast(`✓ Re-copied: ${item.label}`, 'success');
      });

      row.appendChild(label);
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  function updateBadges(errors, warnings) {
    const badges = document.getElementById('bb-tk-badges');
    if (!badges) return;
    badges.innerHTML = '';
    if (errors) {
      const b = document.createElement('span');
      b.className = 'bb-badge bb-badge-error';
      b.textContent = errors;
      b.title = `${errors} error(s)`;
      badges.appendChild(b);
    }
    if (warnings) {
      const b = document.createElement('span');
      b.className = 'bb-badge bb-badge-warn';
      b.textContent = warnings;
      b.title = `${warnings} warning(s)`;
      badges.appendChild(b);
    }
  }

  function scheduleAudit() {
    clearTimeout(auditTimer);
    auditTimer = setTimeout(() => {
      const { errors, warnings } = runAudit();
      updateBadges(errors, warnings);
      updateWordCount();
      // Refresh audit list if that tab is active
      if (document.querySelector('.bb-tab[data-tab="audit"]')?.classList.contains('active')) {
        refreshAuditList();
      }
    }, AUDIT_DEBOUNCE_MS);
  }

  // ─── WORD COUNT / READING TIME ──────────────────────────────────────────────
  function updateWordCount() {
    const el = document.getElementById('bb-tk-wordcount');
    if (!el) return;
    const ed = getTinyEditor();
    if (!ed) { el.textContent = '—'; return; }
    const text = (ed.getBody().textContent || '').replace(/\u00a0/g, ' ').trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.length;
    // average adult reading ~200 wpm
    const mins = words / 200;
    const readTime = words === 0 ? '0 min'
      : mins < 1 ? '<1 min'
      : Math.round(mins) + ' min';
    el.textContent = `${words.toLocaleString()} words · ${chars.toLocaleString()} chars · ~${readTime} read`;
  }

  // ─── SNAPSHOTS ──────────────────────────────────────────────────────────────
  // Two auto slots (last 2 opens) + two manual slots, stored via GM as a JSON
  // array of { kind:'auto'|'manual', html, ts }. Each kind rolls independently so
  // a burst of manual snapshots can't evict the cross-session auto safety net.
  const SNAP_KEY = 'bb-snapshots';
  const SNAP_MAX = { auto: 2, manual: 2 };

  function loadSnapshots() {
    try { return JSON.parse(GM_getValue(SNAP_KEY, '[]')) || []; }
    catch { return []; }
  }
  function saveSnapshots(list) {
    try { GM_setValue(SNAP_KEY, JSON.stringify(list)); } catch (err) { dbg('snap save failed', err); }
  }
  function takeSnapshot(kind) {
    const ed = getTinyEditor();
    if (!ed) { if (kind === 'manual') toast('Editor not found', 'error'); return; }
    let html;
    try { html = ed.getContent(); } catch { html = ed.getBody().innerHTML; }
    if (!html) return;
    const list = loadSnapshots();
    // de-dupe: skip if identical to the most recent snapshot of any kind
    if (list.length && list[list.length - 1].html === html) {
      if (kind === 'manual') toast('No changes since the last snapshot', 'warn');
      return;
    }
    list.push({ kind, html, ts: Date.now() });
    // enforce per-kind caps (keep newest)
    ['auto', 'manual'].forEach(k => {
      const ofKind = list.filter(s => s.kind === k);
      const excess = ofKind.length - SNAP_MAX[k];
      for (let i = 0; i < excess; i++) {
        const idx = list.findIndex(s => s.kind === k);
        if (idx >= 0) list.splice(idx, 1);
      }
    });
    saveSnapshots(list);
    if (kind === 'manual') toast('📸 Snapshot saved', 'success');
    dbg('snapshot taken:', kind, 'total now', list.length);
  }

  function showSnapshots() {
    const list = loadSnapshots().slice().reverse(); // newest first
    if (!list.length) { toast('No snapshots yet', 'warn'); return; }
    let html = '<div style="font-size:13px;">Click Restore to replace all editor content with that snapshot.</div>';
    list.forEach((s, i) => {
      const when = new Date(s.ts).toLocaleString();
      const sizeKb = Math.round(s.html.length / 1024);
      html += `<div class="bb-snap-row">
        <div><b>${s.kind === 'auto' ? '🕒 Auto' : '📸 Manual'}</b> · ${escapeHtml(when)} · ~${sizeKb} KB</div>
        <button class="bb-btn bb-btn-goto bb-snap-restore" data-i="${i}">Restore</button>
      </div>`;
    });
    showModal('Snapshots', html);
    const modal = document.getElementById('bb-modal');
    if (!modal) return;
    modal.querySelectorAll('.bb-snap-restore').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-i'), 10);
        const snap = list[i];
        if (!snap) return;
        if (!window.confirm('Replace ALL current editor content with this snapshot? This cannot be undone except via another snapshot.')) return;
        const ed = getTinyEditor();
        if (!ed) { toast('Editor not found', 'error'); return; }
        // take a safety snapshot of the current state before overwriting
        takeSnapshot('manual');
        try {
          ed.setContent(snap.html);
          ed.setDirty(true);
          ed.dispatch('input');
          toast('✓ Snapshot restored', 'success');
          scheduleAudit();
          refreshComponentList();
        } catch (err) {
          dbg('restore failed', err);
          toast('Could not restore snapshot', 'error');
        }
        modal.remove();
      });
    });
  }

  // ─── COMPONENT SNIPPETS ─────────────────────────────────────────────────────
  // Save a configured row/component to a named slot (GM-stored) and re-insert it
  // later. Stored as a JSON array of { name, html, ts }.
  const SNIP_KEY = 'bb-snippets';
  const SNIP_MAX = 30;

  function loadSnippets() {
    try { return JSON.parse(GM_getValue(SNIP_KEY, '[]')) || []; }
    catch { return []; }
  }
  function saveSnippets(list) {
    try { GM_setValue(SNIP_KEY, JSON.stringify(list.slice(0, SNIP_MAX))); } catch (err) { dbg('snip save failed', err); }
  }

  // Save a row element as a snippet (prompts for a name).
  function saveRowAsSnippet(rowEl) {
    if (!rowEl) return;
    const name = window.prompt('Name this snippet:', '');
    if (name == null) return;
    const nm = name.trim();
    if (!nm) { toast('No name given', 'warn'); return; }
    const html = rowEl.outerHTML;
    const list = loadSnippets();
    // replace if the same name already exists, else add to the top
    const existing = list.findIndex(s => s.name.toLowerCase() === nm.toLowerCase());
    const entry = { name: nm, html, ts: Date.now() };
    if (existing >= 0) list[existing] = entry; else list.unshift(entry);
    saveSnippets(list);
    toast(`✓ Snippet "${nm}" saved`, 'success');
    if (document.querySelector('.bb-tab[data-tab="history"]')?.classList.contains('active')) refreshSnippetList();
  }

  // Insert a snippet at the caret (as a sibling row in .container).
  function insertSnippet(html) {
    const didWrite = tinyWrite((ed) => {
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = html.trim();
      const node = tmp.firstElementChild;
      if (!node) return;
      const container = ed.getBody().querySelector('.container') || ed.getBody();
      let ref = ed.selection.getNode();
      while (ref && ref.parentElement && ref.parentElement !== container) ref = ref.parentElement;
      if (ref && ref.parentElement === container) container.insertBefore(node, ref.nextSibling);
      else container.appendChild(node);
    }, 'insert snippet', { ungated: true });
    if (didWrite) { toast('✓ Snippet inserted', 'success'); scheduleAudit(); refreshComponentList(); }
    else { copyToClipboard(html); toast('✓ Snippet copied — editor API unavailable, paste manually', 'warn'); }
  }

  function deleteSnippet(name) {
    const list = loadSnippets().filter(s => s.name !== name);
    saveSnippets(list);
    refreshSnippetList();
  }

  // Render the snippet library (lives in the History tab).
  function refreshSnippetList() {
    const wrap = document.getElementById('bb-tk-snip-list');
    if (!wrap) return;
    const list = loadSnippets();
    if (!list.length) {
      wrap.innerHTML = '<p class="bb-hint">No saved snippets yet. Alt+right-click a row → “Save as snippet”.</p>';
      return;
    }
    wrap.innerHTML = '';
    list.forEach(s => {
      const row = document.createElement('div');
      row.className = 'bb-comp-row';
      const label = document.createElement('span');
      label.className = 'bb-comp-label';
      label.textContent = s.name;
      label.title = new Date(s.ts).toLocaleString();
      const actions = document.createElement('span');
      actions.className = 'bb-comp-actions';
      const ins = document.createElement('button');
      ins.className = 'bb-btn bb-btn-plus';
      ins.textContent = '+ Insert';
      ins.addEventListener('click', () => insertSnippet(s.html));
      const del = document.createElement('button');
      del.className = 'bb-btn bb-btn-goto';
      del.textContent = '🗑';
      del.title = 'Delete snippet';
      del.addEventListener('click', () => deleteSnippet(s.name));
      actions.appendChild(ins);
      actions.appendChild(del);
      row.appendChild(label);
      row.appendChild(actions);
      wrap.appendChild(row);
    });
  }


  // ─── TWO-COLUMN TEMPLATES ───────────────────────────────────────────────────
  // Convert a selected paragraph into a 2-column layout. Templates mirror the
  // block builder's image-column / icon-card output exactly. The paragraph text
  // is injected into the text column; the other column gets a placeholder.

  // (Old standalone two-column templates removed — the paragraph→columns menu
  // now uses the ground-truth TPL.col* templates which match the live output.)

  // Wrap any block in the standard Bootstrap row. Delegates to TPL.wrapRow so
  // there's a single source of truth for the row chrome.
  function wrapInRow(innerHTML) {
    return TPL.wrapRow(innerHTML);
  }

  // ─── REPLACE-WHOLE-COMPONENT ────────────────────────────────────────────────
  // Approach: clone the WHOLE enclosing row (so the "Open All" button, col-12,
  // and deletion-guards travel with it), then append one more item by cloning an
  // EXISTING item from the live component and clearing it. Cloning a live item
  // guarantees the new item's structure exactly matches the others — no
  // hand-written template that can drift out of sync. Fresh IDs prevent
  // collisions. Output is wrapped/prefixed so TinyMCE pastes the full row intact.

  function findEnclosingRow(el) {
    // Walk up to the outer .row.wysiwyg-mode that wraps the component, if any.
    return el.closest('.row.wysiwyg-mode') || el.closest('.row') || null;
  }

  // Replace every id in a subtree with a fresh suffixed id, fixing the matching
  // aria/data references so the accordion/tab wiring stays internally consistent.
  function reidSubtree(root, token) {
    root.querySelectorAll('[id]').forEach(node => {
      const oldId = node.id;
      const newId = oldId + '-' + token;
      node.id = newId;
      root.querySelectorAll(`[data-bs-target="#${cssEsc(oldId)}"]`)
        .forEach(r => r.setAttribute('data-bs-target', '#' + newId));
      root.querySelectorAll(`[aria-controls="${cssEsc(oldId)}"]`)
        .forEach(r => r.setAttribute('aria-controls', newId));
      root.querySelectorAll(`[aria-labelledby="${cssEsc(oldId)}"]`)
        .forEach(r => r.setAttribute('aria-labelledby', newId));
    });
  }

  // Empty out the editable text in a cloned item so the user starts fresh,
  // while keeping the structure intact.
  function blankEditableText(item) {
    // Heading: the editable span inside the toggle button / nav link / card front
    item.querySelectorAll('.accordion-button span[contenteditable="true"], ' +
                          '.nav-link span[contenteditable="true"], ' +
                          '.flip-card-front-content [contenteditable="true"] h3')
        .forEach(s => { s.textContent = 'New item'; });
    // Body: editable content areas -> single empty paragraph
    item.querySelectorAll('.accordion-body [contenteditable="true"], ' +
                          '.tab-pane [contenteditable="true"], ' +
                          '.flip-card-back-body [contenteditable="true"]')
        .forEach(b => { b.innerHTML = '<p>New content</p>'; });
  }

  // Append exactly one new item to a component element (live OR cloned) by
  // cloning its last existing item and blanking it. Returns true on success.
  // Works the same whether `compEl` is in the live editor or a detached clone,
  // which lets both the direct-write and clipboard paths share identical logic.
  function appendOneItem(compEl, type, itemSel) {
    const token = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 99);

    // Flip cards: the repeatable unit is the col-* WRAPPER that contains the
    // flip-card-container — not the container itself. Clone the whole wrapper,
    // append it, then rebalance every card's column class for the new count.
    if (type === 'Flipcards') {
      const containers = compEl.querySelectorAll('.flip-card-container');
      if (!containers.length) return false;
      const lastCol = containers[containers.length - 1].closest('[class*="col-"]');
      if (!lastCol) return false;
      const newCol = lastCol.cloneNode(true);
      reidSubtree(newCol, token);
      // fresh flip-card-title id + clear text
      const frontH = newCol.querySelector('.flip-card-front-content h3');
      if (frontH) { frontH.id = 'flip-card-title-' + token; frontH.textContent = 'Front Title'; }
      const backH = newCol.querySelector('.flip-card-header-primary h3');
      if (backH) backH.textContent = 'Back Title';
      const backBody = newCol.querySelector('.flip-card-back-body [contenteditable="true"]');
      if (backBody) backBody.innerHTML = '<p>Content</p>';
      const flip = newCol.querySelector('.flip-card');
      if (flip) flip.setAttribute('aria-labelledby', 'flip-card-title-' + token);
      lastCol.parentNode.appendChild(newCol);
      rebalanceFlipCards(compEl);
      return true;
    }

    if (type === 'Accordion' || type === 'Numbered Accordion' || type === 'Icon Accordion' ||
        type === 'Icon List') {
      const items = compEl.querySelectorAll(itemSel);
      if (!items.length) return false;
      const newItem = items[items.length - 1].cloneNode(true);
      reidSubtree(newItem, token);
      // Keep the cloned item's collapse/show state exactly as the source item
      // has it. Your block builder uses "collapse show" in WYSIWYG mode so every
      // item is visible while editing — cloning verbatim preserves that. (Don't
      // strip 'show' or the new item would be invisible in the editor.)
      blankEditableText(newItem);
      items[items.length - 1].parentNode.appendChild(newItem);
      return true;
    }
    if (type === 'Horizontal Tabs' || type === 'Vertical Tabs') {
      const navLinks = compEl.querySelectorAll('.nav-link');
      if (!navLinks.length) return false;
      const lastLink = navLinks[navLinks.length - 1];
      const lastLi = lastLink.closest('.nav-item') || lastLink;

      // Locate the .tab-content (sibling for horizontal, descendant for
      // vertical) via the shared helper so all tab ops agree.
      const tabContent = findTabContent(compEl);

      const oldTarget = lastLink.getAttribute('data-bs-target'); // "#...-content-N"
      const oldPaneId = oldTarget ? oldTarget.slice(1) : null;
      const oldTabId  = lastLink.id;                              // "...-tab-N"
      const newPaneId = (oldPaneId || 'pane') + '-' + token;
      const newTabId  = (oldTabId  || 'tab')  + '-' + token;

      // --- Clone the nav <li> ---
      const navClone = lastLi.cloneNode(true);
      const navCloneLink = navClone.matches('.nav-link') ? navClone : navClone.querySelector('.nav-link');
      if (navCloneLink) {
        navCloneLink.id = newTabId;
        navCloneLink.setAttribute('data-bs-target', '#' + newPaneId);
        navCloneLink.setAttribute('aria-controls', newPaneId);
        navCloneLink.setAttribute('aria-selected', 'false');
        navCloneLink.classList.remove('active');
        // The editable LABEL span is the one WITHOUT the deletion-guard class.
        const labelSpan = [...navCloneLink.querySelectorAll('span[contenteditable="true"]')]
          .find(s => !s.classList.contains('deletion-guard'));
        if (labelSpan) labelSpan.textContent = 'New tab';
      }
      lastLi.parentNode.appendChild(navClone);

      // --- Clone the matching pane ---
      if (oldPaneId && tabContent) {
        const pane = tabContent.querySelector('#' + cssEsc(oldPaneId))
                  || [...tabContent.children].find(c => c.id === oldPaneId);
        if (pane) {
          const paneClone = pane.cloneNode(true);
          paneClone.id = newPaneId;
          paneClone.classList.remove('active', 'show');
          paneClone.setAttribute('aria-labelledby', newTabId);
          const body = paneClone.querySelector('[contenteditable="true"]');
          if (body) body.innerHTML = '<h3>New tab</h3><p>New content</p>';
          tabContent.appendChild(paneClone);
        } else {
          dbg('tab pane not found for id', oldPaneId, '- nav added without pane');
        }
      } else {
        dbg('tab-content not located; pane not created. tabContent=', !!tabContent, 'oldPaneId=', oldPaneId);
      }
      return true;
    }
    if (type === 'Text Carousel' || type === 'Image Carousel') {
      // The carousel id lives on the .carousel element. compEl may be that
      // element or contain it.
      const carousel = compEl.classList.contains('carousel') ? compEl : compEl.querySelector('.carousel');
      const carId = (carousel && carousel.id) || (compEl.id || '');
      const inner = compEl.querySelector('.carousel-inner');
      const slides = inner ? inner.querySelectorAll('.carousel-item') : compEl.querySelectorAll('.carousel-item');
      if (!slides.length || !inner) return false;

      const newIndex = slides.length;            // 0-based index of the new slide
      const newTotal = slides.length + 1;        // total after adding
      const newSlideId = carId ? `${carId}-item-${newIndex}` : `carousel-item-${token}`;

      // --- clone the last slide ---
      const clone = slides[slides.length - 1].cloneNode(true);
      clone.classList.remove('active');
      clone.id = newSlideId;
      clone.setAttribute('aria-label', `${newTotal} of ${newTotal}`);
      // freshen any inner ids (reveal buttons etc.) but keep the slide id we set
      const slideIdBackup = clone.id;
      reidSubtree(clone, token);
      clone.id = slideIdBackup;
      inner.appendChild(clone);

      // --- update every slide's "N of M" aria-label to the new total ---
      inner.querySelectorAll('.carousel-item').forEach((s, i) => {
        s.setAttribute('aria-label', `${i + 1} of ${newTotal}`);
      });

      // --- add a matching indicator button ---
      const indicators = compEl.querySelector('.carousel-indicators');
      if (indicators) {
        const btns = indicators.querySelectorAll('button');
        const lastBtn = btns[btns.length - 1];
        const newBtn = lastBtn
          ? lastBtn.cloneNode(true)
          : tinyDoc.createElement('button');
        newBtn.setAttribute('type', 'button');
        if (carId) newBtn.setAttribute('data-bs-target', '#' + carId);
        newBtn.setAttribute('data-bs-slide-to', String(newIndex));
        newBtn.setAttribute('role', 'tab');
        newBtn.setAttribute('aria-controls', newSlideId);
        newBtn.setAttribute('aria-label', `Slide ${newTotal}`);
        newBtn.classList.remove('active');
        newBtn.removeAttribute('aria-current');
        newBtn.setAttribute('aria-selected', 'false');
        // strip any trailing <br> bogus node the clone might carry
        indicators.appendChild(newBtn);
      }
      return true;
    }
    if (type === 'Reveal Table') {
      const tbody = compEl.querySelector('tbody');
      const rows = tbody ? tbody.querySelectorAll('tr') : [];
      if (!rows.length) return false;
      const clone = rows[rows.length - 1].cloneNode(true);
      reidSubtree(clone, token);
      tbody.appendChild(clone);
      return true;
    }
    return false;
  }

  // Direct-write: append one item straight into the LIVE component. No paste,
  // no chrome-stripping, no delete-old-row step. Ungated — always tries the API
  // first (it's safe and strictly better than the clipboard path here).
  function addItemDirect(component) {
    return tinyWrite(() => {
      const ok = appendOneItem(component.el, component.type, component.detector.itemSel);
      if (!ok) throw new Error('could not append item');
    }, 'addItemDirect ' + component.type, { ungated: true });
  }

  function buildReplacementRow(component) {
    // Clone the whole row if the component sits in one; else clone the component.
    const row = findEnclosingRow(component.el);
    const cloneRoot = (row || component.el).cloneNode(true);

    // Find the component within the cloned root (it may be the root itself).
    const compInClone = row
      ? cloneRoot.querySelector('#' + cssEsc(component.el.id)) ||
        cloneRoot.querySelector('.' + [...component.el.classList].join('.')) ||
        cloneRoot
      : cloneRoot;

    const ok = appendOneItem(compInClone, component.type, component.detector.itemSel);
    if (!ok) return null;

    // If we cloned a full row, it already has the correct wrapper — return as-is.
    // If we only had the bare component, wrap it in a row.
    const finalHTML = row ? cloneRoot.outerHTML : wrapInRow(cloneRoot.outerHTML);
    return pasteSafe(finalHTML);
  }

  // NOTE on paste vs direct-write for structured components:
  // TinyMCE's paste *event* filter can strip contenteditable="false" chrome
  // (the row wrapper, deletion-guards). Writing via the API does NOT run that
  // filter, so direct-write preserves the structure perfectly. For the clipboard
  // path we return the markup unchanged — modern TinyMCE keeps most of it, but
  // if you see chrome stripped, turn on Direct-write mode for a clean result.
  function pasteSafe(html) {
    return html;
  }

  // ─── COMPONENT CONVERSION ───────────────────────────────────────────────────
  // Every "header + revealed content" component reduces to a list of
  // { heading, bodyHTML } pairs. We extract those from the source component,
  // then re-emit them as a different component type. This powers
  // accordion <-> tabs <-> flipcards conversion.

  function componentKind(el) {
    if (el.matches('.flip-cards')) return 'flipcards';
    if (el.matches('.horizontal-tabs')) return 'horizontal-tabs';
    if (el.matches('.vertical-tabs-wrapper')) return 'vertical-tabs';
    if (el.matches('.accordion')) {
      if (el.classList.contains('numbered-accordion')) return 'numbered-accordion';
      if (el.querySelector('.accordion-button.icon-header')) return 'icon-accordion';
      return 'accordion';
    }
    return null;
  }

  // Pull { heading, bodyHTML } pairs out of any supported component.
  function extractPairs(el, kind) {
    const pairs = [];
    if (kind === 'accordion' || kind === 'numbered-accordion' || kind === 'icon-accordion') {
      el.querySelectorAll('.accordion-item').forEach(item => {
        const btn = item.querySelector('.accordion-button');
        // heading = the editable span inside the button (skip the icon <i> and
        // the trailing ms-auto span on icon accordions)
        const span = btn && (btn.querySelector('span[contenteditable="true"]') || btn.querySelector('span:not(.ms-auto)'));
        const heading = (span ? span.textContent : (btn ? btn.textContent : '')).trim();
        const body = item.querySelector('.accordion-body [contenteditable="true"]')
                  || item.querySelector('.accordion-body');
        pairs.push({ heading, bodyHTML: body ? body.innerHTML.trim() : '' });
      });
    } else if (kind === 'horizontal-tabs' || kind === 'vertical-tabs') {
      // Locate .tab-content (descendant for vertical, sibling for horizontal).
      const tabContent = findTabContent(el);
      el.querySelectorAll('.nav-link').forEach(link => {
        // Editable label span = the one without the deletion-guard class.
        const labelSpan = [...link.querySelectorAll('span[contenteditable="true"]')]
          .find(s => !s.classList.contains('deletion-guard')) || link;
        const heading = labelSpan.textContent.trim();
        const targetSel = link.getAttribute('data-bs-target');
        let bodyHTML = '';
        if (targetSel && tabContent) {
          const pane = tabContent.querySelector(targetSel)
                    || [...tabContent.children].find(c => '#' + c.id === targetSel);
          const inner = pane && (pane.querySelector('[contenteditable="true"]') || pane);
          bodyHTML = inner ? inner.innerHTML.trim() : '';
        }
        pairs.push({ heading, bodyHTML });
      });
    } else if (kind === 'flipcards') {
      // Cards live in col-12 col-sm-6 > flip-card-container (no .flip-card-wrapper)
      el.querySelectorAll('.flip-card-container').forEach(card => {
        const front = card.querySelector('.flip-card-front-content [contenteditable="true"]')
                   || card.querySelector('.flip-card-front-content');
        const backHead = card.querySelector('.flip-card-header-primary [contenteditable="true"]');
        const backBody = card.querySelector('.flip-card-back-body [contenteditable="true"]')
                  || card.querySelector('.flip-card-back-body');
        // Use the front title as the heading; keep back-heading + back-body
        const heading = front ? front.textContent.trim() : '';
        const backHeading = backHead ? backHead.textContent.trim() : heading;
        pairs.push({
          heading,
          backHeading,
          bodyHTML: backBody ? backBody.innerHTML.trim() : '',
        });
      });
    }
    return pairs;
  }

  // Build a fresh component of `targetKind` from extracted pairs, using the
  // ground-truth templates so the output matches the live block-builder exactly.
  function buildFromPairs(pairs, targetKind) {
    if (targetKind === 'accordion') {
      const id = uid('accordion');
      const items = pairs.map((p, i) =>
        TPL.accordionItem(id, i, escapeHtml(p.heading || 'Heading'), p.bodyHTML || '<p>Content</p>')
      ).join('');
      return TPL.wrapRow(TPL.accordion(id, items));
    }
    if (targetKind === 'horizontal-tabs') {
      const id = uid('tabs');
      const navs  = pairs.map((p, i) => TPL.hTabNav(id, i, escapeHtml(p.heading || 'Tab'), i === 0)).join('');
      const panes = pairs.map((p, i) => TPL.hTabPane(id, i, p.bodyHTML || '<p>Content</p>', i === 0)).join('');
      return TPL.wrapRow(TPL.horizontalTabs(id, navs, panes));
    }
    if (targetKind === 'flipcards') {
      const colClass = flipColClass(pairs.length);
      const cards = pairs.map((p, i) => TPL.flipCard(
        i,
        escapeHtml(p.heading || 'Front Title'),
        escapeHtml(p.backHeading || p.heading || 'Back Title'),
        // flip-card-back-body is a <p>; strip wrapping tags from bodyHTML if it
        // was a single paragraph, else use text
        (p.bodyHTML && p.bodyHTML.replace(/<[^>]+>/g, '').trim()) || 'Content',
        colClass
      )).join('');
      return TPL.wrapRow(TPL.flipCards(cards));
    }
    return null;
  }

  // ─── CONVERT MENU ───────────────────────────────────────────────────────────
  // ─── COMPONENT MENU (item-ops + convert + duplicate) ────────────────────────
  // Identify the "kind" of component and the specific repeatable ITEM the user
  // clicked, so we can offer delete / move up / move down on that item, plus
  // duplicate-item, convert, and duplicate-whole-component.

  // For a component element, return { type, itemSel, items, kind } describing how
  // to find its repeatable items.
  // Canonical .tab-content locator, used by every tab operation so they all
  // agree on where the panes live. Horizontal tabs: compEl is the <ul>, content
  // is a SIBLING inside the shared .col-12. Vertical tabs: compEl is the
  // .vertical-tabs-wrapper and content is a DESCENDANT. We try, in order:
  // descendant, parent's subtree (covers the horizontal sibling case), and the
  // immediate next sibling, so a single call works for both layouts.
  function findTabContent(compEl) {
    if (!compEl) return null;
    let tc = compEl.querySelector('.tab-content');
    if (tc) return tc;
    if (compEl.parentElement) {
      tc = compEl.parentElement.querySelector('.tab-content');
      if (tc) return tc;
    }
    if (compEl.nextElementSibling && compEl.nextElementSibling.classList.contains('tab-content')) {
      return compEl.nextElementSibling;
    }
    return null;
  }

  function componentItemInfo(compEl) {
    // Map the component element to a detector type.
    const comps = detectComponents();
    const match = comps.find(c => c.el === compEl)
      || comps.find(c => compEl.contains(c.el) || c.el.contains(compEl));
    const type = match ? match.type : null;
    let itemSel = match ? match.detector.itemSel : null;

    // Carousels/reveal handled specially below; for tabs the item is .nav-item.
    return { type, itemSel };
  }

  // Given the click target and component, find the specific item element.
  function findClickedItem(compEl, tgt, type) {
    if (type === 'Flipcards') {
      const fcc = tgt.closest('.flip-card-container');
      return fcc ? fcc.closest('[class*="col-"]') || fcc : null;
    }
    if (type === 'Horizontal Tabs' || type === 'Vertical Tabs') {
      // clicked nav item, or clicked a pane (map pane back to its nav li)
      const li = tgt.closest('.nav-item');
      if (li) return li;
      const pane = tgt.closest('.tab-pane');
      if (pane && pane.id) {
        const link = compEl.querySelector(`.nav-link[data-bs-target="#${cssEsc(pane.id)}"]`)
          || (compEl.parentElement && compEl.parentElement.querySelector(`.nav-link[data-bs-target="#${cssEsc(pane.id)}"]`));
        return link ? (link.closest('.nav-item') || link) : null;
      }
      return null;
    }
    if (type === 'Text Carousel' || type === 'Image Carousel') {
      return tgt.closest('.carousel-item');
    }
    if (type === 'Reveal Table') {
      return tgt.closest('tbody tr');
    }
    // accordions + icon list
    if (type === 'Icon List') return tgt.closest('li');
    return tgt.closest('.accordion-item');
  }

  function openComponentMenu(compEl, tgt, x, y) {
    closeAnyMenu();
    const { type } = componentItemInfo(compEl);
    dbg('openComponentMenu type=', type);
    const item = type ? findClickedItem(compEl, tgt, type) : null;

    const menu = document.createElement('div');
    menu.id = 'bb-component-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">${type || 'Component'}</div>`;

    const add = (label, fn, danger) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (danger) btn.classList.add('bb-danger');
      btn.addEventListener('click', () => { fn(); closeAnyMenu(); });
      menu.appendChild(btn);
    };

    // Item-level operations (only if we identified the clicked item)
    if (item) {
      const sub = document.createElement('div');
      sub.className = 'bb-ctx-sub';
      sub.textContent = 'This item';
      menu.appendChild(sub);
      add('↑ Move up', () => moveItem(compEl, item, type, -1));
      add('↓ Move down', () => moveItem(compEl, item, type, +1));
      add('⧉ Duplicate item', () => duplicateItem(compEl, item, type));
      add('✕ Delete item', () => deleteItem(compEl, item, type), true);
    }

    // Component-level operations
    const sub2 = document.createElement('div');
    sub2.className = 'bb-ctx-sub';
    sub2.textContent = 'Component';
    menu.appendChild(sub2);
    add('⧉ Duplicate component', () => duplicateComponent(compEl));

    // Add / remove item — mirrors the docked panel's +1 / -1 controls, for
    // components whose item count can vary (flipcards, accordions, tabs,
    // carousels, reveal table, icon list).
    if (type && COMP_REPLACEABLE_TYPES.includes(type)) {
      const comps = detectComponents();
      const comp = comps.find(c => c.el === compEl)
        || comps.find(c => compEl.contains(c.el) || c.el.contains(compEl));
      if (comp) {
        add('+ Add item', () => {
          if (addItemDirect(comp)) {
            toast(`✓ Added one item to ${comp.type}`, 'success');
            scheduleAudit();
            refreshComponentList();
          } else {
            toast('Could not add item — see console', 'error');
          }
        });
        if (comp.count && comp.count > 1) {
          add('− Remove last item', () => deleteLastItem(comp), true);
        }
      }
    }

    // Convert (only for header+content types)
    const kind = componentKind(compEl);
    const convertibleKinds = ['accordion','numbered-accordion','icon-accordion','horizontal-tabs','vertical-tabs','flipcards'];
    if (kind && convertibleKinds.includes(kind)) {
      const family = (kind === 'numbered-accordion' || kind === 'icon-accordion') ? 'accordion' : kind;
      CONVERT_TARGETS.forEach(t => {
        if (t.kind === family) return;
        add('→ Convert to ' + t.label, () => {
          const pairs = extractPairs(compEl, kind);
          doConvert(compEl, pairs, t.kind);
        });
      });
    }
    // Convert FROM reveal table / carousel (to accordion/tabs/flipcards)
    if (kind === null && (type === 'Reveal Table' || type === 'Text Carousel' || type === 'Image Carousel')) {
      CONVERT_TARGETS.forEach(t => {
        add('→ Convert to ' + t.label, () => {
          const pairs = extractPairsGeneric(compEl, type);
          if (!pairs.length) { toast('Nothing to convert', 'warn'); return; }
          doConvert(compEl, pairs, t.kind);
        });
      });
    }

    positionMenu(menu, x, y);
  }

  // The container that holds the repeatable items, per type.
  function itemsContainer(compEl, type) {
    if (type === 'Flipcards') return compEl.querySelector('.flip-cards') ? compEl : compEl;
    if (type === 'Horizontal Tabs' || type === 'Vertical Tabs') return compEl.querySelector('.nav, .nav-tabs') || compEl;
    if (type === 'Text Carousel' || type === 'Image Carousel') return compEl.querySelector('.carousel-inner');
    if (type === 'Reveal Table') return compEl.querySelector('tbody');
    if (type === 'Icon List') return compEl.querySelector('.icon-list') || compEl;
    return compEl; // accordions: items are direct children
  }

  // Move an item up/-1 or down/+1 among its siblings, keeping paired panes
  // (tabs) and rebalancing (flipcards/carousels) in sync.
  function moveItem(compEl, item, type, dir) {
    const didWrite = tinyWrite(() => {
      const parent = item.parentNode;
      const sibs = [...parent.children].filter(c => c.matches(item.tagName + (item.className ? '.' + [...item.classList].join('.') : '')));
      const idx = sibs.indexOf(item);
      const swapWith = sibs[idx + dir];
      if (!swapWith) return;

      if (dir < 0) parent.insertBefore(item, swapWith);
      else parent.insertBefore(swapWith, item);

      // Tabs: move the matching pane too
      if (type === 'Horizontal Tabs' || type === 'Vertical Tabs') {
        moveTabPane(compEl, item, dir);
      }
      // Carousels: re-sequence ids/labels and indicators after reordering
      if (type === 'Text Carousel' || type === 'Image Carousel') resequenceCarousel(compEl);
    }, 'moveItem ' + dir, { ungated: true });
    if (didWrite) { toast(dir < 0 ? '✓ Moved up' : '✓ Moved down', 'success'); scheduleAudit(); refreshComponentList(); }
  }

  function moveTabPane(compEl, navItem, dir) {
    const link = navItem.querySelector('.nav-link') || navItem;
    const target = link.getAttribute('data-bs-target');
    if (!target) return;
    const tabContent = findTabContent(compEl);
    if (!tabContent) return;
    const pane = tabContent.querySelector(target);
    if (!pane) return;
    const panes = [...tabContent.children];
    const pidx = panes.indexOf(pane);
    const swap = panes[pidx + dir];
    if (!swap) return;
    if (dir < 0) tabContent.insertBefore(pane, swap);
    else tabContent.insertBefore(swap, pane);
  }

  // Re-number carousel slide ids, "N of M" labels, and indicator slide-to.
  function resequenceCarousel(compEl) {
    const carousel = compEl.classList.contains('carousel') ? compEl : compEl.querySelector('.carousel');
    const carId = carousel && carousel.id;
    const inner = compEl.querySelector('.carousel-inner');
    const slides = inner ? [...inner.querySelectorAll('.carousel-item')] : [];
    const total = slides.length;
    slides.forEach((s, i) => {
      if (carId) s.id = `${carId}-item-${i}`;
      s.setAttribute('aria-label', `${i + 1} of ${total}`);
    });
    const indicators = compEl.querySelector('.carousel-indicators');
    if (indicators) {
      [...indicators.querySelectorAll('button')].forEach((b, i) => {
        b.setAttribute('data-bs-slide-to', String(i));
        if (carId) b.setAttribute('aria-controls', `${carId}-item-${i}`);
        b.setAttribute('aria-label', `Slide ${i + 1}`);
      });
    }
  }

  function deleteItem(compEl, item, type) {
    const didWrite = tinyWrite(() => {
      // Tabs: remove the paired pane too
      if (type === 'Horizontal Tabs' || type === 'Vertical Tabs') {
        const link = item.querySelector('.nav-link') || item;
        const target = link.getAttribute('data-bs-target');
        const tabContent = findTabContent(compEl);
        if (target && tabContent) { const p = tabContent.querySelector(target); if (p) p.remove(); }
        const wasActive = link.classList.contains('active');
        item.remove();
        // if we removed the active tab, activate the first remaining
        if (wasActive) {
          const firstLink = compEl.querySelector('.nav-link');
          const firstPane = tabContent && tabContent.querySelector('.tab-pane');
          if (firstLink) { firstLink.classList.add('active'); firstLink.setAttribute('aria-selected', 'true'); }
          if (firstPane) firstPane.classList.add('active', 'show');
        }
      } else {
        item.remove();
      }
      if (type === 'Flipcards') rebalanceFlipCards(compEl.querySelector('.flip-cards') || compEl);
      if (type === 'Text Carousel' || type === 'Image Carousel') {
        // ensure one slide stays active
        const inner = compEl.querySelector('.carousel-inner');
        if (inner && !inner.querySelector('.carousel-item.active')) {
          const first = inner.querySelector('.carousel-item');
          if (first) first.classList.add('active');
        }
        resequenceCarousel(compEl);
      }
    }, 'deleteItem', { ungated: true });
    if (didWrite) { toast('✓ Item deleted', 'success'); scheduleAudit(); refreshComponentList(); }
  }

  function duplicateItem(compEl, item, type) {
    const didWrite = tinyWrite(() => {
      const token = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 99);
      if (type === 'Horizontal Tabs' || type === 'Vertical Tabs') {
        // reuse appendOneItem's pairing logic by cloning this specific item
        const clone = item.cloneNode(true);
        const link = clone.querySelector('.nav-link') || clone;
        const origLink = item.querySelector('.nav-link') || item;
        const oldTarget = origLink.getAttribute('data-bs-target');
        const oldPaneId = oldTarget ? oldTarget.slice(1) : null;
        const newPaneId = (oldPaneId || 'pane') + '-' + token;
        const newTabId = (origLink.id || 'tab') + '-' + token;
        link.id = newTabId;
        link.setAttribute('data-bs-target', '#' + newPaneId);
        link.setAttribute('aria-controls', newPaneId);
        link.setAttribute('aria-selected', 'false');
        link.classList.remove('active');
        item.parentNode.insertBefore(clone, item.nextSibling);
        // clone the pane
        const tabContent = findTabContent(compEl);
        if (oldPaneId && tabContent) {
          const pane = tabContent.querySelector('#' + cssEsc(oldPaneId));
          if (pane) {
            const pc = pane.cloneNode(true);
            pc.id = newPaneId; pc.classList.remove('active', 'show');
            pc.setAttribute('aria-labelledby', newTabId);
            pane.parentNode.insertBefore(pc, pane.nextSibling);
          }
        }
      } else {
        const clone = item.cloneNode(true);
        reidSubtree(clone, token);
        item.parentNode.insertBefore(clone, item.nextSibling);
        if (type === 'Flipcards') rebalanceFlipCards(compEl.querySelector('.flip-cards') || compEl);
        if (type === 'Text Carousel' || type === 'Image Carousel') resequenceCarousel(compEl);
      }
    }, 'duplicateItem', { ungated: true });
    if (didWrite) { toast('✓ Item duplicated', 'success'); scheduleAudit(); refreshComponentList(); }
  }

  function duplicateComponent(compEl) {
    const didWrite = tinyWrite(() => {
      const token = Date.now().toString(36).slice(-4) + Math.floor(Math.random() * 99);
      const row = compEl.closest('.row.wysiwyg-mode');
      const source = row || compEl;
      const clone = source.cloneNode(true);
      reidSubtree(clone, token);
      // After re-id, point each accordion's "Open All" button at its accordion id.
      clone.querySelectorAll('.accordion[id]').forEach(acc => {
        const btn = acc.parentElement && acc.parentElement.querySelector('.accordion-toggle-button[data-accordion-id]');
        if (btn) btn.setAttribute('data-accordion-id', acc.id);
      });
      source.parentNode.insertBefore(clone, source.nextSibling);
    }, 'duplicateComponent', { ungated: true });
    if (didWrite) { toast('✓ Component duplicated', 'success'); scheduleAudit(); refreshComponentList(); }
  }

  // Extract { heading, bodyHTML } pairs from reveal tables and carousels so they
  // can be converted to accordion/tabs/flipcards.
  function extractPairsGeneric(compEl, type) {
    const pairs = [];
    if (type === 'Reveal Table') {
      compEl.querySelectorAll('tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td, th');
        // prompt cell (first) = heading; reveal cell (second) = body
        const promptCell = cells[0];
        const revealCell = cells[1];
        const heading = promptCell ? (promptCell.querySelector('[contenteditable="true"]')?.textContent || promptCell.textContent).trim() : '';
        const body = revealCell ? (revealCell.querySelector('[contenteditable="true"]')?.innerHTML || revealCell.innerHTML) : '';
        pairs.push({ heading: heading.replace(/Reveal\s*$/, '').trim(), bodyHTML: body });
      });
    } else if (type === 'Text Carousel' || type === 'Image Carousel') {
      compEl.querySelectorAll('.carousel-item').forEach(slide => {
        const inner = slide.querySelector('[contenteditable="true"]');
        const h = inner ? inner.querySelector('h1,h2,h3,h4') : null;
        const heading = h ? h.textContent.trim() : '';
        let body = '';
        if (inner) { const clone = inner.cloneNode(true); const hh = clone.querySelector('h1,h2,h3,h4'); if (hh) hh.remove(); body = clone.innerHTML.trim(); }
        pairs.push({ heading: heading || 'Slide', bodyHTML: body });
      });
    }
    return pairs;
  }

  const CONVERT_TARGETS = [
    { kind: 'accordion',       label: 'Accordion' },
    { kind: 'horizontal-tabs', label: 'Horizontal tabs' },
    { kind: 'flipcards',       label: 'Flip cards' },
  ];

  function openConvertMenu(el, x, y) {
    closeAnyMenu();
    const kind = componentKind(el);
    dbg('openConvertMenu. source kind=', kind);
    if (!kind) { toast('Unrecognised component', 'error'); return; }

    const pairs = extractPairs(el, kind);
    dbg('extracted pairs:', pairs.length, pairs);

    const menu = document.createElement('div');
    menu.id = 'bb-convert-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">Convert (${pairs.length} item${pairs.length === 1 ? '' : 's'}) to…</div>`;

    // Map the source kind to a "family" so we skip the right target. All three
    // accordion variants share the 'accordion' target.
    const family = (kind === 'numbered-accordion' || kind === 'icon-accordion') ? 'accordion' : kind;

    CONVERT_TARGETS.forEach(t => {
      if (t.kind === family) return; // skip converting to the same family
      const btn = document.createElement('button');
      btn.textContent = '→ ' + t.label;
      btn.addEventListener('click', () => {
        doConvert(el, pairs, t.kind);
        closeAnyMenu();
      });
      menu.appendChild(btn);
    });

    if (!pairs.length) {
      const note = document.createElement('div');
      note.className = 'bb-ctx-title';
      note.style.color = '#dc3545';
      note.textContent = 'No items found to convert.';
      menu.appendChild(note);
    }

    positionMenu(menu, x, y);
  }

  function doConvert(sourceEl, pairs, targetKind) {
    const row = buildFromPairs(pairs, targetKind); // already row-wrapped via TPL
    if (!row) { toast('Cannot build that target type', 'error'); return; }

    const didWrite = tinyWrite(() => {
      // Replace the source component's enclosing row (if it sits in one) or the
      // component element itself, in place.
      const targetToReplace = sourceEl.closest('.row.wysiwyg-mode') || sourceEl.closest('.row') || sourceEl;
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = row.trim();
      targetToReplace.replaceWith(tmp.firstElementChild);
    }, 'convert -> ' + targetKind, { ungated: true });

    if (didWrite) {
      toast(`✓ Converted to ${targetKind}`, 'success');
      scheduleAudit();
      refreshComponentList();
    } else {
      copyToClipboard(row);
      toast(`✓ Converted ${targetKind} copied as a row — paste it, then delete the original`, 'warn');
    }
  }

  // ─── TABLE CELL MENU ────────────────────────────────────────────────────────
  // Select one or more cells, Alt+right-click, and apply background / font
  // colour or run structural actions. Colours apply to the WHOLE current cell
  // selection at once via mceTableApplyCellStyle (background) and a font-colour
  // span wrap. Structural actions use native execCommand and therefore work
  // regardless of the direct-write toggle — they go through TinyMCE's own engine.

  // Theme palette pulled from bootstrap.css brand colours.
  const TABLE_COLOURS = [
    { hex: '',        label: 'None' },
    { hex: '#002d72', label: 'Navy' },
    { hex: '#c9a227', label: 'Gold' },
    { hex: '#6f42c1', label: 'Purple' },
    { hex: '#b9a7e0', label: 'Lavender' },
    { hex: '#198754', label: 'Green' },
    { hex: '#1b4332', label: 'Forest' },
    { hex: '#9ec5fe', label: 'Light blue' },
    { hex: '#dc3545', label: 'Red' },
    { hex: '#ffc107', label: 'Yellow' },
    { hex: '#ffffff', label: 'White' },
    { hex: '#f1f3f5', label: 'Light grey' },
  ];

  function tableCmd(cmd, value) {
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not available', 'error'); return false; }
    try {
      ed.execCommand(cmd, false, value);
      ed.setDirty(true);
      ed.dispatch('input');
      dbg('tableCmd ran:', cmd, value !== undefined ? value : '');
      return true;
    } catch (err) {
      dbg('tableCmd failed:', cmd, err);
      toast('Command failed: ' + cmd, 'error');
      return false;
    }
  }

  // Apply a background colour to the whole current cell selection at once.
  // The site CSS sets a white cell background with !important, so a normal inline
  // style loses to it. We therefore set the inline style WITH !important directly
  // on each selected cell (TinyMCE's style API strips !important, so we can't go
  // through mceTableApplyCellStyle for this).
  function applyCellBackground(hex) {
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not available', 'error'); return; }
    try {
      const cells = ed.getBody().querySelectorAll('td[data-mce-selected], th[data-mce-selected]');
      const targets = cells.length ? Array.from(cells) : (() => {
        const n = ed.selection.getNode();
        const cell = n && (n.closest ? n.closest('td, th') : null);
        return cell ? [cell] : [];
      })();
      if (!targets.length) { toast('No table cell selected', 'warn'); return; }
      targets.forEach(cell => {
        if (hex) cell.style.setProperty('background-color', hex, 'important');
        else cell.style.removeProperty('background-color');
        // keep TinyMCE's mirror attribute in sync so it doesn't re-render over us
        if (cell.getAttribute('data-mce-style')) {
          cell.removeAttribute('data-mce-style');
        }
      });
      ed.setDirty(true);
      ed.dispatch('input');
      toast(hex ? '✓ Cell background set' : '✓ Cell background cleared', 'success');
    } catch (err) {
      dbg('applyCellBackground failed', err);
      toast('Could not set cell background — see console', 'error');
    }
  }

  // Font colour: TinyMCE's forecolor applies to the selection. When whole cells
  // are selected (not just text), we set the colour on each selected cell's
  // content so the whole cell text recolours.
  function applyCellFontColour(hex) {
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not available', 'error'); return; }
    try {
      // Selected cells carry the data-mce-selected attribute when multi-selected
      const selectedCells = ed.getBody().querySelectorAll('td[data-mce-selected], th[data-mce-selected]');
      if (selectedCells.length) {
        selectedCells.forEach(cell => {
          if (hex) cell.style.color = hex;
          else cell.style.removeProperty('color');
        });
      } else {
        // Single cell / text selection -> use forecolor on the selection
        if (hex) ed.execCommand('ForeColor', false, hex);
        else ed.execCommand('mceRemoveTextcolor', false, 'forecolor');
      }
      ed.setDirty(true);
      ed.dispatch('input');
      toast(hex ? '✓ Font colour set' : '✓ Font colour cleared', 'success');
    } catch (err) {
      dbg('applyCellFontColour failed', err);
      toast('Font colour failed', 'error');
    }
  }

  function buildSwatchRow(onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'bb-swatch-grid';
    TABLE_COLOURS.forEach(c => {
      const sw = document.createElement('button');
      sw.className = 'bb-swatch-btn';
      sw.title = c.label;
      if (!c.hex) {
        sw.classList.add('bb-swatch-clear');
        sw.textContent = '⌀';
      } else {
        sw.style.background = c.hex;
      }
      sw.addEventListener('click', (e) => { e.stopPropagation(); onPick(c.hex); closeAnyMenu(); });
      wrap.appendChild(sw);
    });
    return wrap;
  }

  function openTableMenu(cellEl, x, y) {
    closeAnyMenu();
    const ed = getTinyEditor();
    const selCount = ed ? ed.getBody().querySelectorAll('td[data-mce-selected], th[data-mce-selected]').length : 0;
    dbg('openTableMenu. selected cells=', selCount || '(current cell only)');

    const menu = document.createElement('div');
    menu.id = 'bb-table-menu';
    menu.className = 'bb-ctx-menu bb-table-menu';

    const scopeLabel = selCount > 1 ? `${selCount} cells selected` : 'current cell';
    menu.innerHTML = `<div class="bb-ctx-title">Table — ${scopeLabel}</div>`;

    // ── Background colour ──
    const bgLabel = document.createElement('div');
    bgLabel.className = 'bb-ctx-sub';
    bgLabel.textContent = 'Background colour';
    menu.appendChild(bgLabel);
    menu.appendChild(buildSwatchRow(applyCellBackground));

    // custom hex for background
    const bgHex = document.createElement('div');
    bgHex.className = 'bb-hex-row';
    bgHex.innerHTML = `<span>Custom:</span><input type="color" class="bb-hex" value="#002d72">
                       <button class="bb-hex-apply">Apply bg</button>`;
    bgHex.querySelector('.bb-hex-apply').addEventListener('click', (e) => {
      e.stopPropagation();
      applyCellBackground(bgHex.querySelector('.bb-hex').value);
      closeAnyMenu();
    });
    menu.appendChild(bgHex);

    // ── Font colour ──
    const fgLabel = document.createElement('div');
    fgLabel.className = 'bb-ctx-sub';
    fgLabel.textContent = 'Font colour';
    menu.appendChild(fgLabel);
    menu.appendChild(buildSwatchRow(applyCellFontColour));

    const fgHex = document.createElement('div');
    fgHex.className = 'bb-hex-row';
    fgHex.innerHTML = `<span>Custom:</span><input type="color" class="bb-hex" value="#ffffff">
                       <button class="bb-hex-apply">Apply text</button>`;
    fgHex.querySelector('.bb-hex-apply').addEventListener('click', (e) => {
      e.stopPropagation();
      applyCellFontColour(fgHex.querySelector('.bb-hex').value);
      closeAnyMenu();
    });
    menu.appendChild(fgHex);

    // ── Structural actions ──
    const actLabel = document.createElement('div');
    actLabel.className = 'bb-ctx-sub';
    actLabel.textContent = 'Structure';
    menu.appendChild(actLabel);

    const actions = [
      { cmd: 'mceTableInsertRowBefore', label: '↑ Insert row above' },
      { cmd: 'mceTableInsertRowAfter',  label: '↓ Insert row below' },
      { cmd: 'mceTableInsertColBefore', label: '← Insert column left' },
      { cmd: 'mceTableInsertColAfter',  label: '→ Insert column right' },
      { cmd: 'mceTableDeleteRow',       label: '✕ Delete row', danger: true },
      { cmd: 'mceTableDeleteCol',       label: '✕ Delete column', danger: true },
      { cmd: 'mceTableMergeCells',      label: '⊞ Merge selected cells' },
      { cmd: 'mceTableSplitCells',      label: '⊟ Split cell' },
      { cmd: 'mceTableRowType',         label: '⊤ Toggle header row', value: { type: 'header' }, special: 'rowHeader' },
      { cmd: 'mceTableColType',         label: '⊢ Toggle header column', value: { type: 'th' }, special: 'colHeader' },
    ];

    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.textContent = a.label;
      if (a.danger) btn.classList.add('bb-danger');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        runTableAction(a, cellEl);
        closeAnyMenu();
      });
      menu.appendChild(btn);
    });

    positionMenu(menu, x, y);
  }

  // Header toggles use queryCommandValue to detect current state, per TinyMCE's
  // own table-toolbar demo, then flip. More reliable than inspecting the DOM.
  function runTableAction(a, cellEl) {
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not available', 'error'); return; }

    if (a.special === 'rowHeader') {
      let isHeader = false;
      try { isHeader = ed.queryCommandValue('mceTableRowType') !== 'body'; }
      catch { isHeader = !!(cellEl.closest('thead') || [...cellEl.closest('tr').children].every(c => c.tagName === 'TH')); }
      tableCmd('mceTableRowType', { type: isHeader ? 'body' : 'header' });
      toast(isHeader ? '✓ Row set to body' : '✓ Row set to header', 'success');
      return;
    }
    if (a.special === 'colHeader') {
      let isTh = false;
      try { isTh = ed.queryCommandValue('mceTableColType') === 'th'; }
      catch { isTh = cellEl.tagName === 'TH'; }
      tableCmd('mceTableColType', { type: isTh ? 'td' : 'th' });
      toast(isTh ? '✓ Column set to body' : '✓ Column set to header', 'success');
      return;
    }

    const ran = tableCmd(a.cmd, a.value);
    if (ran) {
      const nice = a.label.replace(/^[^ ]+ /, '');
      toast(`✓ ${nice}`, 'success');
      scheduleAudit();
    }
  }

  // ─── DELETE / DUPLICATE A SINGLE ITEM (direct-write) ────────────────────────
  // These mutate the live component in place via the TinyMCE API. For tabs they
  // keep nav + pane in sync. They operate on the LAST item to keep the UI simple
  // (a future version could let you pick which item).

  function itemSelectorFor(comp) {
    return comp.detector.itemSel; // e.g. '.accordion-item', '.nav-item', etc.
  }

  function deleteLastItem(comp) {
    const sel = itemSelectorFor(comp);
    if (!sel) { toast('This component has no removable items', 'error'); return; }

    const didWrite = tinyWrite(() => {
      const items = comp.el.querySelectorAll(sel);
      if (items.length <= 1) throw new Error('only one item left');
      const last = items[items.length - 1];

      // Tabs: also remove the matching pane
      if (comp.type === 'Horizontal Tabs' || comp.type === 'Vertical Tabs') {
        const btn = last.querySelector('[data-bs-target]');
        const targetSel = btn && btn.getAttribute('data-bs-target');
        last.remove();
        if (targetSel) {
          const pane = comp.el.querySelector(targetSel);
          if (pane) pane.remove();
        }
      } else {
        last.remove();
      }
    }, 'deleteLastItem ' + comp.type);

    if (didWrite) {
      toast(`✓ Removed last item from ${comp.type}`, 'success');
      scheduleAudit();
      refreshComponentList();
    } else {
      toast('Delete needs API mode on (and >1 item)', 'warn');
    }
  }

  function duplicateLastItem(comp) {
    const sel = itemSelectorFor(comp);
    if (!sel) { toast('This component has no duplicable items', 'error'); return; }

    const didWrite = tinyWrite(() => {
      const items = comp.el.querySelectorAll(sel);
      if (!items.length) throw new Error('no items');
      const last = items[items.length - 1];

      if (comp.type === 'Horizontal Tabs' || comp.type === 'Vertical Tabs') {
        // Duplicate nav item and its pane, giving fresh ids
        const navClone = last.cloneNode(true);
        const btn = last.querySelector('[data-bs-target]');
        const oldTarget = btn && btn.getAttribute('data-bs-target'); // "#id"
        const oldId = oldTarget ? oldTarget.slice(1) : null;
        const newId = uid('tab');

        // rewire the clone's button to the new pane id
        const cloneBtn = navClone.querySelector('[data-bs-target]');
        if (cloneBtn) {
          cloneBtn.setAttribute('data-bs-target', '#' + newId);
          cloneBtn.setAttribute('aria-controls', newId);
          cloneBtn.setAttribute('aria-selected', 'false');
          cloneBtn.classList.remove('active');
        }
        const navLinkClone = navClone.classList.contains('nav-link') ? navClone : navClone.querySelector('.nav-link');
        if (navLinkClone) navLinkClone.classList.remove('active');
        last.parentNode.appendChild(navClone);

        // clone the pane
        if (oldId) {
          const pane = comp.el.querySelector('#' + cssEsc(oldId));
          if (pane) {
            const paneClone = pane.cloneNode(true);
            paneClone.id = newId;
            paneClone.classList.remove('active', 'show');
            pane.parentNode.appendChild(paneClone);
          }
        }
      } else {
        // Generic: clone the last item, strip/replace ids to keep them unique
        const clone = last.cloneNode(true);
        // Re-id any id-bearing descendants by suffixing a fresh token
        const token = Date.now().toString(36).slice(-4);
        clone.querySelectorAll('[id]').forEach(n => {
          const newId = n.id + '-' + token;
          // fix references that point at the old id within the clone
          const old = n.id;
          n.id = newId;
          clone.querySelectorAll(`[data-bs-target="#${old}"]`).forEach(r => r.setAttribute('data-bs-target', '#' + newId));
          clone.querySelectorAll(`[aria-controls="${old}"]`).forEach(r => r.setAttribute('aria-controls', newId));
          clone.querySelectorAll(`[aria-labelledby="${old}"]`).forEach(r => r.setAttribute('aria-labelledby', newId));
        });
        last.parentNode.appendChild(clone);
      }
    }, 'duplicateLastItem ' + comp.type);

    if (didWrite) {
      toast(`✓ Duplicated last item of ${comp.type}`, 'success');
      scheduleAudit();
      refreshComponentList();
    } else {
      toast('Duplicate needs API mode on', 'warn');
    }
  }

  // ─── ICON SWAP MODAL ────────────────────────────────────────────────────────
  function buildIconSwapModal() {
    if (document.getElementById('bb-icon-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'bb-icon-modal';
    modal.innerHTML = `
      <div id="bb-icon-modal-inner">
        <div id="bb-icon-modal-header">
          <strong>Swap Icon</strong>
          <button id="bb-icon-modal-close">✕</button>
        </div>
        <div id="bb-icon-modal-actions">
          <button class="bb-btn bb-btn-img" id="bb-icon-to-img">↪ Replace with Image Placeholder</button>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;margin-top:6px;cursor:pointer;">
            <input type="checkbox" id="bb-icon-all"> Replace ALL matching icons on the page
          </label>
        </div>
        <input id="bb-icon-search" type="text" placeholder="Filter icons…">
        <div id="bb-icon-grid"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#bb-icon-modal-close').addEventListener('click', closeIconModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeIconModal(); });

    modal.querySelector('#bb-icon-modal-actions button').addEventListener('click', () => {
      if (!iconPickTarget) return;
      replaceIconWithImage(iconPickTarget);
    });

    modal.querySelector('#bb-icon-search').addEventListener('input', function () {
      const q = this.value.toLowerCase();
      modal.querySelectorAll('.bb-icon-opt').forEach(btn => {
        btn.style.display = btn.dataset.name.includes(q) ? '' : 'none';
      });
    });

    const grid = modal.querySelector('#bb-icon-grid');
    QUICK_ICONS.forEach(name => {
      const btn = document.createElement('button');
      btn.className = 'bb-icon-opt';
      btn.dataset.name = name;
      btn.title = name;
      btn.innerHTML = `<i class="bi bi-${name}"></i>`;
      btn.addEventListener('click', () => applyIconSwap(name));
      grid.appendChild(btn);
    });

    injectIconModalStyles();
  }

  function openIconModal(iEl) {
    iconPickTarget = iEl;
    buildIconSwapModal();
    document.getElementById('bb-icon-modal').style.display = 'flex';
    document.getElementById('bb-icon-search').value = '';
    document.querySelectorAll('.bb-icon-opt').forEach(b => b.style.display = '');
  }

  function closeIconModal() {
    const m = document.getElementById('bb-icon-modal');
    if (m) m.style.display = 'none';
    iconPickTarget = null;
  }

  function applyIconSwap(iconName) {
    if (!iconPickTarget) return;
    const iEl = iconPickTarget;
    const replaceAll = !!document.getElementById('bb-icon-all')?.checked;

    // Identify the original bi-* class so "replace all" knows what to match.
    const origBi = [...iEl.classList].find(c => c.startsWith('bi-'));

    const swapOne = (el) => {
      const keep = [...el.classList].filter(c => c !== 'bi' && !c.startsWith('bi-'));
      el.className = ['bi', 'bi-' + iconName, ...keep].join(' ');
    };

    let count = 0;
    const didWrite = tinyWrite((ed) => {
      if (replaceAll && origBi) {
        ed.getBody().querySelectorAll('i.' + cssEsc(origBi)).forEach(el => { swapOne(el); count++; });
      } else {
        swapOne(iEl); count = 1;
      }
    }, 'icon swap -> bi-' + iconName + (replaceAll ? ' (all)' : ''), { ungated: true });

    if (didWrite) {
      toast(replaceAll ? `✓ Replaced ${count} icon(s) with bi-${iconName}` : `✓ Icon changed to bi-${iconName}`, 'success');
      try { iEl.style.outline = '3px solid #0d6efd'; setTimeout(() => { iEl.style.outline = ''; }, 1500); } catch {}
      scheduleAudit();
    } else {
      copyToClipboard(`<i class="bi bi-${iconName}" aria-hidden="true"></i>`);
      toast(`Icon bi-${iconName} copied — editor API unavailable, paste manually`, 'warn');
    }
    closeIconModal();
  }

  // Replace the clicked icon <i> with an image-placeholder figure, in place,
  // writing directly into the editor (no clipboard/paste). Falls back to copy
  // only if the editor API is unreachable.
  function replaceIconWithImage(iEl) {
    const phHTML = genImagePlaceholder();
    const didWrite = tinyWrite(() => {
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = phHTML.trim();
      const fig = tmp.firstElementChild;
      if (!fig) return;
      // Replace the icon element itself. If the icon sits alone in a small
      // wrapper that exists only to hold it (e.g. an icon-column or icon
      // container), the bare <i> swap still produces valid markup; we keep it
      // simple and predictable by swapping just the <i>.
      if (iEl.parentNode) {
        iEl.parentNode.replaceChild(fig, iEl);
      }
    }, 'replace icon with image placeholder', { ungated: true });

    if (didWrite) {
      toast('✓ Icon replaced with image placeholder', 'success');
      scheduleAudit();
    } else {
      copyToClipboard(`<div contenteditable="false">${phHTML}</div>`);
      toast('Image placeholder copied — editor API unavailable, paste manually', 'warn');
    }
    closeIconModal();
  }

  // Attach right-click listener inside TinyMCE iframe.
  // CAPTURE PHASE + stopImmediatePropagation so we run BEFORE TinyMCE's own
  // bubble-phase contextmenu handler and prevent its native menu appearing.
  // This mirrors the save-intercept pattern (capturing listener) that was
  // confirmed to work against D2L web components in earlier work.
  let _ctxAttached = false;
  function attachIconSwapListener() {
    syncTinyRefs();
    if (!tinyDoc) return;

    // Guard against double-attach when the editor is re-synced
    if (tinyDoc.__bbCtxAttached) {
      dbg('contextmenu already attached to this doc');
      return;
    }
    tinyDoc.__bbCtxAttached = true;
    _ctxAttached = true;

    tinyDoc.addEventListener('contextmenu', onContextMenu, true); // <-- capture
    dbg('contextmenu listener attached (capture phase) to tinyDoc');

    // Clean-paste interceptor: when pasting Word/rich HTML, strip the junk
    // (mso-* styles, <o:p>, span soup, inline font/colour) while keeping semantic
    // formatting, then insert the cleaned HTML. Plain text and already-clean
    // content are left alone. Ctrl+Shift+V (TinyMCE plain-text paste) is not
    // affected because it doesn't carry text/html the same way.
    tinyDoc.addEventListener('paste', onCleanPaste, true);

    // Alt-hint overlay: hold Alt to reveal what's actionable where. Listen on
    // both the iframe doc and the top document (focus may be in either).
    const onAltDown = (e) => { if (e.key === 'Alt' && !e.repeat) showAltHints(); };
    const onAltUp   = (e) => { if (e.key === 'Alt') hideAltHints(); };
    tinyDoc.addEventListener('keydown', onAltDown, true);
    tinyDoc.addEventListener('keyup', onAltUp, true);
    document.addEventListener('keydown', onAltDown, true);
    document.addEventListener('keyup', onAltUp, true);
    // Safety: if the window loses focus while Alt is down, clear the overlay.
    window.addEventListener('blur', hideAltHints);
    if (tinyWin) tinyWin.addEventListener('blur', hideAltHints);

    // ── LEADER-KEY SHORTCUTS ────────────────────────────────────────────────
    // Single keys and Ctrl/Cmd combos are mostly claimed by the browser or
    // TinyMCE, so we use a two-key "leader" sequence that nothing else uses:
    // press the leader (default Alt+B), release, then within ~1.2s press an
    // action key. The combination only means something inside that short armed
    // window, so it can't collide with native shortcuts.
    //   Alt+B then R  → insert a plain row at the caret
    //   Alt+B then F  → run fix/repair
    //   Alt+B then M  → minimise / restore the panel
    const onLeaderKey = (e) => {
      // Arm on Alt+B (the leader). We use code 'KeyB' so it's layout-stable.
      if (e.altKey && (e.code === 'KeyB' || e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        armLeader();
        return;
      }
      if (!_leaderArmed) return;
      // An action key while armed.
      const k = (e.key || '').toLowerCase();
      let handled = true;
      if (k === 'r') {
        // Insert a plain row at the caret directly — no colour submenu.
        syncTinyRefs();
        insertRow('', null, null);
      } else if (k === 'f') {
        syncTinyRefs(); runFixPage();
      } else if (k === 'm') {
        const minimised = document.getElementById('bb-tk-minbar')?.style.display === 'flex';
        setMinimized(!minimised);
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
      disarmLeader();
    };
    document.addEventListener('keydown', onLeaderKey, true);
    if (tinyDoc) tinyDoc.addEventListener('keydown', onLeaderKey, true);
  }

  // Leader-key armed state + brief on-screen hint.
  let _leaderArmed = false;
  let _leaderTimer = null;
  let _leaderHintEl = null;
  function armLeader() {
    _leaderArmed = true;
    clearTimeout(_leaderTimer);
    _leaderTimer = setTimeout(disarmLeader, 1200);
    if (!_leaderHintEl) {
      _leaderHintEl = document.createElement('div');
      _leaderHintEl.id = 'bb-leader-hint';
      _leaderHintEl.innerHTML = 'BB: <b>R</b> insert row · <b>F</b> fix · <b>M</b> min · <b>D</b> direct-write';
      document.body.appendChild(_leaderHintEl);
    }
    _leaderHintEl.style.display = 'block';
  }
  function disarmLeader() {
    _leaderArmed = false;
    clearTimeout(_leaderTimer);
    if (_leaderHintEl) _leaderHintEl.style.display = 'none';
  }

  // ─── ALT-HINT OVERLAY ───────────────────────────────────────────────────────
  // While Alt is held, draw subtle coloured outlines + one label per category
  // over the actionable zones in the editor, so it's clear what Alt+right-click
  // does where. Categories: image, icon, table cell, component, row. Plus a
  // top banner that reflects whether text is selected (wrap/columns vs not).
  let _altHintEl = null;
  const ALT_CATEGORIES = [
    { key: 'image', sel: 'img', color: '#6f42c1', label: 'Image: figure / decorative / transcript / search' },
    { key: 'icon',  sel: 'i[class*="bi-"]', color: '#0d6efd', label: 'Icon: swap (one or all)' },
    { key: 'cell',  sel: 'td, th', color: '#198754', label: 'Table cell: colour / rows / cols' },
    { key: 'component', sel: '.accordion, .horizontal-tabs, .vertical-tabs-wrapper, .flip-cards, .text-carousel, .image-carousel, .reveal-table', color: '#fd7e14', label: 'Component: move / delete / duplicate / convert' },
    { key: 'youtube', sel: 'iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]', color: '#dc3545', label: 'YouTube: privacy-mode toggle' },
    { key: 'row',   sel: '.row.wysiwyg-mode', color: '#d63384', label: 'Row: colour / insert / PDF / align / strip / delete' },
  ];

  function showAltHints() {
    syncTinyRefs();
    if (!tinyDoc || !tinyFrame) return;
    hideAltHints();

    const overlay = document.createElement('div');
    overlay.id = 'bb-alt-overlay';
    const frameRect = tinyFrame.getBoundingClientRect();

    // Is there a live text selection? Changes the headline action.
    let hasSelection = false;
    try {
      const s = tinyWin.getSelection();
      hasSelection = s && !s.isCollapsed && s.toString().trim().length > 0;
    } catch {}

    // Headline banner.
    const banner = document.createElement('div');
    banner.className = 'bb-alt-banner';
    banner.textContent = hasSelection
      ? 'ALT + right-click your selection → wrap in card/accordion, make 2 columns, or image-search'
      : 'ALT + right-click — outlines show what each area does. Select text first for wrap / columns.';
    overlay.appendChild(banner);

    // Outline each category. To avoid clutter: only outline elements currently
    // in the viewport, and for the "row" category skip rows that contain a
    // flagged component (the component's own outline represents that area).
    const vw = window.innerWidth, vh = window.innerHeight;
    ALT_CATEGORIES.forEach(cat => {
      let labelled = false;
      let els;
      try { els = tinyDoc.querySelectorAll(cat.sel); } catch { els = []; }
      els.forEach(el => {
        // For rows: if the row contains a component we outline separately, skip
        // it to avoid a big overlapping box.
        if (cat.key === 'row' && el.querySelector('.accordion, .horizontal-tabs, .vertical-tabs-wrapper, .flip-cards, .text-carousel, .image-carousel, .reveal-table, table')) {
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        // Cull elements outside the visible iframe viewport (cuts box count on
        // long pages and keeps things legible).
        if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return;

        const box = document.createElement('div');
        box.className = 'bb-alt-box';
        box.style.left = (frameRect.left + r.left) + 'px';
        box.style.top = (frameRect.top + r.top) + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        box.style.outline = '2px solid ' + cat.color;
        box.style.background = hexToRgba(cat.color, 0.06);
        overlay.appendChild(box);

        if (!labelled) {
          const tag = document.createElement('div');
          tag.className = 'bb-alt-tag';
          tag.textContent = cat.label;
          tag.style.background = cat.color;
          tag.style.left = (frameRect.left + r.left) + 'px';
          tag.style.top = Math.max(frameRect.top, frameRect.top + r.top - 18) + 'px';
          overlay.appendChild(tag);
          labelled = true;
        }
      });
    });

    document.body.appendChild(overlay);
    _altHintEl = overlay;
  }

  function hideAltHints() {
    if (_altHintEl) { _altHintEl.remove(); _altHintEl = null; }
    const stray = document.getElementById('bb-alt-overlay');
    if (stray) stray.remove();
  }

  function hexToRgba(hex, a) {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function onContextMenu(e) {
    const tgt = e.target;

    // ── ALT GATE ──────────────────────────────────────────────────────────────
    // Plain right-click is left ENTIRELY to TinyMCE (links, images, paste,
    // spellcheck, its own table menu). The BB menu appears on ALT + right-click.
    // Alt was chosen over Shift because Shift+click NATIVELY extends the text
    // selection — that created a phantom selection on every click and made the
    // wrap menu fire constantly. Alt has no native selection behaviour, so the
    // selection stays exactly as the user left it. (Verified via diagnostics.)
    if (!e.altKey) {
      dbg('plain/non-Alt right-click — passing through to TinyMCE native menu');
      return;
    }

    dbg('ALT+contextmenu fired. target=', tgt && tgt.tagName, tgt && tgt.className);

    const claim = (what) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      dbg('BB menu CLAIMED as:', what);
    };

    // Priority 0a: inside a table cell -> table menu (single cell or multi-cell).
    const cellEl = tgt.closest && tgt.closest('td, th');
    if (cellEl) {
      claim('table-cell');
      openTableMenu(cellEl, e.clientX, e.clientY);
      return;
    }

    // Priority 0b: a DELIBERATE text selection -> wrap menu.
    // Hardened: require a non-collapsed selection AND that the click happened
    // inside it. This prevents a leftover selection elsewhere from hijacking a
    // click meant for something else.
    const sel = tinyWin && tinyWin.getSelection ? tinyWin.getSelection() : null;
    const selText = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    let clickInSelection = false;
    if (selText && sel.rangeCount) {
      try {
        const rng = sel.getRangeAt(0);
        // Does the click target fall within the selection range?
        clickInSelection = rng.intersectsNode ? rng.intersectsNode(tgt) : true;
      } catch { clickInSelection = true; }
    }
    if (selText && clickInSelection) {
      dbg('deliberate selection, length=', selText.length);
      claim('wrap-selection');
      openWrapMenu(sel, selText, e.clientX, e.clientY);
      return;
    }

    // Resolve targets.
    const iEl    = tgt.closest && tgt.closest('i[class*="bi-"]');
    const iconColEl = tgt.closest && tgt.closest('.icon-column');
    const iconHeadingEl = tgt.closest && tgt.closest('.icon-heading');
    const cardEl = tgt.closest && tgt.closest('.card');
    const imgEl  = tgt.closest && tgt.closest('img');
    const rowEl  = tgt.closest && tgt.closest('.row.wysiwyg-mode');
    // A YouTube iframe whose src can be switched to the privacy domain.
    const ytIframe = tgt.closest && tgt.closest('iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]');
    const linkEl = tgt.closest && tgt.closest('a[href]');
    const pdfEmbedEl = tgt.closest && tgt.closest('.pdf-container');
    let convEl = tgt.closest && tgt.closest(
      '.accordion, .horizontal-tabs, .vertical-tabs-wrapper, .flip-cards, ' +
      '.text-carousel, .image-carousel, .reveal-table');

    // Clicking inside a horizontal tab's CONTENT pane lands in the sibling
    // .tab-content, which isn't matched above. Map it back to the owning tab
    // component (the <ul.horizontal-tabs> sibling, or the .vertical-tabs-wrapper
    // ancestor) so item-ops are reachable from the pane too, not just the label.
    if (!convEl && tgt.closest) {
      const tc = tgt.closest('.tab-content');
      if (tc) {
        const wrapper = tc.closest('.vertical-tabs-wrapper');
        if (wrapper) convEl = wrapper;
        else {
          // horizontal: find the sibling <ul class="horizontal-tabs"> in the same parent
          const parent = tc.parentElement;
          const ul = parent && parent.querySelector('.horizontal-tabs');
          if (ul) convEl = ul;
        }
      }
    }

    // Priority 0.8: the heading beside an animated icon -> swap/remove menu.
    // (Can't target the <animated-icons> element itself — it only renders at
    // runtime via lottie-web, so it's invisible/unclickable in edit mode.)
    if (iconHeadingEl) {
      claim('animated-icon-header-menu');
      openAnimatedIconHeaderMenu(iconHeadingEl, e.clientX, e.clientY);
      return;
    }
    // Priority 0.9: an icon INSIDE a card's icon-column -> card menu, not the
    // generic icon-swap modal.
    if (iconColEl && iconColEl.closest('.card')) {
      claim('card-menu (icon column)');
      openCardMenu(iconColEl.closest('.card'), e.clientX, e.clientY);
      return;
    }
    // Priority 1: an icon -> icon swap
    if (iEl) {
      claim('icon-swap');
      openIconModal(iEl);
      return;
    }
    // Priority 1.35: a card (not on its icon) -> variant/icon menu.
    if (cardEl) {
      claim('card-menu');
      openCardMenu(cardEl, e.clientX, e.clientY);
      return;
    }

    // Priority 1.2: an image -> image options (figure/caption, decorative).
    if (imgEl) {
      claim('image-options');
      openImageMenu(imgEl, e.clientX, e.clientY);
      return;
    }

    // Priority 1.3: a YouTube iframe -> offer privacy-domain toggle.
    if (ytIframe) {
      claim('youtube-menu');
      openYouTubeMenu(ytIframe, e.clientX, e.clientY);
      return;
    }

    // Priority 1.4: a link (and no text selected) -> link options.
    const hasSelection = sel && !sel.isCollapsed && selText && selText.trim().length > 0;
    if (linkEl && !hasSelection) {
      claim('link-menu');
      openLinkMenu(linkEl, e.clientX, e.clientY);
      return;
    }

    // Priority 1.45: a PDF embed -> offer a download link + ratio tweak.
    if (pdfEmbedEl) {
      claim('pdf-embed-menu');
      openPdfEmbedMenu(pdfEmbedEl, e.clientX, e.clientY);
      return;
    }

    // Priority 1.5: a convertible/structured component -> component menu.
    // This combines item-ops (delete/move the specific item clicked), convert,
    // and duplicate-component into one menu.
    if (convEl) {
      claim('component-menu');
      openComponentMenu(convEl, tgt, e.clientX, e.clientY);
      return;
    }

    // (Paragraph -> columns is now part of the wrap-selection menu: select the
    // text and Alt+right-click. No separate paragraph branch needed.)

    // Priority 3: a row -> row menu (colour + insert-row-here live here now).
    // Gutter-edge detection was removed: diagnostics proved the space beside a
    // row belongs to .container, not the row, so edge clicks never landed on it.
    if (rowEl) {
      claim('row-menu');
      openRowMenu(rowEl, e.clientX, e.clientY, tgt);
      return;
    }

    // Priority 4: not on a row, but Alt+RC in the editor body (e.g. the gap
    // between rows) -> offer "insert row here" at the caret.
    claim('insert-row-here (no row under cursor)');
    openInsertRowMenu(e.clientX, e.clientY);
  }

  // (Paragraph→columns menu removed — these conversions now live in the
  // wrap-selection menu. Select the text and Alt+right-click to access them.)

  // ─── ROW COLOUR PALETTE ─────────────────────────────────────────────────────
  const ROW_COLOURS = [
    { cls: '',          label: 'None (plain)' },
    { cls: 'primary',   label: 'Primary' },
    { cls: 'secondary', label: 'Secondary' },
    { cls: 'tertiary',  label: 'Tertiary' },
    { cls: 'navy',      label: 'Navy' },
    { cls: 'gold',      label: 'Gold' },
    { cls: 'green',     label: 'Green' },
    { cls: 'forest',    label: 'Forest' },
    { cls: 'purple',    label: 'Purple' },
    { cls: 'lavender',  label: 'Lavender' },
    { cls: 'lightblue', label: 'Light blue' },
    { cls: 'red',       label: 'Red' },
    { cls: 'yellow',    label: 'Yellow' },
  ];
  const ALL_ROW_COLOUR_CLASSES = ROW_COLOURS.map(c => c.cls).filter(Boolean);

  // ─── ROW MENU (colour + insert row here) ────────────────────────────────────
  // Insert a single-item "Video References" icon accordion as the next
  // sibling of the video iframe itself, regardless of what wraps it (card,
  // column, etc). Matches the markup shape addIconAccordionItem/
  // generateIconAccordionCode produce in utils.js (single item -> no "Open
  // All" button, h3.accordion-header directly wrapping the button, deletion-
  // guard placeholders kept as in real generator output).
  function addImageSourcesRow(rowEl, mpIframe) {
    const accId = 'icon-accordion-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const headerId = `${accId}-header-0`;
    const collapseId = `${accId}-collapse-0`;
    const html = `<div class="col-12">
  <div class="accordion no-instructions" id="${accId}">
    <div class="accordion-item">
      <div class="deletion-guard" contenteditable="true"></div>
      <h3 class="accordion-header" role="heading" aria-level="3" id="${headerId}">
        <button class="accordion-button collapsed d-flex align-items-center gap-2 icon-header" type="button" data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="true" aria-controls="${collapseId}" contenteditable="false"><i class="material-icons">ondemand_video</i> <span contenteditable="true">Video References</span></button>
      </h3>
      <div id="${collapseId}" class="accordion-collapse collapse show" aria-labelledby="${headerId}">
        <div class="deletion-guard" contenteditable="true"></div>
        <div class="accordion-body">
          <div contenteditable="false"><div contenteditable="true">
            <p contenteditable="true">Paragraph</p>
          </div></div>
        </div>
      </div>
    </div>
  </div>
</div>`;

    const didWrite = tinyWrite(() => {
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = html.trim();
      const newBlock = tmp.firstElementChild;
      mpIframe.parentNode.insertBefore(newBlock, mpIframe.nextSibling);
    }, 'add video references accordion', { ungated: true });

    if (didWrite) { toast('✓ Video References accordion added', 'success'); scheduleAudit(); }
    else { copyToClipboard(html); toast('✓ Video References accordion copied — paste after the video', 'warn'); }
  }

  function openRowMenu(rowEl, x, y, tgt) {
    closeAnyMenu();
    const current = ALL_ROW_COLOUR_CLASSES.find(c => rowEl.classList.contains(c)) || '';
    dbg('openRowMenu. current colour=', current || '(none)');

    // Detect a nested row at the click point so we can offer "Remove nested row"
    // only when one actually exists.
    const nestedRow = findNestedRow(tgt, rowEl);

    const menu = document.createElement('div');
    menu.id = 'bb-row-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">Row colour</div>`;

    ROW_COLOURS.forEach(c => {
      const btn = document.createElement('button');
      const active = (c.cls === current) ? ' ✓' : '';
      btn.innerHTML = `<span class="bb-swatch bb-swatch-${c.cls || 'none'}"></span>${c.label}${active}`;
      btn.addEventListener('click', () => { applyRowColour(rowEl, c.cls); closeAnyMenu(); });
      menu.appendChild(btn);
    });

    // Insert-row-here entries (caret is in/near this row)
    const sep = document.createElement('div');
    sep.className = 'bb-ctx-sub';
    sep.textContent = 'Insert row';
    menu.appendChild(sep);
    [['before', '↑ Insert row above'], ['after', '↓ Insert row below']].forEach(([pos, label]) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        // Insert a plain (uncoloured) row directly — no colour submenu when
        // adding from within a row. Recolour afterwards via the row menu if
        // needed. (The gap/caret insert still offers the full colour list.)
        insertRow('', rowEl, pos);
        closeAnyMenu();
      });
      menu.appendChild(btn);
    });

      // Split this row in two at the clicked point.
    const splitBtn = document.createElement('button');
    splitBtn.textContent = '✂ Split row here';
    splitBtn.title = 'Split into two rows: the block you clicked (and everything after it) moves to a new row below';
    splitBtn.addEventListener('click', () => { splitRowAt(rowEl, tgt); closeAnyMenu(); });
    menu.appendChild(splitBtn);

    // Add an empty paragraph at the end of this row's content.
    const addParaBtn = document.createElement('button');
    addParaBtn.textContent = '¶ Add paragraph at end of row';
    addParaBtn.title = "Adds an empty paragraph as the last item inside this row's content and puts the cursor in it";
    addParaBtn.addEventListener('click', () => { addParagraphToRow(rowEl); closeAnyMenu(); });
    menu.appendChild(addParaBtn);

    // Insert a PDF embed into this row's content.
    const pdfBtn = document.createElement('button');
    pdfBtn.textContent = '📄 Embed PDF…';
    pdfBtn.title = 'Embed a PDF inside this row (asks for URL and aspect ratio)';
    pdfBtn.addEventListener('click', () => {
      // keep the row known; the ratio menu replaces this one
      const cur = document.getElementById('bb-row-menu');
      if (cur) cur.remove();
      insertPdfEmbed(rowEl, tgt, x, y);
    });
    menu.appendChild(pdfBtn);

    // Row utilities
    const sepU = document.createElement('div');
    sepU.className = 'bb-ctx-sub';
    sepU.textContent = 'Utilities';
    menu.appendChild(sepU);

    // If this row contains a two-column (image-column) block, offer vertical
    // alignment toggle. Default is centered; Bootstrap's .align-items-start
    // utility (already in your CSS, applies !important) overrides to top.
    const imgCol = rowEl.querySelector('.image-column');
    if (imgCol) {
      const isTop = imgCol.classList.contains('align-items-start');
      const alignBtn = document.createElement('button');
      alignBtn.textContent = isTop ? '↕ Center columns vertically' : '↕ Top-align columns';
      alignBtn.addEventListener('click', () => { toggleColumnAlign(imgCol); closeAnyMenu(); });
      menu.appendChild(alignBtn);
    }

    // If this row contains a D2L media library video, offer to add an
    // "Image Sources" reveal directly after it.
    const mpIframe = rowEl.querySelector('iframe[src*="mediaplayer.d2l"]');
    if (mpIframe) {
      const alreadyHasReveal = mpIframe.nextElementSibling &&
        mpIframe.nextElementSibling.querySelector &&
        mpIframe.nextElementSibling.querySelector('.accordion .accordion-button .material-icons');
      const srcBtn = document.createElement('button');
      if (alreadyHasReveal) {
        srcBtn.textContent = '✓ Video References accordion already added';
        srcBtn.disabled = true;
      } else {
        srcBtn.textContent = '🎬 Add "Video References" accordion after video';
        srcBtn.addEventListener('click', () => { addImageSourcesRow(rowEl, mpIframe); closeAnyMenu(); });
      }
      menu.appendChild(srcBtn);
    }

    const cleanBtn = document.createElement('button');
    cleanBtn.textContent = '🧹 Strip Word/paste formatting';
    cleanBtn.addEventListener('click', () => { stripFormattingIn(rowEl); closeAnyMenu(); });
    menu.appendChild(cleanBtn);

    const snipBtn = document.createElement('button');
    snipBtn.textContent = '⭐ Save row as snippet';
    snipBtn.title = 'Save this whole row to your snippet library to re-insert later';
    snipBtn.addEventListener('click', () => { saveRowAsSnippet(rowEl); closeAnyMenu(); });
    menu.appendChild(snipBtn);

    // Contextual: only when a nested row exists under the click.
    if (nestedRow) {
      const unwrapBtn = document.createElement('button');
      unwrapBtn.textContent = '⇲ Remove nested row (keep content)';
      unwrapBtn.title = 'Delete the inner Bootstrap row wrapper but keep everything inside it';
      unwrapBtn.addEventListener('click', () => { removeNestedRow(nestedRow); closeAnyMenu(); });
      menu.appendChild(unwrapBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'bb-danger';
    delBtn.textContent = '✕ Delete this row';
    delBtn.addEventListener('click', () => { deleteRow(rowEl); closeAnyMenu(); });
    menu.appendChild(delBtn);

    positionMenu(menu, x, y);
  }

  // Toggle vertical alignment of a two-column block using Bootstrap's
  // .align-items-start utility (which is !important, so it overrides the
  // image-column's default centering — and works on the published page too,
  // since it's a real class in your bootstrap.css).
  function toggleColumnAlign(imgCol) {
    const didWrite = tinyWrite(() => {
      imgCol.classList.toggle('align-items-start');
    }, 'toggle column align', { ungated: true });
    if (didWrite) {
      const top = imgCol.classList.contains('align-items-start');
      toast(top ? '✓ Columns top-aligned' : '✓ Columns centered', 'success');
    }
  }

  // Remove Word/paste cruft from an element's editable areas: empty spans,
  // inline style attributes, mso/o: tags, class="Mso…", and collapse nbsp runs.
  function stripFormattingIn(scopeEl) {
    const didWrite = tinyWrite(() => {
      const editables = scopeEl.matches('[contenteditable="true"]')
        ? [scopeEl]
        : [...scopeEl.querySelectorAll('[contenteditable="true"]')];
      const targets = editables.length ? editables : [scopeEl];
      targets.forEach(root => {
        // unwrap spans that only carry styling
        root.querySelectorAll('span').forEach(sp => {
          if (sp.classList.contains('deletion-guard')) return;
          // keep spans that are structural (e.g. editable label spans) — only
          // strip ones with style/class and no meaningful attributes
          if (sp.hasAttribute('style') || /(^|\s)Mso/.test(sp.className)) {
            const parent = sp.parentNode;
            while (sp.firstChild) parent.insertBefore(sp.firstChild, sp);
            parent.removeChild(sp);
          }
        });
        // strip inline styles + mso classes on all descendants
        root.querySelectorAll('[style]').forEach(el => {
          if (el.closest('figure') && el.classList.contains('image-container')) return; // keep positioning
          el.removeAttribute('style'); el.removeAttribute('data-mce-style');
        });
        root.querySelectorAll('[class]').forEach(el => {
          const cleaned = el.className.split(/\s+/).filter(c => !/^Mso/.test(c)).join(' ');
          if (cleaned !== el.className) el.className = cleaned;
        });
        // remove empty <o:p> and similar
        root.querySelectorAll('o\\:p, st1\\:*').forEach(n => n.remove());
        // collapse runs of &nbsp;
        root.innerHTML = root.innerHTML.replace(/(&nbsp;\s*){2,}/g, ' ');
      });
    }, 'strip formatting', { ungated: true });
    if (didWrite) { toast('✓ Formatting stripped', 'success'); scheduleAudit(); }
    else toast('Editor API unavailable', 'warn');
  }

  // Does this clipboard HTML look like Word/Office or otherwise "dirty" markup
  // worth cleaning? We only intercept when it does, so normal pastes pass through.
  function looksLikeWordHtml(html) {
    if (!html) return false;
    if (/x-tinymce\/html/i.test(html)) return false; // TinyMCE-to-TinyMCE copy, not Word
    return /<o:p|mso-|class=("|')?Mso|urn:schemas-microsoft-com|<!--\[if|<w:|<m:|style=("|')[^"']*mso/i.test(html)
        || /<span[^>]+style=/i.test(html) && /font-family|font-size|line-height/i.test(html);
  }

  // Clean Word/Office HTML to keep semantic formatting (b/strong, i/em, u,
  // headings, lists, links, sup/sub, basic tables) while dropping the junk:
  // mso styles, conditional comments, <o:p>/<w:*> tags, style/class/lang attrs,
  // empty spans. Returns a cleaned HTML string.
  function cleanWordHtml(html) {
    let s = html;
    // strip Office conditional comments and their content
    s = s.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // parse into a detached document we can walk
    const tmp = tinyDoc.createElement('div');
    tmp.innerHTML = s;

    // remove Office-namespaced and junk elements entirely (keep nothing)
    tmp.querySelectorAll('o\\:p, w\\:*, m\\:*, st1\\:*, xml, style, meta, link').forEach(n => n.remove());

    // allowed tags to keep; everything else gets unwrapped (children kept)
    const KEEP = new Set(['B','STRONG','I','EM','U','S','STRIKE','SUP','SUB','BR','P','H1','H2','H3','H4','H5','H6','UL','OL','LI','A','BLOCKQUOTE','TABLE','THEAD','TBODY','TR','TD','TH','CAPTION','SPAN','DIV']);
    // walk depth-first; unwrap disallowed elements
    const walk = (node) => {
      Array.from(node.children).forEach(child => {
        walk(child);
        if (!KEEP.has(child.tagName)) {
          const parent = child.parentNode;
          while (child.firstChild) parent.insertBefore(child.firstChild, child);
          parent.removeChild(child);
        }
      });
    };
    walk(tmp);

    // strip attributes except href (on a) — drop style/class/lang/dir/mso etc.
    tmp.querySelectorAll('*').forEach(el => {
      const keepHref = el.tagName === 'A' ? el.getAttribute('href') : null;
      const keepScope = el.tagName === 'TH' ? el.getAttribute('scope') : null;
      for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
      if (keepHref) el.setAttribute('href', keepHref);
      if (keepScope) el.setAttribute('scope', keepScope);
    });

    // unwrap spans/divs that no longer carry meaning (no attributes left)
    tmp.querySelectorAll('span, div').forEach(el => {
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });

    // collapse runs of &nbsp; and trim empty paragraphs
    let out = tmp.innerHTML.replace(/(&nbsp;\s*){2,}/g, ' ').replace(/<p>\s*(&nbsp;)?\s*<\/p>/gi, '');
    return out;
  }

  function onCleanPaste(e) {
    try {
      const cb = e.clipboardData || (tinyWin && tinyWin.clipboardData);
      if (!cb) return;
      const html = cb.getData('text/html');
      if (!html || !looksLikeWordHtml(html)) return; // let normal paste proceed
      // We will handle it: prevent the default dirty paste and insert cleaned.
      e.preventDefault();
      e.stopPropagation();
      const cleaned = cleanWordHtml(html);
      const ed = getTinyEditor();
      if (ed && cleaned) {
        ed.insertContent(cleaned);
        ed.setDirty(true);
        ed.dispatch('input');
        toast('✓ Pasted & cleaned Word formatting', 'success');
        scheduleAudit();
      } else if (cleaned) {
        // fallback: insert at selection via execCommand
        tinyDoc.execCommand('insertHTML', false, cleaned);
        toast('✓ Pasted & cleaned', 'success');
      }
    } catch (err) {
      dbg('clean paste failed, allowing default', err);
      // don't preventDefault on error — let the browser paste normally
    }
  }

  // Detect a nested Bootstrap row at/around the click: a .row that is itself
  // inside another row's content (row-in-row). Returns the INNER row element, or
  // null. We look from the clicked target upward, but stop at the outer row.
  function findNestedRow(tgt, outerRow) {
    if (!tgt || !outerRow) return null;
    let el = tgt.closest ? tgt.closest('.row') : null;
    // climb: the first .row that is strictly inside outerRow (not outerRow itself)
    while (el && el !== outerRow) {
      // is el nested within another row that is within/equal outerRow?
      const parentRow = el.parentElement && el.parentElement.closest('.row');
      if (parentRow && (parentRow === outerRow || outerRow.contains(parentRow))) {
        return el; // el is a nested row
      }
      el = el.parentElement && el.parentElement.closest('.row');
    }
    return null;
  }

  // Remove a nested Bootstrap row but KEEP its content. The inner row's own
  // col-* children are grid wrappers that are invalid once their row is gone, so
  // we promote the CONTENTS of those columns up into the inner row's place, then
  // remove the inner row. Non-column children are promoted as-is. Anything deeper
  // (components, figures) is preserved intact.
  function removeNestedRow(innerRow) {
    const didWrite = tinyWrite(() => {
      const parent = innerRow.parentNode;
      if (!parent) return;
      const frag = tinyDoc.createDocumentFragment();
      Array.from(innerRow.children).forEach(child => {
        const isCol = /(^|\s)col(-|\s|$)/.test(child.className || '') || /\bcol-/.test(child.className || '');
        if (isCol) {
          // lift the column's children out (the col wrapper is now invalid)
          while (child.firstChild) frag.appendChild(child.firstChild);
        } else {
          // not a column (could be the row's deletion-guards or real content) —
          // keep real content, drop empty structural guards.
          const txt = (child.textContent || '').replace(/\u00a0/g, '').trim();
          const hasEl = child.querySelector && child.querySelector('*');
          if (txt.length > 0 || hasEl || (child.tagName === 'IMG')) {
            frag.appendChild(child);
          }
          // else: empty guard/spacer — discard
        }
      });
      parent.insertBefore(frag, innerRow);
      innerRow.remove();
    }, 'remove nested row (keep content)', { ungated: true });
    if (didWrite) {
      toast('✓ Nested row removed, content kept', 'success');
      scheduleAudit();
      refreshComponentList();
    }
  }

  function deleteRow(rowEl) {
    const didWrite = tinyWrite(() => { rowEl.remove(); }, 'delete row', { ungated: true });
    if (didWrite) { toast('✓ Row deleted', 'success'); scheduleAudit(); refreshComponentList(); }
  }

    // Split a row in two at the clicked block. The direct child of
// editable-row-content containing the click (and all following nodes) moves
// into a new row inserted below; earlier content stays put.
function splitRowAt(rowEl, tgt) {
  const editable = rowEl.querySelector('.editable-row-content');
  if (!editable) { toast('No editable content in this row', 'warn'); return; }

  const directChild = (node) => {
    let el = node;
    while (el && el.parentElement && el.parentElement !== editable) el = el.parentElement;
    return (el && el.parentElement === editable) ? el : null;
  };
  let splitNode = directChild(tgt);
  if (!splitNode) { const ed = getTinyEditor(); if (ed) splitNode = directChild(ed.selection.getNode()); }
  if (!splitNode) { toast('Click on the content where you want to split', 'warn'); return; }

  let hasBefore = false;
  for (let n = splitNode.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim())) { hasBefore = true; break; }
  }
  if (!hasBefore) { toast('Nothing above the split point — click lower in the row', 'warn'); return; }

  const didWrite = tinyWrite(() => {
    const newRow = tinyDoc.createElement('div');
    newRow.className = rowEl.className;
    newRow.setAttribute('contenteditable', 'false');
    newRow.innerHTML = '<div class="deletion-guard" contenteditable="true"><br></div>'
                     + '<div class="editable-row-content wysiwyg-mode" contenteditable="true"></div>'
                     + '<div class="deletion-guard" contenteditable="true"><br></div>';
    const newEditable = newRow.querySelector('.editable-row-content');
    const toMove = [];
    for (let n = splitNode; n; n = n.nextSibling) toMove.push(n);
    toMove.forEach(node => newEditable.appendChild(node)); // move, not clone → ids stay unique
    rowEl.parentNode.insertBefore(newRow, rowEl.nextSibling);
  }, 'split row', { ungated: true });

  if (didWrite) { toast('✓ Row split into two', 'success'); scheduleAudit(); refreshComponentList(); }
  else toast('Editor API unavailable', 'warn');
}

// Append an empty paragraph as the last item in the row's editable content and
// drop the caret into it.
function addParagraphToRow(rowEl) {
  const editable = rowEl.querySelector('.editable-row-content');
  if (!editable) { toast('No editable content area in this row', 'warn'); return; }
  const didWrite = tinyWrite((ed) => {
    const p = tinyDoc.createElement('p');
    p.innerHTML = '<br>';
    editable.appendChild(p);
    ed.focus();
    const rng = tinyDoc.createRange();
    rng.setStart(p, 0); rng.collapse(true);
    const s = tinyWin.getSelection();
    s.removeAllRanges(); s.addRange(rng);
  }, 'add paragraph to row', { ungated: true });
  if (didWrite) { toast('✓ Paragraph added — start typing', 'success'); scheduleAudit(); }
  else toast('Editor API unavailable', 'warn');
}

  // Inspect what meaningful content a row holds, so we can warn when moving the
  // row will carry MORE than the single component the user clicked. Structural
  // chrome (deletion-guard, editable-row-content, col-* wrappers) doesn't count —
  // we count detected components, images, and non-empty standalone text blocks.
  function rowContentSummary(rowEl) {
    const editable = rowEl.querySelector('.editable-row-content') || rowEl;
    const sels = COMPONENT_DETECTORS.map(d => d.sel).join(',');
    // distinct top-most component elements inside the row
    const comps = [];
    const seen = new Set();
    editable.querySelectorAll(sels).forEach(el => {
      // skip if nested inside another already-collected component
      if (comps.some(c => c.contains(el))) return;
      // skip if this is an ancestor of one we have — replace
      for (let i = comps.length - 1; i >= 0; i--) {
        if (el.contains(comps[i])) comps.splice(i, 1);
      }
      if (!seen.has(el)) { seen.add(el); comps.push(el); }
    });
    // standalone images not already inside a counted component
    let images = 0;
    editable.querySelectorAll('img').forEach(img => {
      if (!comps.some(c => c.contains(img))) images++;
    });
    // non-empty text blocks (paragraphs/headings/lists) not inside a component
    let textBlocks = 0;
    editable.querySelectorAll('p, h1, h2, h3, h4, h5, h6, ul, ol, blockquote').forEach(b => {
      if (comps.some(c => c.contains(b))) return;
      if ((b.textContent || '').replace(/\u00a0/g, '').trim().length > 0) textBlocks++;
    });
    const pieces = comps.length + images + textBlocks;
    return { pieces, comps: comps.length, images, textBlocks };
  }

  // Move a row up (-1) or down (+1) among its sibling rows in .container.
  function moveRow(rowEl, dir) {
    const didWrite = tinyWrite(() => {
      const parent = rowEl.parentNode;
      if (!parent) return;
      // adjacent SIBLING that is itself a row (skip stray text/comment nodes)
      let sib = dir < 0 ? rowEl.previousElementSibling : rowEl.nextElementSibling;
      while (sib && !sib.classList.contains('row')) {
        sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
      }
      if (!sib) return; // at the edge
      if (dir < 0) parent.insertBefore(rowEl, sib);
      else parent.insertBefore(sib, rowEl);
    }, 'move row ' + (dir < 0 ? 'up' : 'down'), { ungated: true });
    if (didWrite) {
      toast(dir < 0 ? '✓ Row moved up' : '✓ Row moved down', 'success');
      scheduleAudit();
      refreshComponentList();
    }
  }

  // Is there an adjacent sibling row in the given direction? (for edge-disabling)
  function rowHasSibling(rowEl, dir) {
    let sib = dir < 0 ? rowEl.previousElementSibling : rowEl.nextElementSibling;
    while (sib && !sib.classList.contains('row')) {
      sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
    }
    return !!sib;
  }

  function applyRowColour(rowEl, newCls) {
    const didWrite = tinyWrite(() => {
      ALL_ROW_COLOUR_CLASSES.forEach(c => rowEl.classList.remove(c));
      if (newCls) rowEl.classList.add(newCls);
    }, 'applyRowColour -> ' + (newCls || 'none'), { ungated: true });

    if (didWrite) {
      toast(`✓ Row colour set to ${newCls || 'none'}`, 'success');
      scheduleAudit();
      return;
    }
    const clone = rowEl.cloneNode(true);
    ALL_ROW_COLOUR_CLASSES.forEach(c => clone.classList.remove(c));
    if (newCls) clone.classList.add(newCls);
    copyToClipboard(clone.outerHTML);
    toast(`✓ Recoloured row (${newCls || 'none'}) copied — paste over the old row`, 'warn');
  }

  // ─── CARET-BASED ROW INSERTION ──────────────────────────────────────────────
  // Diagnostics established that the space beside a row belongs to .container,
  // not the row, so gutter-clicking can't work. Instead we insert at the caret:
  // place the cursor in the gap between rows (or pick above/below a row), choose
  // a colour, and a new empty row drops in as a sibling in .container.

  function openInsertRowMenu(x, y, anchorRow, position, absolute) {
    closeAnyMenu();
    dbg('openInsertRowMenu. anchorRow=', !!anchorRow, 'position=', position);

    const menu = document.createElement('div');
    menu.id = 'bb-insertrow-menu';
    menu.className = 'bb-ctx-menu';
    const where = anchorRow ? `Insert row ${position}` : 'Insert row at cursor';
    menu.innerHTML = `<div class="bb-ctx-title">${where}</div>`;

    ROW_COLOURS.forEach(c => {
      const btn = document.createElement('button');
      btn.innerHTML = `<span class="bb-swatch bb-swatch-${c.cls || 'none'}"></span>${c.label === 'None (plain)' ? 'Empty row' : c.label + ' row'}`;
      btn.addEventListener('click', () => {
        insertRow(c.cls, anchorRow, position);
        closeAnyMenu();
      });
      menu.appendChild(btn);
    });

    const compBtn = document.createElement('button');
    compBtn.textContent = '▸ Insert component…';
    compBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInsertComponentMenu(x, y, anchorRow, position, absolute);
    });
    menu.appendChild(compBtn);

    positionMenu(menu, x, y, absolute);
  }

  // Component library menu: grouped by category. Reuses the same anchor/position
  // targeting as openInsertRowMenu so the component lands in the same spot the
  // row-colour menu would have inserted an empty row.
  function openInsertComponentMenu(x, y, anchorRow, position, absolute) {
    closeAnyMenu();
    dbg('openInsertComponentMenu. anchorRow=', !!anchorRow, 'position=', position);

    const menu = document.createElement('div');
    menu.id = 'bb-insertcomponent-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">Insert component</div>`;

    let lastCategory = null;
    INSERT_LIBRARY.forEach(entry => {
      if (entry.category !== lastCategory) {
        const sub = document.createElement('div');
        sub.className = 'bb-ctx-sub';
        sub.textContent = entry.category;
        menu.appendChild(sub);
        lastCategory = entry.category;
      }
      const btn = document.createElement('button');
      btn.textContent = entry.label;
      btn.addEventListener('click', () => {
        insertComponent(entry, anchorRow, position);
        closeAnyMenu();
      });
      menu.appendChild(btn);
    });

    positionMenu(menu, x, y, absolute);
  }

  // Insert a library component as a new sibling row, using the same
  // anchor-row / at-caret targeting logic as insertRow().
  function insertComponent(entry, anchorRow, position) {
    const html = entry.build();

    const didWrite = tinyWrite((ed) => {
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = html.trim();
      const newRow = tmp.firstElementChild;

      if (anchorRow && anchorRow.parentNode) {
        if (position === 'before') anchorRow.parentNode.insertBefore(newRow, anchorRow);
        else anchorRow.parentNode.insertBefore(newRow, anchorRow.nextSibling);
      } else {
        const container = ed.getBody().querySelector('.container') || ed.getBody();
        let node = ed.selection.getNode();
        while (node && node.parentElement && node.parentElement !== container) {
          node = node.parentElement;
        }
        if (node && node.parentElement === container) {
          container.insertBefore(newRow, node.nextSibling);
        } else {
          container.appendChild(newRow);
        }
      }

      try {
        const editable = newRow.querySelector('.editable-row-content');
        if (editable) {
          const rng = tinyDoc.createRange();
          rng.selectNodeContents(editable);
          rng.collapse(true);
          const s = tinyWin.getSelection();
          s.removeAllRanges();
          s.addRange(rng);
        }
      } catch (err) { dbg('caret place failed', err); }
    }, 'insertComponent ' + entry.label + (anchorRow ? ' ' + position : ' at-caret'), { ungated: true });

    if (didWrite) {
      toast(`✓ ${entry.label} inserted`, 'success');
      scheduleAudit();
      return;
    }
    copyToClipboard(html);
    toast(`✓ ${entry.label} copied — paste where you want it`, 'warn');
  }

  function insertRow(cls, anchorRow, position) {
    const html = TPL.wrapRow('<p><br></p>', cls);

    const didWrite = tinyWrite((ed) => {
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = html.trim();
      const newRow = tmp.firstElementChild;

      if (anchorRow && anchorRow.parentNode) {
        // Insert relative to the anchor row
        if (position === 'before') anchorRow.parentNode.insertBefore(newRow, anchorRow);
        else anchorRow.parentNode.insertBefore(newRow, anchorRow.nextSibling);
      } else {
        // Insert at the caret. Find the caret's top-level block within the
        // editor body / container and insert the row as a sibling after it.
        const container = ed.getBody().querySelector('.container') || ed.getBody();
        let node = ed.selection.getNode();
        // climb to a direct child of the container
        while (node && node.parentElement && node.parentElement !== container) {
          node = node.parentElement;
        }
        if (node && node.parentElement === container) {
          container.insertBefore(newRow, node.nextSibling);
        } else {
          container.appendChild(newRow);
        }
      }

      // place caret inside the new row's editable area
      try {
        const editable = newRow.querySelector('.editable-row-content');
        if (editable) {
          const rng = tinyDoc.createRange();
          rng.selectNodeContents(editable);
          rng.collapse(true);
          const s = tinyWin.getSelection();
          s.removeAllRanges();
          s.addRange(rng);
        }
      } catch (err) { dbg('caret place failed', err); }
    }, 'insertRow ' + (cls || 'empty') + (anchorRow ? ' ' + position : ' at-caret'), { ungated: true });

    if (didWrite) {
      toast(`✓ ${cls || 'Empty'} row inserted`, 'success');
      scheduleAudit();
      return;
    }
    copyToClipboard(html);
    toast(`✓ ${cls || 'Empty'} row copied — paste where you want it`, 'warn');
  }

  // Insert a PDF embed into a row's content. Prompts for the PDF URL, ensures
  // #toolbar=0, then offers aspect-ratio presets (default A4 portrait). The embed
  // is added as a full-width col-12 block inside the host row's editable content,
  // after the clicked column if one is resolvable, else appended.
  function insertPdfEmbed(rowEl, tgt, x, y) {
    const raw = window.prompt('PDF URL (the file to embed):', '');
    if (raw == null) return;
    let src = raw.trim();
    if (!src) { toast('No PDF URL given', 'warn'); return; }
    // default the viewer toolbar off unless the URL already sets a #fragment
    if (!/#/.test(src)) src += '#toolbar=0';

    // Build the ratio-preset menu.
    const menu = document.createElement('div');
    menu.id = 'bb-pdf-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = '<div class="bb-ctx-title">PDF aspect ratio</div>';
    PDF_RATIOS.forEach(r => {
      const btn = document.createElement('button');
      btn.textContent = r.label + (r.default ? '  (default)' : '');
      btn.addEventListener('click', () => {
        let css = r.css;
        if (css == null) {
          const typed = window.prompt('Custom aspect ratio as width / height (e.g. 3 / 4):', '1 / 1.414');
          if (typed == null) { closeAnyMenu(); return; }
          css = typed.trim();
          // accept "3/4" or "3 / 4"; basic sanity
          if (!/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(css)) {
            toast('Ratio must look like  3 / 4', 'error'); return;
          }
        }
        doInsertPdf(rowEl, tgt, src, css);
        closeAnyMenu();
      });
      menu.appendChild(btn);
    });
    positionMenu(menu, x, y);
  }

  function doInsertPdf(rowEl, tgt, src, ratioCss) {
    const didWrite = tinyWrite(() => {
      const html = TPL.pdfEmbed(src, ratioCss);
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = html.trim();
      const block = tmp.firstElementChild; // <div class="col-12">…</div>

      const editable = rowEl.querySelector('.editable-row-content') || rowEl;
      // Try to insert right after the column the user clicked in; else append.
      let unit = tgt && tgt.closest ? tgt.closest('[class*="col-"]') : null;
      if (unit && unit.parentElement !== editable) unit = null;
      if (unit) editable.insertBefore(block, unit.nextSibling);
      else editable.appendChild(block);
    }, 'insert PDF embed', { ungated: true });
    if (didWrite) {
      toast('✓ PDF embedded', 'success');
      scheduleAudit();
    } else {
      copyToClipboard(TPL.pdfEmbed(src, ratioCss));
      toast('✓ PDF block copied — editor API unavailable, paste manually', 'warn');
    }
  }

  // Menu for an existing PDF embed: add a download link, or change aspect ratio.
  function openPdfEmbedMenu(container, x, y) {
    closeAnyMenu();
    const embed = container.querySelector('embed');
    const rawSrc = embed ? (embed.getAttribute('src') || '') : '';
    const cleanSrc = rawSrc.split('#')[0]; // without the #toolbar=0 fragment

    const menu = document.createElement('div');
    menu.id = 'bb-pdf-embed-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = '<div class="bb-ctx-title">PDF embed</div>';

    const add = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { fn(); closeAnyMenu(); });
      menu.appendChild(b);
    };

    // Does a download link already exist right after the container's col?
    const col = container.closest('[class*="col-"]') || container.parentElement;
    const alreadyHasLink = col && col.nextElementSibling &&
      col.nextElementSibling.querySelector && col.nextElementSibling.querySelector('a.pdf-download-link');

    if (!alreadyHasLink) {
      add('⬇ Add "Download PDF" link below', () => {
        const didWrite = tinyWrite(() => {
          const linkBlock = tinyDoc.createElement('div');
          linkBlock.className = 'col-12';
          linkBlock.innerHTML = `<p><a class="pdf-download-link" href="${cleanSrc}" target="_blank" rel="noopener noreferrer" download>Download PDF</a></p>`;
          if (col && col.parentNode) col.parentNode.insertBefore(linkBlock, col.nextSibling);
        }, 'add pdf download link', { ungated: true });
        if (didWrite) { toast('✓ Download link added', 'success'); scheduleAudit(); }
      });
    }

    // Change aspect ratio.
    PDF_RATIOS.filter(r => r.css).forEach(r => {
      add('↔ Ratio: ' + r.label, () => {
        const didWrite = tinyWrite(() => {
          container.style.setProperty('aspect-ratio', r.css);
        }, 'change pdf ratio', { ungated: true });
        if (didWrite) { toast('✓ Ratio set to ' + r.label, 'success'); scheduleAudit(); }
      });
    });

    positionMenu(menu, x, y);
  }

  // YouTube iframe menu: toggle between the standard and privacy-enhanced
  // (youtube-nocookie.com) domains.
  function openYouTubeMenu(iframe, x, y) {
    closeAnyMenu();
    const src = iframe.getAttribute('src') || '';
    const isNoCookie = /youtube-nocookie\.com/.test(src);

    const menu = document.createElement('div');
    menu.id = 'bb-youtube-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = '<div class="bb-ctx-title">YouTube embed</div>';

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = isNoCookie
      ? '↩ Use standard youtube.com'
      : '🔒 Use privacy mode (youtube-nocookie.com)';
    toggleBtn.title = isNoCookie
      ? 'Switch back to the standard YouTube domain'
      : 'Switch to youtube-nocookie.com so YouTube does not set tracking cookies until play';
    toggleBtn.addEventListener('click', () => { setYouTubeNoCookie(iframe, !isNoCookie); closeAnyMenu(); });
    menu.appendChild(toggleBtn);

    positionMenu(menu, x, y);
  }

  function setYouTubeNoCookie(iframe, toNoCookie) {
    const didWrite = tinyWrite(() => {
      let src = iframe.getAttribute('src') || '';
      if (toNoCookie) {
        src = src.replace('://www.youtube.com/', '://www.youtube-nocookie.com/')
                 .replace('://youtube.com/', '://www.youtube-nocookie.com/');
      } else {
        src = src.replace('://www.youtube-nocookie.com/', '://www.youtube.com/')
                 .replace('://youtube-nocookie.com/', '://www.youtube.com/');
      }
      iframe.setAttribute('src', src);
      iframe.removeAttribute('data-mce-src');
      // a content page with several videos benefits from lazy embeds
      if (!iframe.getAttribute('loading')) iframe.setAttribute('loading', 'lazy');
    }, 'youtube nocookie toggle', { ungated: true });
    if (didWrite) {
      toast(toNoCookie ? '✓ Switched to youtube-nocookie.com' : '✓ Switched to youtube.com', 'success');
      scheduleAudit();
    } else {
      toast('Could not update the iframe — editor API unavailable', 'error');
    }
  }

  // ─── LINK ACTIONS ───────────────────────────────────────────────────────────
  // Tracking params we strip from URLs.
  const TRACKING_PARAMS = [
    'utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id',
    'gclid','fbclid','mc_cid','mc_eid','igshid','yclid','dclid','msclkid',
    '_hsenc','_hsmi','vero_id','oly_anon_id','oly_enc_id','wickedid','ref','ref_src'
  ];

  // Remove tracking params from a URL string. Returns {url, removed:[names]}.
  function stripTrackingFromUrl(url) {
    const removed = [];
    try {
      const u = new URL(url, (tinyFrame && tinyFrame.src) || location.href);
      TRACKING_PARAMS.forEach(p => {
        if (u.searchParams.has(p)) { u.searchParams.delete(p); removed.push(p); }
      });
      // also strip utm_* / *clid we didn't enumerate
      Array.from(u.searchParams.keys()).forEach(k => {
        if (/^utm_/i.test(k) || /clid$/i.test(k)) { u.searchParams.delete(k); removed.push(k); }
      });
      let out = u.toString();
      // URL() can add a trailing '?' when all params removed — tidy it
      out = out.replace(/\?$/, '');
      return { url: out, removed };
    } catch {
      return { url, removed };
    }
  }

  function isExternalHref(href) {
    try {
      const u = new URL(href, (tinyFrame && tinyFrame.src) || location.href);
      const here = new URL((tinyFrame && tinyFrame.src) || location.href);
      return /^https?:$/.test(u.protocol) && u.host !== here.host;
    } catch { return false; }
  }

  function openLinkMenu(linkEl, x, y) {
    closeAnyMenu();
    const href = linkEl.getAttribute('href') || '';
    const menu = document.createElement('div');
    menu.id = 'bb-link-menu';
    menu.className = 'bb-ctx-menu';
    const shown = href.length > 40 ? href.slice(0, 40) + '…' : href;
    menu.innerHTML = `<div class="bb-ctx-title">Link: ${escapeHtml(shown)}</div>`;

    const add = (label, fn, danger) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (danger) b.classList.add('bb-danger');
      b.addEventListener('click', () => { fn(); closeAnyMenu(); });
      menu.appendChild(b);
    };

    // Strip tracking — only offer if there's something to strip.
    const preview = stripTrackingFromUrl(href);
    if (preview.removed.length) {
      add(`🧼 Strip tracking params (${preview.removed.length})`, () => {
        const didWrite = tinyWrite(() => {
          linkEl.setAttribute('href', preview.url);
          linkEl.removeAttribute('data-mce-href');
        }, 'strip tracking params', { ungated: true });
        if (didWrite) { toast(`✓ Removed ${preview.removed.length} tracking param(s)`, 'success'); scheduleAudit(); }
      });
    }

    // New-tab toggle.
    const opensNew = linkEl.getAttribute('target') === '_blank';
    add(opensNew ? '↩ Open in same tab' : '↗ Open in new tab (+ safe rel)', () => {
      const didWrite = tinyWrite(() => {
        if (opensNew) {
          linkEl.removeAttribute('target');
          linkEl.removeAttribute('rel');
        } else {
          linkEl.setAttribute('target', '_blank');
          linkEl.setAttribute('rel', 'noopener noreferrer');
        }
      }, 'toggle link target', { ungated: true });
      if (didWrite) { toast(opensNew ? '✓ Opens in same tab' : '✓ Opens in new tab (rel added)', 'success'); scheduleAudit(); }
    });

    // Replace href — closes the gap left by Audit Toolkit's probe/lint
    // fix buttons, which were removed when Audit went view-only (see
    // rebuild plan §3.5). A broken/malformed link Audit flags gets fixed
    // here, manually, once the author is in the editor.
    add('✎ Replace href…', () => {
      const next = window.prompt('New href for this link:', href);
      if (next == null || next === href) return;
      const didWrite = tinyWrite(() => {
        linkEl.setAttribute('href', next);
        linkEl.removeAttribute('data-mce-href');
      }, 'replace href', { ungated: true });
      if (didWrite) { toast('✓ Href updated', 'success'); scheduleAudit(); }
    });

    // Auto-fix from the structural URL linter (shared core) — offered only
    // when the linter actually finds something wrong with this href.
    if (S) {
      const lint = S.lintHref(href);
      if (lint) {
        add(`🩹 Fix formatting → ${lint.fixed.length > 40 ? lint.fixed.slice(0, 40) + '…' : lint.fixed}`, () => {
          const didWrite = tinyWrite(() => {
            linkEl.setAttribute('href', lint.fixed);
            linkEl.removeAttribute('data-mce-href');
          }, 'lint fix href', { ungated: true });
          if (didWrite) { toast(`✓ Fixed: ${lint.reasons.join(', ')}`, 'success'); scheduleAudit(); }
        });
      }
    }

    positionMenu(menu, x, y);
  }

  // ─── SHARED MENU HELPERS ────────────────────────────────────────────────────
  function positionMenu(menu, x, y, absolute) {
    // Compute the intended page coordinates.
    let px, py;
    if (absolute) {
      px = x; py = y;
    } else {
      const frameRect = tinyFrame ? tinyFrame.getBoundingClientRect() : { left: 0, top: 0 };
      px = frameRect.left + x;
      py = frameRect.top + y;
    }

    // Append off-screen first so we can measure its real size, then clamp it to
    // the viewport (flip up/left when it would overflow the bottom/right edge).
    menu.style.left = '-9999px';
    menu.style.top = '-9999px';
    document.body.appendChild(menu);

    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = menu.getBoundingClientRect();
    const mw = rect.width, mh = rect.height;
    const pad = 8;

    // Horizontal: if it would run off the right, shift left so it fits.
    if (px + mw + pad > vw) px = Math.max(pad, vw - mw - pad);
    if (px < pad) px = pad;

    // Vertical: if it would run off the bottom, try placing it ABOVE the click
    // point; if that also doesn't fit, clamp to the top with a scrollable body.
    if (py + mh + pad > vh) {
      const above = py - mh;
      if (above >= pad) py = above;                 // flip up from the click
      else py = Math.max(pad, vh - mh - pad);       // clamp; menu has max-height + scroll
    }
    if (py < pad) py = pad;

    menu.style.left = px + 'px';
    menu.style.top = py + 'px';

    setTimeout(() => {
      document.addEventListener('click', closeAnyMenu, { once: true });
    }, 0);
    document.addEventListener('keydown', anyMenuEsc);
  }

  function anyMenuEsc(e) { if (e.key === 'Escape') closeAnyMenu(); }

  const BB_MENU_IDS = ['bb-row-menu', 'bb-insertrow-menu', 'bb-insertcomponent-menu', 'bb-wrap-menu', 'bb-image-menu',
    'bb-component-menu', 'bb-convert-menu', 'bb-table-menu', 'bb-icon-menu',
    'bb-pdf-menu', 'bb-youtube-menu', 'bb-link-menu', 'bb-pdf-embed-menu', 'bb-card-menu',
    'bb-animated-icon-menu'];

  // Close all BB context menus. When invoked from a document click we receive the
  // event: if that click landed *inside* one of our menus (e.g. on a button that
  // opens a submenu), we do nothing and let that button's own handler run. Only
  // clicks outside every menu dismiss them. This removes the race where the click
  // that opens a submenu is the same click that would otherwise close it.
  function closeAnyMenu(e) {
    if (e && e.target && e.target.closest) {
      const insideMenu = BB_MENU_IDS.some(id => {
        const m = document.getElementById(id);
        return m && m.contains(e.target);
      });
      if (insideMenu) {
        // Re-arm for the next outside click, since this listener was {once:true}.
        // Only bother if a menu is actually still present.
        const stillOpen = BB_MENU_IDS.some(id => document.getElementById(id));
        if (stillOpen) {
          setTimeout(() => document.addEventListener('click', closeAnyMenu, { once: true }), 0);
        }
        return;
      }
    }
    BB_MENU_IDS.forEach(id => {
      const m = document.getElementById(id);
      if (m) m.remove();
    });
    document.removeEventListener('keydown', anyMenuEsc);
  }

  // ─── WRAP SELECTION ─────────────────────────────────────────────────────────
  // Alt+right-click selected text -> wrap it in a component (selection becomes
  // the body/content). Uses clone-from-live: if a matching component exists on
  // the page we clone it (guaranteeing an exact structural match) and drop the
  // selection text in; otherwise we fall back to the TPL templates. Alerts were
  // removed — only accordion + the three cards.

  // Find a live component on the page to clone, by detector type.
  function findLiveByType(typeNames) {
    const comps = detectComponents();
    for (const name of typeNames) {
      const hit = comps.find(c => c.type === name);
      if (hit) return hit;
    }
    return null;
  }

  // Build a wrapped accordion containing the selection as its single item's body.
  function buildWrapAccordion(text) {
    const live = findLiveByType(['Accordion']);
    if (live) {
      // clone the live accordion's ROW, keep just the first item, set its body
      const row = (live.el.closest('.row.wysiwyg-mode') || live.el).cloneNode(true);
      const acc = row.querySelector('.accordion');
      const items = acc.querySelectorAll('.accordion-item');
      // remove all but the first item
      items.forEach((it, i) => { if (i > 0) it.remove(); });
      // fresh ids on the whole accordion
      const newId = uid('accordion');
      const oldId = acc.id;
      acc.id = newId;
      if (oldId) {
        row.querySelectorAll(`[id^="${cssEsc(oldId)}"]`).forEach(n => { n.id = n.id.replace(oldId, newId); });
        row.querySelectorAll(`[data-bs-target="#${cssEsc(oldId)}-collapse-0"]`).forEach(n => n.setAttribute('data-bs-target', '#' + newId + '-collapse-0'));
        row.querySelectorAll(`[aria-controls^="${cssEsc(oldId)}"]`).forEach(n => n.setAttribute('aria-controls', n.getAttribute('aria-controls').replace(oldId, newId)));
        row.querySelectorAll(`[aria-labelledby^="${cssEsc(oldId)}"]`).forEach(n => n.setAttribute('aria-labelledby', n.getAttribute('aria-labelledby').replace(oldId, newId)));
      }
      const toggleBtn = row.querySelector('.accordion-toggle-button');
      if (toggleBtn) toggleBtn.setAttribute('data-accordion-id', newId);
      // set heading + body
      const span = acc.querySelector('.accordion-button span[contenteditable="true"]');
      if (span) span.textContent = 'Heading';
      const body = acc.querySelector('.accordion-body [contenteditable="true"]');
      if (body) body.innerHTML = `<p>${escapeHtml(text)}</p>`;
      return row.outerHTML;
    }
    // fallback to template
    const id = uid('accordion');
    const item = TPL.accordionItem(id, 0, 'Heading', `<p>${escapeHtml(text)}</p>`);
    return TPL.wrapRow(TPL.accordion(id, item));
  }

  function buildWrapCard(variant, text) {
    const live = findLiveByType(['Icon Card']); // any card row to clone structure
    // Prefer cloning a plain card of the same variant if present
    let cardEl = null;
    if (tinyDoc) cardEl = tinyDoc.querySelector('.card.card-' + variant + ':not(.card-with-icon)');
    if (cardEl) {
      const row = (cardEl.closest('.row.wysiwyg-mode') || cardEl).cloneNode(true);
      const body = row.querySelector('.card-body [contenteditable="true"]');
      if (body) {
        const title = body.querySelector('.card-title');
        const textP = body.querySelector('.card-text');
        if (title) title.textContent = 'Title';
        if (textP) textP.textContent = text;
        else body.innerHTML = `<h3 class="card-title">Title</h3><p class="card-text">${escapeHtml(text)}</p>`;
      }
      return row.outerHTML;
    }
    // fallback template
    return TPL.wrapRow(TPL.card(variant, escapeHtml(text)));
  }

  // ─── CARD OPTIONS MENU ──────────────────────────────────────────────────────
  // Alt+right-click a .card. Three independent features:
  //  • variant: card-white / card-primary / card-secondary / card-tertiary
  //  • card-with-icon: Bootstrap icon in a .icon-column beside card-body content
  //  • animated icon header: separate <animated-icons> element in a
  //    .icon-heading wrapper beside .card-title — unrelated to card-with-icon
  const CARD_VARIANTS = ['white', 'primary', 'secondary', 'tertiary'];
  const ANIMATED_ICON_TOKEN = '391cb841-334a-42ea-ae60-5955a80eb056'; // update once self-hosting replaces this

  function openCardMenu(cardEl, x, y) {
    closeAnyMenu();
    const current = CARD_VARIANTS.find(v => cardEl.classList.contains('card-' + v)) || null;
    const hasIcon = cardEl.classList.contains('card-with-icon');
    const menu = document.createElement('div');
    menu.id = 'bb-card-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">Card</div>`;
    const add = (label, fn) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => { fn(); closeAnyMenu(); });
      menu.appendChild(btn);
    };
    const sepV = document.createElement('div');
    sepV.className = 'bb-ctx-sub';
    sepV.textContent = 'Variant';
    menu.appendChild(sepV);
    CARD_VARIANTS.forEach(v => {
      add((v === current ? '✓ ' : '') + v.charAt(0).toUpperCase() + v.slice(1), () => cardSetVariant(cardEl, v));
    });
    const sepI = document.createElement('div');
    sepI.className = 'bb-ctx-sub';
    sepI.textContent = 'Icon (card-with-icon layout)';
    menu.appendChild(sepI);
    add(hasIcon ? 'Remove icon header (Bootstrap icon)' : 'Add icon header (Bootstrap icon)', () => cardToggleIcon(cardEl));
    const sepA = document.createElement('div');
    sepA.className = 'bb-ctx-sub';
    sepA.textContent = 'Animated icon';
    menu.appendChild(sepA);
    if (cardHasAnimatedIcon(cardEl)) {
      add('Remove animated icon', () => cardRemoveAnimatedIconHeader(cardEl));
    } else {
      add('Add animated icon in header…', () => cardAddAnimatedIconHeader(cardEl));
    }
    positionMenu(menu, x, y);
  }

  function cardSetVariant(cardEl, variant) {
    const didWrite = tinyWrite(() => {
      CARD_VARIANTS.forEach(v => cardEl.classList.remove('card-' + v));
      cardEl.classList.add('card-' + variant);
      const iconColor = variant === 'white' ? 'var(--bs-tertiary-dark)' : 'white';
      const icon = cardEl.querySelector('.icon-column i, .icon-column span');
      if (icon) icon.style.color = iconColor;
    }, 'card set variant -> ' + variant, { ungated: true });
    finishImage(didWrite, 'Card set to ' + variant);
  }

  function cardToggleIcon(cardEl) {
    const hasIcon = cardEl.classList.contains('card-with-icon');
    const didWrite = tinyWrite(() => {
      const body = cardEl.querySelector('.card-body');
      if (!hasIcon) {
        const variant = CARD_VARIANTS.find(v => cardEl.classList.contains('card-' + v)) || 'white';
        const iconColor = variant === 'white' ? 'var(--bs-tertiary-dark)' : 'white';
        const inner = body.querySelector('[contenteditable="true"]');
        const innerHTML = inner ? inner.outerHTML : body.innerHTML;
        body.classList.add('d-flex');
        body.innerHTML = `<div class="icon-column"><i class="bi bi-star-fill" style="color: ${iconColor};" aria-hidden="true"></i></div><div class="content-column">${innerHTML}</div>`;
        cardEl.classList.add('card-with-icon');
      } else {
        const inner = body.querySelector('.content-column > [contenteditable="true"]');
        body.classList.remove('d-flex');
        body.innerHTML = inner ? inner.outerHTML : body.innerHTML;
        cardEl.classList.remove('card-with-icon');
      }
    }, 'toggle card icon header', { ungated: true });
    finishImage(didWrite, hasIcon ? 'Icon header removed' : 'Icon header added');
  }

  function cardHasAnimatedIcon(cardEl) {
    return !!cardEl.querySelector('.icon-heading animated-icons');
  }

  function cardAddAnimatedIconHeader(cardEl) {
    const name = window.prompt('Animated icon name (animatedicons.co):', 'star');
    if (name == null) return;
    const didWrite = tinyWrite(() => {
      const title = cardEl.querySelector('.card-title');
      if (!title || title.closest('.icon-heading')) return;
      const wrap = tinyDoc.createElement('div');
      wrap.className = 'icon-heading';
      const icon = tinyDoc.createElement('animated-icons');
      icon.setAttribute('loading', 'lazy');
      icon.setAttribute('trigger', 'auto');
      icon.setAttribute('src', `https://animatedicons.co/get-icon?name=${encodeURIComponent(name)}&style=minimalistic&token=${ANIMATED_ICON_TOKEN}`);
      title.classList.add('d-inline');
      title.parentNode.insertBefore(wrap, title);
      wrap.appendChild(icon);
      wrap.appendChild(title);
    }, 'add animated icon header', { ungated: true });
    finishImage(didWrite, 'Animated icon added');
  }

  function cardRemoveAnimatedIconHeader(cardEl) {
    const wrap = cardEl.querySelector('.icon-heading');
    if (wrap) removeAnimatedIconHeaderGeneric(wrap);
  }

  // ─── ANIMATED ICON: RIGHT-CLICK SWAP ────────────────────────────────────────
  // Works on any <animated-icons> element on the page, not just card headers.
  function animatedIconCurrentName(el) {
    const src = el.getAttribute('src') || '';
    try { return new URL(src).searchParams.get('name') || ''; } catch { return ''; }
  }

  function swapAnimatedIcon(el) {
    const cur = animatedIconCurrentName(el);
    const name = window.prompt('Animated icon name (animatedicons.co):', cur);
    if (name == null || !name.trim() || name.trim() === cur) return;
    const didWrite = tinyWrite(() => {
      const src = el.getAttribute('src') || '';
      try {
        const u = new URL(src);
        u.searchParams.set('name', name.trim());
        el.setAttribute('src', u.toString());
      } catch {
        el.setAttribute('src', `https://animatedicons.co/get-icon?name=${encodeURIComponent(name.trim())}&style=minimalistic&token=${ANIMATED_ICON_TOKEN}`);
      }
      el.removeAttribute('data-mce-src');
    }, 'swap animated icon', { ungated: true });
    finishImage(didWrite, 'Animated icon swapped to "' + name.trim() + '"');
  }

  function openAnimatedIconHeaderMenu(wrapEl, x, y) {
    closeAnyMenu();
    const menu = document.createElement('div');
    menu.id = 'bb-animated-icon-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">Animated icon</div>`;
    const add = (label, fn) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => { fn(); closeAnyMenu(); });
      menu.appendChild(btn);
    };
    const iconEl = wrapEl.querySelector('animated-icons');
    add('✎ Swap icon…', () => { if (iconEl) swapAnimatedIcon(iconEl); });
    add('✕ Remove animated icon', () => removeAnimatedIconHeaderGeneric(wrapEl));
    positionMenu(menu, x, y);
  }

  function removeAnimatedIconHeaderGeneric(wrapEl) {
    const didWrite = tinyWrite(() => {
      const title = wrapEl.querySelector('.card-title')
        || wrapEl.querySelector('h1,h2,h3,h4,h5,h6')
        || [...wrapEl.children].find(c => c.tagName !== 'ANIMATED-ICONS');
      if (title) { title.classList.remove('d-inline'); wrapEl.parentNode.insertBefore(title, wrapEl); }
      wrapEl.remove();
    }, 'remove animated icon header', { ungated: true });
    finishImage(didWrite, 'Animated icon removed');
  }

  // ─── IMAGE OPTIONS MENU ─────────────────────────────────────────────────────
  // Alt+right-click an <img>. Detects whether it's bare, in a figure with a
  // caption, or decorative, and offers the relevant transforms:
  //  • bare image      -> wrap in a proper <figure> (with image-container +
  //                       figcaption), matching the block-builder structure
  //  • content <-> decorative: decorative removes caption, adds the 'decorative'
  //                       class on figure+img, sets alt="" ; content does reverse
  function imageState(imgEl) {
    const figure = imgEl.closest('figure');
    const hasFigure = !!figure;
    const hasCaption = !!(figure && figure.querySelector('figcaption'));
    const isDecorative = !!(figure && figure.classList.contains('decorative'))
                      || imgEl.classList.contains('decorative')
                      || (imgEl.getAttribute('alt') === '' && hasFigure && !hasCaption);
    return { figure, hasFigure, hasCaption, isDecorative };
  }

  function openImageMenu(imgEl, x, y) {
    closeAnyMenu();
    const st = imageState(imgEl);
    dbg('openImageMenu. state=', st);

    const menu = document.createElement('div');
    menu.id = 'bb-image-menu';
    menu.className = 'bb-ctx-menu';
    menu.innerHTML = `<div class="bb-ctx-title">Image</div>`;

    const add = (label, fn) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => { fn(); closeAnyMenu(); });
      menu.appendChild(btn);
    };

    if (!st.hasFigure) {
      add('Wrap in figure (+ caption)', () => imageToFigure(imgEl, false));
      add('Wrap in figure — decorative', () => imageToFigure(imgEl, true));
      add('Mark as decorative (no figure)', () => imageMarkDecorativeSimple(imgEl));
    } else if (st.isDecorative) {
      add('Make content image (+ caption)', () => imageSetDecorative(imgEl, false));
    } else {
      add('Make decorative (remove caption)', () => imageSetDecorative(imgEl, true));
      if (!st.hasCaption) add('Add caption', () => imageAddCaption(imgEl));
    }

    // Reverse image search (Google Lens by image URL) — only useful if the
    // image has a real, public http(s) src (not a data: URI or placeholder).
    const src = imgEl.getAttribute('src') || '';
    const sep = document.createElement('div');
    sep.className = 'bb-ctx-sub';
    sep.textContent = 'Search';
    menu.appendChild(sep);
    add('🔍 Reverse image search (Google Lens)', () => reverseImageSearch(src));
    add('🤖 Copy image + open Copilot (alt text)', () => copyImageToClipboardAndOpenCopilot(imgEl));

    // Accessibility: add a transcript accordion below (for complex/text images).
    const sepA = document.createElement('div');
    sepA.className = 'bb-ctx-sub';
    sepA.textContent = 'Accessibility';
    menu.appendChild(sepA);
    add('+ Transcript accordion below', () => addTranscriptBelow(imgEl));

    // Alt text controls.
    const sepAlt = document.createElement('div');
    sepAlt.className = 'bb-ctx-sub';
    sepAlt.textContent = 'Alt text';
    menu.appendChild(sepAlt);
    add('⌀ Set alt=""', () => setAltEmpty(imgEl));
    add('⌀ Set alt="See accordion..."', () => setAltAccordion(imgEl));
    add('✎ Set alt text…', () => setAltText(imgEl));

    // Replace the image source via a prompt.
    const sepR = document.createElement('div');
    sepR.className = 'bb-ctx-sub';
    sepR.textContent = 'Source';
    menu.appendChild(sepR);
    add('🔗 Replace image URL…', () => replaceImageSrc(imgEl));

    positionMenu(menu, x, y);
  }

  function setAltEmpty(imgEl) {
    const didWrite = tinyWrite(() => {
      imgEl.setAttribute('alt', '');
    }, 'set alt empty', { ungated: true });
    finishImage(didWrite, 'alt set to ""');
  }

    function setAltAccordion(imgEl) {
    const didWrite = tinyWrite(() => {
      imgEl.setAttribute('alt', 'See accordion below image');
    }, 'set alt accordion', { ungated: true });
    finishImage(didWrite, 'alt set to "See accordion below image"');
  }

  function setAltText(imgEl) {
    const cur = imgEl.getAttribute('alt') || '';
    const next = window.prompt('Alt text for this image:', cur === 'REQUIRED' ? '' : cur);
    if (next == null) return; // cancelled
    const didWrite = tinyWrite(() => {
      imgEl.setAttribute('alt', next);
    }, 'set alt text', { ungated: true });
    finishImage(didWrite, 'Alt text set');
  }

  function replaceImageSrc(imgEl) {
    const cur = imgEl.getAttribute('src') || '';
    const next = window.prompt('New image URL:', cur);
    if (next == null) return; // cancelled
    const url = next.trim();
    if (!url) return;
    const didWrite = tinyWrite(() => {
      imgEl.setAttribute('src', url);
      imgEl.removeAttribute('data-mce-src');
    }, 'replace image src', { ungated: true });
    finishImage(didWrite, 'Image URL replaced');
  }

  // Insert a transcript accordion immediately AFTER the image. Sets the image alt to "See accordion below image"
  function addTranscriptBelow(imgEl) {
  const didWrite = tinyWrite(() => {
    const id = uid('transcript');
    const item = TPL.accordionItem(id, 0, 'Image description', '<p>Describe the image / transcribe its text here.</p>');

    const figWrap = imgEl.closest('.figure-wrapper') || imgEl.closest('figure') || imgEl.parentElement;

    // If this image is the ONLY image inside a surrounding multi-column
    // layout (.image-column, .columns-2/-2-no-line/-3/-4), insert the
    // transcript full-width below the whole column block, wrapped in the
    // same .col-12 the block builder's own generator uses for this
    // component, rather than nested in a half/third column — nesting it
    // there skews that layout's vertical centering (see
    // .image-column .figure-wrapper in bootstrap.css). If the layout holds
    // more than one image (e.g. two images side by side, each with its own
    // transcript), fall through to the original in-place insertion so each
    // transcript stays paired with its own image instead of all landing at
    // the bottom.
    const colWrap = imgEl.closest('.image-column, .columns-2, .columns-2-no-line, .columns-3, .columns-4');
    const promote = colWrap && colWrap.querySelectorAll('img').length === 1;

    const accHTML = promote
      ? `<div class="col-12"><div class="accordion transcript" id="${id}">${item}</div></div>`
      : `<div class="accordion transcript" id="${id}">${item}</div>`;

    const tmp = tinyDoc.createElement('div');
    tmp.innerHTML = accHTML.trim();
    const accEl = tmp.firstElementChild;

    if (promote) {
      colWrap.parentNode.insertBefore(accEl, colWrap.nextSibling);
    } else {
      figWrap.parentNode.insertBefore(accEl, figWrap.nextSibling);
    }

    imgEl.setAttribute('alt', 'See accordion below image');
  }, 'add transcript accordion', { ungated: true });
  finishImage(didWrite, 'Transcript description added (alt set to empty)');
}

  // Open Google Lens reverse search for an image URL in a new tab. Google's
  // classic ?image_url= was removed, but Lens accepts uploadbyurl.
  function reverseImageSearch(src) {
    if (!src || /^data:/i.test(src)) {
      toast('Image has no public URL to search (data/placeholder image)', 'warn');
      return;
    }
    // Resolve relative URLs against the page origin so Lens gets an absolute URL.
    let abs = src;
    try { abs = new URL(src, (tinyFrame && tinyFrame.src) || location.href).href; } catch {}
    const lens = 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(abs);
    window.open(lens, '_blank', 'noopener');
    dbg('reverse image search ->', abs);
  }

  // Fetch the image, put it on the clipboard as a real image (not HTML/URL),
  // then open the Copilot agent so the user can paste it in and ask for alt
  // text. Needs the image to be fetchable cross-origin (most CMS-hosted
  // images are); canvas re-encode also strips it to a plain PNG, which
  // clipboard image writes require (browsers won't accept image/jpeg here).
  async function copyImageToClipboardAndOpenCopilot(imgEl) {
    const src = imgEl.currentSrc || imgEl.getAttribute('src') || '';
    if (!src || /^data:/i.test(src)) {
      toast('Image has no fetchable URL to copy', 'warn');
      return;
    }
    let abs = src;
    try { abs = new URL(src, (tinyFrame && tinyFrame.src) || location.href).href; } catch {}

    try {
      const resp = await fetch(abs, { mode: 'cors' });
      if (!resp.ok) throw new Error('fetch failed: ' + resp.status);
      const srcBlob = await resp.blob();
      console.log('[BB] image fetch debug:', {
        url: abs,
        status: resp.status,
        contentType: resp.headers.get('content-type'),
        blobType: srcBlob.type,
        blobSize: srcBlob.size,
      });

      // createImageBitmap can't reliably decode SVG blobs (Chromium gap) —
      // load it through a real <img> element instead, which uses the
      // browser's normal SVG renderer.
      const objectUrl = URL.createObjectURL(srcBlob);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('img decode failed'));
        el.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 900;
      canvas.height = img.naturalHeight || 500;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!pngBlob) throw new Error('canvas toBlob failed');

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      toast('✓ Image copied — opening Copilot, paste it in', 'success');
      window.open(COPILOT_AGENT_URL, '_blank', 'noopener');
    } catch (err) {
      console.error('[BB] copyImageToClipboardAndOpenCopilot failed', err);
      toast('Could not copy image (likely blocked by CORS) — see console', 'error');
    }
  }

  // Wrap a bare <img> in the standard figure structure.
  function imageToFigure(imgEl, decorative) {
    const didWrite = tinyWrite(() => {
      const src = imgEl.getAttribute('src') || '';
      const fig = tinyDoc.createElement('div');
      const alt = decorative ? '' : (imgEl.getAttribute('alt') || 'REQUIRED');
      const decoClass = decorative ? ' decorative' : '';
      const figcap = decorative ? '' : `<figcaption contenteditable="false">${captionHTML('Caption ')}</figcaption>`;
      fig.innerHTML = `<figure class="wysiwyg-mode${decoClass}"><div class="image-container" style="position: relative;" contenteditable="false"><div contenteditable="true"><img src="${src}" alt="${alt}" class="img-fluid${decoClass}"></div></div>${figcap}</figure>`;
      const figure = fig.firstElementChild;
      // Replace the img (or its nearest editable wrapper) with the figure
      const wrapper = imgEl.closest('[contenteditable="true"]');
      const replaceTarget = (wrapper && wrapper.children.length === 1 && wrapper.firstElementChild === imgEl) ? wrapper : imgEl;
      replaceTarget.replaceWith(figure);
    }, 'image -> figure' + (decorative ? ' (decorative)' : ''), { ungated: true });
    finishImage(didWrite, decorative ? 'Wrapped as decorative figure' : 'Wrapped in figure');
  }

  // Mark a bare image (e.g. inside a carousel, not wrapped in <figure>) as
  // decorative directly — no figure/caption involved.
  function imageMarkDecorativeSimple(imgEl) {
    const didWrite = tinyWrite(() => {
      imgEl.classList.add('decorative');
      imgEl.setAttribute('alt', '');
    }, 'image mark decorative (no figure)', { ungated: true });
    finishImage(didWrite, 'Marked decorative');
  }

  // Toggle an existing figure between decorative and content.
  function imageSetDecorative(imgEl, decorative) {
    const didWrite = tinyWrite(() => {
      const figure = imgEl.closest('figure');
      if (!figure) return;
      if (decorative) {
        figure.classList.add('decorative');
        imgEl.classList.add('decorative');
        imgEl.setAttribute('alt', '');
        const cap = figure.querySelector('figcaption');
        if (cap) cap.remove();
      } else {
        figure.classList.remove('decorative');
        imgEl.classList.remove('decorative');
        if (!imgEl.getAttribute('alt')) imgEl.setAttribute('alt', 'REQUIRED');
        if (!figure.querySelector('figcaption')) {
          const cap = tinyDoc.createElement('figcaption');
          cap.setAttribute('contenteditable', 'false');
          cap.innerHTML = captionHTML('Caption ');
          figure.appendChild(cap);
        }
      }
    }, 'image decorative=' + decorative, { ungated: true });
    finishImage(didWrite, decorative ? 'Now decorative' : 'Now a content image');
  }

  function imageAddCaption(imgEl) {
    const didWrite = tinyWrite(() => {
      const figure = imgEl.closest('figure');
      if (!figure || figure.querySelector('figcaption')) return;
      const cap = tinyDoc.createElement('figcaption');
      cap.setAttribute('contenteditable', 'false');
      cap.innerHTML = captionHTML('Caption ');
      figure.appendChild(cap);
    }, 'image add caption', { ungated: true });
    finishImage(didWrite, 'Caption added');
  }

  function finishImage(didWrite, okMsg) {
    if (didWrite) { toast('✓ ' + okMsg, 'success'); scheduleAudit(); }
    else toast('Editor API unavailable for image edit', 'warn');
  }

  function openWrapMenu(sel, selText, x, y) {
    closeAnyMenu();
    let savedRange = null;
    try { savedRange = sel.getRangeAt(0).cloneRange(); } catch (err) { dbg('no range', err); }

    const menu = document.createElement('div');
    menu.id = 'bb-wrap-menu';
    menu.className = 'bb-ctx-menu';
    const preview = selText.length > 28 ? selText.slice(0, 28) + '…' : selText;
    menu.innerHTML = `<div class="bb-ctx-title">Wrap “${escapeHtml(preview)}” in…</div>`;

    const opts = [
      { act: 'accordion',     label: 'Accordion (text = body)' },
      { act: 'card-white',    label: 'Card — white' },
      { act: 'card-primary',  label: 'Card — primary' },
      { act: 'card-secondary',label: 'Card — secondary' },
      { act: 'card-icon',     label: 'Card — with icon' },
    ];
    opts.forEach(o => {
      const btn = document.createElement('button');
      btn.textContent = o.label;
      btn.addEventListener('click', () => { doWrap(o.act, selText, savedRange); closeAnyMenu(); });
      menu.appendChild(btn);
    });

    // Two-column conversions (text becomes one column). Same selection, same
    // menu — no need for a separate paragraph menu.
    const sub = document.createElement('div');
    sub.className = 'bb-ctx-sub';
    sub.textContent = 'Two columns';
    menu.appendChild(sub);
    const colOpts = [
      { act: 'image-text', label: '↹ image + text' },
      { act: 'text-image', label: '↹ text + image' },
      { act: 'icon-text',  label: '↹ icon + text' },
      { act: 'text-icon',  label: '↹ text + icon' },
    ];
    colOpts.forEach(o => {
      const btn = document.createElement('button');
      btn.textContent = o.label;
      btn.addEventListener('click', () => { doWrap(o.act, selText, savedRange); closeAnyMenu(); });
      menu.appendChild(btn);
    });

    // Image search for the selected phrase.
    const sub2 = document.createElement('div');
    sub2.className = 'bb-ctx-sub';
    sub2.textContent = 'Image search';
    menu.appendChild(sub2);
    const searchBtns = [
      { label: '🔍 Google Images (new tab)', fn: () => googleImageSearch(selText) },
      { label: '🎨 Envato Elements photos (new tab)', fn: () => envatoSearch(selText) },
      { label: '🖼 Block-builder picker', fn: () => builderImageSearch(selText) },
    ];
    searchBtns.forEach(o => {
      const btn = document.createElement('button');
      btn.textContent = o.label;
      btn.addEventListener('click', () => { o.fn(); closeAnyMenu(); });
      menu.appendChild(btn);
    });

    positionMenu(menu, x, y);
  }

  // Open an Envato Elements search for the selected phrase in a new tab, using
  // the real search endpoint (search?itemType=photos&term=<query>). Defaults to
  // photos; from the results page you can switch itemType to graphics/3d.
  function envatoSearch(query) {
    const q = (query || '').trim();
    if (!q) { toast('No text selected', 'warn'); return; }
    const searchUrl = 'https://app.envato.com/search?itemType=photos&term=' + encodeURIComponent(q);
    window.open(searchUrl, '_blank', 'noopener');
    dbg('envato search ->', q);
  }

  // Open a Google Images search for a text phrase in a new tab.
  function googleImageSearch(query) {
    const q = (query || '').trim();
    if (!q) { toast('No text selected', 'warn'); return; }
    const url = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(q);
    window.open(url, '_blank', 'noopener');
    dbg('google image search ->', q);
  }

  // Ask the block-builder (loaded in another frame/window) to open its image
  // picker pre-filled with the query. The builder side must listen for this
  // message and call its searchAllApis(query) + open the offcanvas. We post to
  // every plausible target: the opener, the parent, and any iframes we can see.
  function builderImageSearch(query) {
    const q = (query || '').trim();
    if (!q) { toast('No text selected', 'warn'); return; }
    const msg = { type: 'bb-image-search', query: q };

    // Prefer the builder iframe specifically (matched by its URL). This is more
    // reliable than spraying every frame, and lets us warn if the pane is shut.
    let builderFrame = null;
    try {
      builderFrame = [...document.querySelectorAll('iframe')]
        .find(f => /Block-Builder/i.test(f.src || ''));
    } catch {}

    let delivered = 0;
    if (builderFrame && builderFrame.contentWindow) {
      try { builderFrame.contentWindow.postMessage(msg, '*'); delivered++; } catch {}
    }
    // Fallbacks: opener, parent, and any other frames (harmless — non-builder
    // frames simply won't have a matching listener).
    try { if (window.opener) { window.opener.postMessage(msg, '*'); delivered++; } } catch {}
    try { if (window.parent && window.parent !== window) { window.parent.postMessage(msg, '*'); delivered++; } } catch {}
    if (!builderFrame) {
      try {
        document.querySelectorAll('iframe').forEach(f => {
          try { f.contentWindow && f.contentWindow.postMessage(msg, '*'); delivered++; } catch {}
        });
      } catch {}
    }

    dbg('builderImageSearch: builderFrame=', !!builderFrame, 'delivered=', delivered, 'q=', q);

    if (!delivered) {
      toast('Could not reach the block-builder picker — open the pane first', 'warn');
      return;
    }

    // Wait for the builder to acknowledge (the listener in utils.js posts back
    // {type:'bb-image-search-ack', query, ok}). Show an accurate toast based on
    // the real result; fall back to a "sent" message if no ack arrives shortly
    // (e.g. an older builder without the listener).
    let acked = false;
    const onAck = (e) => {
      const d = e.data;
      if (!d || d.type !== 'bb-image-search-ack' || d.query !== q) return;
      acked = true;
      window.removeEventListener('message', onAck);
      clearTimeout(ackTimer);
      if (d.ok) toast(`✓ Searching “${q}” in the block builder`, 'success');
      else toast(`Builder received “${q}” but couldn't run the search`, 'warn');
    };
    window.addEventListener('message', onAck);
    const ackTimer = setTimeout(() => {
      if (acked) return;
      window.removeEventListener('message', onAck);
      // No ack — message was posted but nothing replied.
      toast(`Sent “${q}” — if nothing happened, open the Block Builder pane`, 'warn');
    }, 1500);
  }

  function doWrap(act, selText, savedRange) {
    let row;
    if (act === 'accordion') row = buildWrapAccordion(selText);
    else if (act === 'card-white') row = buildWrapCard('white', selText);
    else if (act === 'card-primary') row = buildWrapCard('primary', selText);
    else if (act === 'card-secondary') row = buildWrapCard('secondary', selText);
    else if (act === 'card-icon') row = TPL.wrapRow(TPL.iconCard(escapeHtml(selText)));
    else if (act === 'image-text') row = TPL.wrapRow(TPL.colImageText(escapeHtml(selText)));
    else if (act === 'text-image') row = TPL.wrapRow(TPL.colTextImage(escapeHtml(selText)));
    else if (act === 'icon-text')  row = TPL.wrapRow(TPL.colIconText(escapeHtml(selText)));
    else if (act === 'text-icon')  row = TPL.wrapRow(TPL.colTextIcon(escapeHtml(selText)));

    const didWrite = tinyWrite((ed) => {
      if (savedRange) {
        const s = tinyWin.getSelection();
        s.removeAllRanges();
        s.addRange(savedRange);
        // Replace the selection's enclosing row if it's a simple text row,
        // else replace just the selected range.
        const startEl = savedRange.startContainer.nodeType === 1
          ? savedRange.startContainer
          : savedRange.startContainer.parentElement;
        const host = startEl && startEl.closest('.row.wysiwyg-mode');
        const hostSimple = host && !host.querySelector('.accordion, .card, .image-column, .horizontal-tabs, .vertical-tabs-wrapper, .flip-cards, table');
        const tmp = tinyDoc.createElement('div');
        tmp.innerHTML = row.trim();
        const node = tmp.firstElementChild;
        if (hostSimple) {
          host.replaceWith(node);
        } else {
          savedRange.deleteContents();
          savedRange.insertNode(node);
        }
      } else {
        ed.insertContent(row);
      }
    }, 'wrap selection -> ' + act, { ungated: true });

    if (didWrite) {
      toast(`✓ Wrapped selection in ${act}`, 'success');
      scheduleAudit();
      return;
    }
    copyToClipboard(row);
    toast(`✓ ${act} (with your text) copied — paste over the selected text`, 'warn');
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
  }

  // ─── CLIPBOARD HISTORY ──────────────────────────────────────────────────────
  function loadHistory() {
    try {
      clipHistory = JSON.parse(GM_getValue('bb-clip-history', '[]'));
    } catch {
      clipHistory = [];
    }
  }

  function saveHistory() {
    GM_setValue('bb-clip-history', JSON.stringify(clipHistory));
  }

  function pushHistory(label, html) {
    loadHistory();
    // Remove existing entry with same label to avoid duplicates
    clipHistory = clipHistory.filter(i => i.label !== label);
    clipHistory.unshift({ label, html, ts: Date.now() });
    if (clipHistory.length > HISTORY_MAX) clipHistory = clipHistory.slice(0, HISTORY_MAX);
    saveHistory();
    // Update badge / list if history tab open
    if (document.querySelector('.bb-tab[data-tab="history"]')?.classList.contains('active')) {
      refreshHistoryList();
    }
  }

  // Listen for postMessage from block builder
  window.addEventListener('message', e => {
    if (!e.data || e.data.type !== 'bb-copy') return;
    const { label, html } = e.data;
    if (label && html) pushHistory(label, html);
  });

  // ─── MUTATION OBSERVER on TinyMCE ─────────────────────────────────────────
  function attachMutationObserver() {
    syncTinyRefs();
    if (!tinyDoc) return;
    const obs = new MutationObserver(() => {
      scheduleAudit();
      // Refresh component list if open
      if (document.querySelector('.bb-tab[data-tab="components"]')?.classList.contains('active')) {
        refreshComponentList();
      }
    });
    obs.observe(tinyDoc.body, { childList: true, subtree: true, characterData: true });
  }

  // ─── DRAG ──────────────────────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, mx = 0, my = 0;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      ox = el.offsetLeft; oy = el.offsetTop;
      mx = e.clientX;     my = e.clientY;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    function onMove(e) {
      el.style.left = (ox + e.clientX - mx) + 'px';
      el.style.top  = (oy + e.clientY - my) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
  }

  // ─── STYLES ────────────────────────────────────────────────────────────────
  function injectPanelStyles() {
    if (document.getElementById('bb-toolkit-styles')) return;
    const s = document.createElement('style');
    s.id = 'bb-toolkit-styles';
    s.textContent = `
      #bb-toolkit-panel {
        position: fixed;
        top: 0; left: 0; bottom: 0;
        width: 360px;
        background: #fff;
        border-right: 1px solid #cdd5dc;
        box-shadow: 4px 0 24px rgba(0,0,0,.18);
        z-index: 1900000;
        font-family: "Lato", sans-serif;
        font-size: 14px;
        color: #202122;
        display: flex;
        flex-direction: column;
      }
      .bb-fr-input { width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid #cdd5dc; border-radius: 4px; font-size: 13px; }
      #bb-tk-resize {
        position: absolute;
        top: 0; right: -3px; bottom: 0;
        width: 6px;
        cursor: ew-resize;
        z-index: 2;
      }
      #bb-tk-resize:hover { background: rgba(0,45,114,.25); }
      #bb-tk-minbar {
        position: fixed;
        top: 0; left: 0; bottom: 0;
        width: 52px;
        background: #002d72;
        color: #fff;
        z-index: 1900000;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 2px 0 12px rgba(0,0,0,.2);
      }
      #bb-tk-minbar:hover { background: #0040a0; }
      #bb-tk-minbar span {
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        font-weight: 700;
        font-size: 13px;
        letter-spacing: .04em;
      }
      #bb-tk-header {
        display: flex; align-items: center; gap: 6px;
        padding: 11px 12px;
        background: #002d72;
        color: #fff;
        user-select: none;
        flex: 0 0 auto;
      }
      #bb-tk-title { font-weight: 700; flex: 1; font-size: 15px; }
      #bb-tk-min {
        background: none; border: none; color: #fff;
        font-size: 18px; cursor: pointer; padding: 0 4px; line-height: 1;
      }
      #bb-tk-min:hover { opacity: .8; }
      #bb-tk-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      #bb-tk-tabs {
        display: flex; border-bottom: 1px solid #dee2e6;
        background: #f8f9fa;
      }
      .bb-tab {
        flex: 1; padding: 8px 6px; border: none;
        background: none; cursor: pointer; font-size: 14px;
        color: #6e7477; border-bottom: 2px solid transparent;
      }
      .bb-tab.active { color: #002d72; border-bottom-color: #002d72; font-weight: 700; }
      #bb-tk-panels { overflow-y: auto; flex: 1; }
      .bb-tabpanel { display: none; padding: 8px 10px; }
      .bb-tabpanel.active { display: block; }
      .bb-hint { font-size: 13px; color: #6e7477; margin: 0 0 6px; line-height: 1.5; }
      #bb-tk-footer {
        display: flex; gap: 12px; align-items: center;
        padding: 6px 10px; border-top: 1px solid #e9eef3; background: #f8fafc;
        border-radius: 0 0 8px 8px;
      }
      .bb-toggle {
        display: flex; align-items: center; gap: 4px;
        font-size: 11px; color: #41494f; cursor: pointer; user-select: none;
      }
      .bb-toggle input { margin: 0; cursor: pointer; }
      .bb-comp-row {
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 2px; border-bottom: 1px solid #f1f5fb;
      }
      /* rows whose containing .row holds more than this one component */
      .bb-comp-row-multi { background: #fff8e1; border-left: 3px solid #f0b400; padding-left: 5px; }
      .bb-multi-flag { color: #b8860b; font-weight: 700; cursor: help; }
      .bb-comp-label { flex: 1; font-size: 14px; }
      .bb-comp-actions { display: flex; gap: 4px; align-items: center; }
      .bb-btn.bb-move { font-weight: 700; }
      .bb-btn.bb-move:disabled { opacity: .3; cursor: default; }
      /* word count + tools + snapshots + snippet divider */
      .bb-wordcount { font-size: 12px; color: #4b5563; background: #f3f6fb; border-radius: 5px; padding: 5px 8px; margin: 0 0 8px; }
      .bb-tk-toolrow { display: flex; gap: 6px; margin: 0 0 10px; }
      .bb-tk-toolrow .bb-btn { flex: 1; text-align: center; }
      .bb-snap-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f1f5fb; font-size: 13px; }
      .bb-snip-divider { font-weight: 700; color: #002d72; margin: 14px 0 4px; padding-top: 10px; border-top: 1px solid #e5e9f0; }
      .bb-btn {
        padding: 3px 8px; border-radius: 4px; border: 1px solid;
        cursor: pointer; font-size: 11px; white-space: nowrap;
      }
      .bb-btn-plus  { background: #002d72; color: #fff; border-color: #002d72; }
      .bb-btn-fix   { background: #b3541e; color: #fff; border-color: #b3541e; font-size: 15px; font-weight: 600; padding: 10px 12px; }
      .bb-btn-goto  { background: #fff; color: #6e7477; border-color: #cdd5dc; }
      .bb-btn-img   { background: #6f42c1; color: #fff; border-color: #6f42c1; font-size: 11px; }
      .bb-audit-row {
        display: flex; align-items: flex-start; gap: 6px;
        padding: 4px 2px; border-bottom: 1px solid #f1f5fb;
        font-size: 12px;
      }
      .bb-audit-error .bb-audit-icon { color: #dc3545; font-weight: 700; }
      .bb-audit-warn  .bb-audit-icon { color: #fd7e14; font-weight: 700; }
      .bb-audit-msg { flex: 1; }
      .bb-badge {
        display: inline-block; border-radius: 10px; padding: 1px 6px;
        font-size: 11px; font-weight: 700; line-height: 1.4;
      }
      .bb-badge-error { background: #dc3545; color: #fff; }
      .bb-badge-warn  { background: #fd7e14; color: #fff; }

      /* Shared right-click context menus (columns, rows, wrap, gap insert) */
      #bb-col-menu, .bb-ctx-menu {
        position: fixed; z-index: 2000001;
        background: #fff; border: 1px solid #cdd5dc; border-radius: 6px;
        box-shadow: 0 4px 16px rgba(0,0,0,.18);
        padding: 4px; min-width: 230px; max-height: 70vh; overflow-y: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #bb-col-menu .bb-col-menu-title, .bb-ctx-menu .bb-ctx-title {
        font-size: 12px; color: #6e7477; padding: 5px 9px 7px; font-weight: 600;
      }
      #bb-col-menu button, .bb-ctx-menu button {
        display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
        background: none; border: none; border-radius: 4px;
        padding: 8px 10px; font-size: 14px; cursor: pointer; color: #1c2024;
      }
      #bb-col-menu button:hover, .bb-ctx-menu button:hover { background: #002d72; color: #fff; }

      /* Colour swatches in row / gap / wrap menus */
      .bb-swatch {
        display: inline-block; width: 14px; height: 14px; border-radius: 3px;
        border: 1px solid rgba(0,0,0,.2); flex: 0 0 auto;
      }
      .bb-swatch-none      { background: repeating-linear-gradient(45deg,#fff,#fff 3px,#eee 3px,#eee 6px); }
      .bb-swatch-primary   { background: var(--bs-primary, #002d72); }
      .bb-swatch-secondary { background: var(--bs-secondary, #6f42c1); }
      .bb-swatch-tertiary  { background: var(--bs-tertiary, #c9a227); }
      .bb-swatch-navy      { background: #002d72; }
      .bb-swatch-gold      { background: #c9a227; }
      .bb-swatch-green     { background: #198754; }
      .bb-swatch-forest    { background: #1b4332; }
      .bb-swatch-purple    { background: #6f42c1; }
      .bb-swatch-lavender  { background: #b9a7e0; }
      .bb-swatch-lightblue { background: #9ec5fe; }
      .bb-swatch-red       { background: #dc3545; }
      .bb-swatch-yellow    { background: #ffc107; }

      /* Table menu specifics */
      .bb-table-menu { min-width: 248px; }
      .bb-ctx-sub {
        font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
        color: #8a9196; padding: 8px 8px 3px; font-weight: 700;
      }
      .bb-swatch-grid {
        display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px;
        padding: 2px 8px 6px;
      }
      .bb-swatch-btn {
        width: 100%; aspect-ratio: 1; border: 1px solid rgba(0,0,0,.2);
        border-radius: 4px; cursor: pointer; padding: 0; font-size: 12px;
        color: #6e7477; background: #fff; line-height: 1;
      }
      .bb-swatch-btn:hover { outline: 2px solid #002d72; outline-offset: 1px; }
      .bb-swatch-clear {
        background: repeating-linear-gradient(45deg,#fff,#fff 3px,#eee 3px,#eee 6px);
      }
      .bb-hex-row {
        display: flex; align-items: center; gap: 6px; padding: 2px 8px 8px;
        font-size: 12px; color: #41494f;
      }
      .bb-hex-row .bb-hex {
        width: 34px; height: 24px; padding: 0; border: 1px solid #cdd5dc;
        border-radius: 4px; cursor: pointer; background: none;
      }
      .bb-hex-row .bb-hex-apply {
        flex: 1; padding: 5px 6px !important; font-size: 12px;
        border: 1px solid #cdd5dc !important; border-radius: 4px;
        background: #f8fafc !important; color: #1c2024 !important; cursor: pointer;
      }
      .bb-hex-row .bb-hex-apply:hover { background: #002d72 !important; color: #fff !important; }
      .bb-ctx-menu button.bb-danger:hover { background: #dc3545; color: #fff; }

      /* Fix-report modal */
      #bb-modal {
        position: fixed; inset: 0; z-index: 2100000;
        background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center;
        font-family: "Lato", sans-serif;
      }
      #bb-modal .bb-modal-card {
        background: #fff; border-radius: 10px; width: min(560px, 92vw);
        max-height: 80vh; overflow: hidden; display: flex; flex-direction: column;
        box-shadow: 0 10px 40px rgba(0,0,0,.3);
      }
      #bb-modal .bb-modal-head {
        background: #002d72; color: #fff; padding: 12px 16px; font-weight: 700; font-size: 16px;
        display: flex; align-items: center; justify-content: space-between;
      }
      #bb-modal .bb-modal-x { background: none; border: none; color: #fff; font-size: 22px; cursor: pointer; line-height: 1; }
      #bb-modal .bb-modal-body { padding: 16px; overflow-y: auto; font-size: 14px; line-height: 1.5; color: #1c2024; }
      #bb-modal .bb-modal-body ul { margin: 0; }
      #bb-modal .bb-modal-body li { margin-bottom: 3px; }

      /* Fix preview checklist */
      .bb-fix-sec-h { font-weight: 700; color: #198754; margin: 4px 0 6px; }
      .bb-fix-sec-review { color: #fd7e14; margin-top: 14px; }
      .bb-fix-cat { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 8px 0 2px; }
      .bb-fix-row { display: flex; align-items: flex-start; gap: 7px; padding: 3px 0; font-size: 13px; }
      .bb-fix-row input { margin-top: 2px; flex: 0 0 auto; }
      .bb-fix-review { color: #8a5a00; }
      .bb-fix-goto { margin-left: auto; border: 1px solid #d6c08a; background: #fff8e1; color: #8a5a00; border-radius: 4px; cursor: pointer; font-size: 12px; padding: 0 6px; }
      .bb-fix-goto:hover { background: #ffe9b3; }
      .bb-fix-actions { margin-top: 14px; display: flex; gap: 8px; }

      /* Alt-hint overlay (held-Alt reveal of actionable zones) */
      #bb-alt-overlay {
        position: fixed; inset: 0;
        pointer-events: none;            /* never blocks clicks/right-clicks */
        z-index: 1850000;                /* below menus (1.9M) but above page */
        font-family: "Lato", sans-serif;
      }
      #bb-alt-overlay .bb-alt-banner {
        position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
        background: rgba(0,45,114,.95); color: #fff;
        padding: 7px 14px; border-radius: 18px;
        font-size: 13px; font-weight: 600; white-space: nowrap;
        box-shadow: 0 3px 12px rgba(0,0,0,.3);
        max-width: 92vw; overflow: hidden; text-overflow: ellipsis;
      }
      #bb-alt-overlay .bb-alt-box {
        position: fixed;
        border-radius: 3px;
        box-sizing: border-box;
        transition: none;
      }
      #bb-alt-overlay .bb-alt-tag {
        position: fixed;
        color: #fff; font-size: 10px; font-weight: 700;
        padding: 1px 5px; border-radius: 3px 3px 3px 0;
        white-space: nowrap; line-height: 1.5;
        box-shadow: 0 1px 3px rgba(0,0,0,.3);
      }

      /* Leader-key armed hint (Alt+B then a key) */
      #bb-leader-hint {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        background: rgba(0,45,114,.96); color: #fff;
        padding: 8px 16px; border-radius: 20px;
        font-family: "Lato", sans-serif; font-size: 13px;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
        z-index: 2200000; display: none;
      }
      #bb-leader-hint b { color: #ffd34d; padding: 0 1px; }
      .bb-shortcut-hint {
        font-size: 11px; color: #8a9099; margin-top: 4px; width: 100%;
        border-top: 1px solid #eef0f2; padding-top: 5px;
      }
    `;
    document.head.appendChild(s);
  }

  function injectIconModalStyles() {
    if (document.getElementById('bb-icon-modal-styles')) return;

    // Bootstrap Icons font — needed because the main page CSS may not load it
    // in the Tampermonkey context
    if (!document.getElementById('bb-bi-font')) {
      const link = document.createElement('link');
      link.id = 'bb-bi-font';
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css';
      document.head.appendChild(link);
    }

    const s = document.createElement('style');
    s.id = 'bb-icon-modal-styles';
    s.textContent = `
      #bb-icon-modal {
        display: none;
        position: fixed; inset: 0;
        background: rgba(0,0,0,.5);
        z-index: 2000000;
        align-items: center; justify-content: center;
      }
      #bb-icon-modal-inner {
        background: #fff; border-radius: 8px;
        padding: 16px; width: 400px; max-height: 80vh;
        display: flex; flex-direction: column; gap: 10px;
        box-shadow: 0 8px 32px rgba(0,0,0,.25);
      }
      #bb-icon-modal-header {
        display: flex; justify-content: space-between; align-items: center;
      }
      #bb-icon-modal-close {
        background: none; border: none; font-size: 16px; cursor: pointer; color: #6e7477;
      }
      #bb-icon-search {
        width: 100%; padding: 6px 10px; border: 1px solid #cdd5dc;
        border-radius: 4px; font-size: 13px; box-sizing: border-box;
      }
      #bb-icon-grid {
        display: grid; grid-template-columns: repeat(8, 1fr);
        gap: 4px; overflow-y: auto; max-height: 320px;
      }
      .bb-icon-opt {
        background: #f8f9fa; border: 1px solid #dee2e6;
        border-radius: 4px; padding: 6px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 18px;
      }
      .bb-icon-opt:hover { background: #002d72; color: #fff; border-color: #002d72; }
      .bb-icon-opt:hover i { color: #fff; }
      .bb-icon-opt i { color: #002d72; font-size: 18px; }
      #bb-icon-modal-actions { display: flex; gap: 8px; }
    `;
    document.head.appendChild(s);
  }

  // ─── SOURCE CODE HELPER ────────────────────────────────────────────────────
  // Clicks the Source Code button in the D2L toolbar, then after the CodeMirror
  // dialog opens it adds a comment marker near the target component so the user
  // knows where to paste.

  function findSourceCodeButton() {
    // The button lives in the main page toolbar (not in the iframe)
    return document.querySelector('button[aria-label="Source Code"]');
  }

  function openSourceAndScroll(componentEl, newItemHtml) {
    // Step 1 — click the Source Code button to open the dialog
    const btn = findSourceCodeButton();
    if (!btn) {
      toast('Source Code button not found — paste manually in HTML view', 'warn');
      return;
    }
    btn.click();

    // Step 2 — wait for the CodeMirror editor to appear inside a shadow root
    // The dialog host is d2l-htmleditor-source-code-editor or similar
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (attempts > 40) { clearInterval(poll); return; }

      const cmContent = findCMContent();
      if (!cmContent) return;
      clearInterval(poll);

      // Step 3 — find the component's outer HTML inside the CodeMirror text
      // by searching for a distinctive attribute (the component's id or class)
      const compId = componentEl.id;
      const compClass = [...componentEl.classList]
        .find(c => ['accordion','horizontal-tabs','vertical-tabs-wrapper','flip-cards',
                     'text-carousel','image-carousel','reveal-table','icon-list'].includes(c));

      const searchStr = compId ? `id="${compId}"` : (compClass ? `class="${compClass}"` : null);
      if (!searchStr) {
        toast('HTML copied — locate the component in Source Code and paste', 'warn');
        return;
      }

      // Insert a comment marker after the closing tag of the last child
      // by finding the text in the editor and scrolling to it
      scrollCMToString(cmContent, searchStr);
      toast('✓ Scrolled to component in Source Code — paste at end of component', 'success');

    }, 250);
  }

  function findCMContent() {
    // CodeMirror lives inside a shadow root on a dialog element
    // Walk all shadow roots to find .cm-content
    const candidates = document.querySelectorAll('*');
    for (const el of candidates) {
      if (el.shadowRoot) {
        const cm = el.shadowRoot.querySelector('.cm-content[contenteditable]');
        if (cm) return cm;
        // one more level deep
        for (const child of el.shadowRoot.querySelectorAll('*')) {
          if (child.shadowRoot) {
            const cm2 = child.shadowRoot.querySelector('.cm-content[contenteditable]');
            if (cm2) return cm2;
          }
        }
      }
    }
    return null;
  }

  function scrollCMToString(cmContent, searchStr) {
    // CodeMirror renders only visible lines; we can't simply scan DOM text.
    // Instead, use the CodeMirror instance's search functionality via the
    // view's dispatch if available, or fall back to a keyboard Ctrl+F hint.
    try {
      // Try to get the CM view from the DOM element
      const view = cmContent._cmView || cmContent.cmView;
      if (view && view.dispatch) {
        // CodeMirror 6: dispatch a selectAll then let the user Ctrl+F
      }
    } catch {}
    // Reliable fallback: focus the editor and show a hint
    cmContent.focus();
    toast(`Search for: ${searchStr.slice(0,40)} — then paste before the closing tag`, 'warn');
  }

  // ─── OUTLINE (heading promote/demote — moved here from the old Audit
  // Toolkit edit-mode branch; this is a pure editing action, so it always
  // belonged here rather than in a view-mode-only script) ────────────────
  function openOutlinePanel() {
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not found', 'error'); return; }
    const body = ed.getBody();
    const headings = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const model = headings.map(h => ({ el: h, orig: parseInt(h.tagName[1], 10), level: parseInt(h.tagName[1], 10), text: h.textContent.trim() }));
    const clamp = n => Math.max(1, Math.min(6, n));

    function issuesFor(levels) {
      const out = [];
      for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) out.push({ idx: i, msg: `Skips from h${levels[i - 1]} to h${levels[i]}` });
      return out;
    }

    showModal('Heading outline', `<div id="bb-outline-status" style="font-size:12px;color:#666;margin-bottom:8px;"></div><div id="bb-outline-list"></div>
      <div class="bb-fix-actions"><button id="bb-outline-apply" class="bb-btn bb-btn-img">Apply changes</button> <button id="bb-outline-reset" class="bb-btn bb-btn-goto">Reset</button> <button id="bb-outline-close" class="bb-btn bb-btn-goto">Close</button></div>`);
    const modal = document.getElementById('bb-modal');
    if (!modal) return;
    const listEl = modal.querySelector('#bb-outline-list');
    const statusEl = modal.querySelector('#bb-outline-status');

    function render() {
      const levels = model.map(m => m.level);
      const issues = issuesFor(levels);
      const issueByIdx = {}; issues.forEach(is => { issueByIdx[is.idx] = is; });
      listEl.innerHTML = '';
      model.forEach((m, idx) => {
        const row = document.createElement('div');
        row.className = 'bb-fix-row';
        row.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const indent = (m.level - 1) * 14;
        const changed = m.level !== m.orig;
        const issue = issueByIdx[idx];
        row.innerHTML = `
          <button class="bb-btn bb-btn-goto" data-up style="padding:2px 7px;">⬆</button>
          <button class="bb-btn bb-btn-goto" data-down style="padding:2px 7px;">⬇</button>
          <span style="flex:1;margin-left:${indent}px;">
            <b style="color:${changed ? '#198754' : '#333'}">h${m.level}</b> ${escapeHtml(m.text || '(empty heading)')}
            ${changed ? `<span style="color:#888;font-size:11px;"> (was h${m.orig})</span>` : ''}
            ${issue ? `<div style="color:#b46a00;font-size:11px;">⚠️ ${escapeHtml(issue.msg)}</div>` : ''}
          </span>
          <button class="bb-btn bb-btn-goto" data-goto style="padding:2px 7px;">↗</button>`;
        listEl.appendChild(row);
        row.querySelector('[data-up]').addEventListener('click', () => { m.level = clamp(m.level - 1); render(); });
        row.querySelector('[data-down]').addEventListener('click', () => { m.level = clamp(m.level + 1); render(); });
        row.querySelector('[data-goto]').addEventListener('click', () => { try { m.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {} });
      });
      const changedCount = model.filter(m => m.level !== m.orig).length;
      statusEl.textContent = issues.length ? `${issues.length} level warning(s) · ${changedCount} pending change(s)` : `No level warnings · ${changedCount} pending change(s)`;
    }

    modal.querySelector('#bb-outline-reset').addEventListener('click', () => { model.forEach(m => { m.level = m.orig; }); render(); });
    modal.querySelector('#bb-outline-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#bb-outline-apply').addEventListener('click', () => {
      const toChange = model.filter(m => m.level !== m.orig);
      if (!toChange.length) { toast('No changes to apply', 'warn'); modal.remove(); return; }
      const didWrite = tinyWrite(() => {
        toChange.forEach(m => {
          const repl = tinyDoc.createElement('h' + m.level);
          for (const a of Array.from(m.el.attributes)) repl.setAttribute(a.name, a.value);
          while (m.el.firstChild) repl.appendChild(m.el.firstChild);
          m.el.replaceWith(repl);
          m.el = repl; m.orig = m.level;
        });
      }, 'outline reorder', { ungated: true });
      modal.remove();
      if (didWrite) { toast(`✓ Updated ${toChange.length} heading${toChange.length > 1 ? 's' : ''}`, 'success'); scheduleAudit(); refreshComponentList(); }
      else toast('Editor API unavailable — could not apply', 'error');
    });

    render();
  }

  // ─── FIND & REPLACE (moved here from the old Audit Toolkit edit-mode
  // branch — this is a write action, so it belongs here, not in a
  // view-mode-only script. Undo goes through the existing Snapshots
  // mechanism rather than a second, bespoke undo stack.) ─────────────────
  function openFindReplacePanel() {
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not found', 'error'); return; }

    showModal('Find & replace', `
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">
        <input type="text" id="bb-fr-find" placeholder="Find…" class="bb-fr-input">
        <input type="text" id="bb-fr-replace" placeholder="Replace with…" class="bb-fr-input">
        <label style="font-size:12px;"><input type="checkbox" id="bb-fr-case"> Match case</label>
      </div>
      <button id="bb-fr-search" class="bb-btn bb-btn-goto">Search</button>
      <div id="bb-fr-results" style="margin-top:8px;"></div>
      <div class="bb-fix-actions"><button id="bb-fr-apply" class="bb-btn bb-btn-img" disabled>Replace ticked</button> <button id="bb-fr-close" class="bb-btn bb-btn-goto">Close</button></div>
    `);
    const modal = document.getElementById('bb-modal');
    if (!modal) return;
    const findEl = modal.querySelector('#bb-fr-find');
    const replEl = modal.querySelector('#bb-fr-replace');
    const caseEl = modal.querySelector('#bb-fr-case');
    const resultsEl = modal.querySelector('#bb-fr-results');
    const applyBtn = modal.querySelector('#bb-fr-apply');
    let matches = [];

    function search() {
      const term = findEl.value;
      matches = [];
      resultsEl.innerHTML = '';
      applyBtn.disabled = true;
      if (!term) return;
      const body = ed.getBody();
      const walker = tinyDoc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node;
      const flags = caseEl.checked ? 'g' : 'gi';
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc, flags);
      while ((node = walker.nextNode())) {
        if (re.test(node.nodeValue)) matches.push(node);
      }
      resultsEl.innerHTML = matches.length
        ? `${matches.length} match(es) found across the editor.`
        : '<span style="color:#888;">No matches.</span>';
      applyBtn.disabled = !matches.length;
    }

    modal.querySelector('#bb-fr-search').addEventListener('click', search);
    modal.querySelector('#bb-fr-close').addEventListener('click', () => modal.remove());
    applyBtn.addEventListener('click', () => {
      const term = findEl.value, repl = replEl.value;
      if (!term || !matches.length) return;
      takeSnapshot('pre-replace');
      const flags = caseEl.checked ? 'g' : 'gi';
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc, flags);
      const didWrite = tinyWrite(() => {
        matches.forEach(n => { if (n.parentNode) n.nodeValue = n.nodeValue.replace(re, repl); });
      }, 'find and replace', { ungated: true });
      modal.remove();
      if (didWrite) { toast(`✓ Replaced in ${matches.length} location(s) — snapshot saved, use Snapshots to undo`, 'success'); scheduleAudit(); refreshComponentList(); }
      else toast('Editor API unavailable — could not apply', 'error');
    });
  }

  // ─── CITATIONS: DOI / PMID linking (moved here from the old Audit
  // Toolkit edit-mode branch — detection and Crossref/NCBI lookup come
  // from the shared core; only the actual link insertion, a write, lives
  // here) ──────────────────────────────────────────────────────────────
  function linkifyDoiInEl(el, doi) {
    const walk = tinyDoc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const toReplace = [];
    let node;
    while ((node = walk.nextNode())) { if (node.nodeValue.includes(doi)) toReplace.push(node); }
    toReplace.forEach(tn => {
      const idx = tn.nodeValue.indexOf(doi);
      const before = tn.nodeValue.slice(0, idx), after = tn.nodeValue.slice(idx + doi.length);
      const frag = tinyDoc.createDocumentFragment();
      if (before) frag.appendChild(tinyDoc.createTextNode(before));
      const a = tinyDoc.createElement('a');
      a.setAttribute('href', 'https://doi.org/' + doi);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = doi;
      frag.appendChild(a);
      if (after) frag.appendChild(tinyDoc.createTextNode(after));
      tn.parentNode.replaceChild(frag, tn);
    });
  }
  function linkifyPmidInEl(el, pmid) {
    const re = new RegExp(`(PMID[:\\s]*${pmid})`, 'i');
    const walk = tinyDoc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const toReplace = [];
    let node;
    while ((node = walk.nextNode())) { if (re.test(node.nodeValue)) toReplace.push(node); }
    toReplace.forEach(tn => {
      const parts = tn.nodeValue.split(re);
      const frag = tinyDoc.createDocumentFragment();
      parts.forEach(part => {
        if (re.test(part)) {
          const a = tinyDoc.createElement('a');
          a.setAttribute('href', `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.textContent = part;
          frag.appendChild(a);
        } else if (part) frag.appendChild(tinyDoc.createTextNode(part));
      });
      tn.parentNode.replaceChild(frag, tn);
    });
  }

  function openCitationsPanel() {
    if (!S) { toast('Shared core not loaded — cannot run citation checks', 'error'); return; }
    const ed = getTinyEditor();
    if (!ed) { toast('Editor not found', 'error'); return; }
    const body = ed.getBody();

    showModal('Link DOI / PMID citations', `<div id="bb-cite-list">Scanning…</div>`);
    const modal = document.getElementById('bb-modal');
    if (!modal) return;
    const listEl = modal.querySelector('#bb-cite-list');

    const refs = S.collectReferenceEls(body);
    listEl.innerHTML = '';
    if (!refs.length) { listEl.innerHTML = '<span style="color:#888;">No reference-list entries detected.</span>'; return; }

    // Skip anything already fully identified by any citation id — nothing
    // to do here, matches the same rule in the Audit Toolkit's report.
    const pending = refs.filter(el => !(S.hasDoi(el) || S.hasPmidLink(el) || S.hasPmcidLink(el)));
    if (!pending.length) { listEl.innerHTML = '<span style="color:#888;">All references already have a linked DOI, PMID, or PMCID.</span>'; return; }

    pending.forEach(el => {
      const rawDoi = S.extractRawDoi(el);
      const pmids = S.collectPmids(el);
      const text = (el.textContent || '').trim().slice(0, 90);

      const row = document.createElement('div');
      row.className = 'bb-fix-row';
      row.innerHTML = `<div style="flex:1;">${escapeHtml(text)}…<div class="bb-cite-status" style="font-size:11px;color:#888;">checking…</div></div>`;
      listEl.appendChild(row);
      const statusEl = row.querySelector('.bb-cite-status');

      if (rawDoi) {
        statusEl.innerHTML = `Raw DOI "${escapeHtml(rawDoi)}" found — `;
        const btn = document.createElement('button');
        btn.className = 'bb-btn bb-btn-plus'; btn.style.cssText = 'padding:2px 8px;font-size:11px;'; btn.textContent = 'Link it';
        btn.addEventListener('click', () => {
          const didWrite = tinyWrite(() => linkifyDoiInEl(el, rawDoi), 'link raw doi', { ungated: true });
          if (didWrite) { toast('✓ DOI linked', 'success'); statusEl.textContent = 'Linked.'; btn.remove(); }
        });
        statusEl.appendChild(btn);
      } else {
        const q = S.refQueryText(el);
        S.crossrefQueryCached(q).then(items => {
          if (!items || !items.length) { statusEl.textContent = 'No Crossref match found.'; return; }
          const best = items[0];
          const yearMismatch = S.extractYear(text) && S.extractYear(text) !== (best.published && best.published['date-parts'] && best.published['date-parts'][0] && best.published['date-parts'][0][0]);
          const band = S.scoreBand(best.score || 0, yearMismatch);
          statusEl.innerHTML = `${escapeHtml(band.label)}: ${escapeHtml(S.fmtCrossref(best))} — `;
          const btn = document.createElement('button');
          btn.style.cssText = 'padding:2px 8px;font-size:11px;';
          if (band.cls === 'doi-low') {
            // Low confidence — don't offer a one-click insert; make the
            // author look at the actual Crossref record before deciding.
            btn.className = 'bb-btn bb-btn-goto';
            btn.textContent = 'Open to verify';
            btn.addEventListener('click', () => window.open(`https://doi.org/${best.DOI || ''}`, '_blank'));
          } else {
            btn.className = 'bb-btn bb-btn-plus';
            btn.textContent = 'Insert & link DOI';
            btn.addEventListener('click', () => {
              const doi = best.DOI;
              if (!doi) return;
              const didWrite = tinyWrite(() => {
                const space = tinyDoc.createTextNode(' ');
                const a = tinyDoc.createElement('a');
                a.setAttribute('href', 'https://doi.org/' + doi);
                a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
                a.textContent = doi;
                el.appendChild(space); el.appendChild(a);
              }, 'insert doi link', { ungated: true });
              if (didWrite) { toast('✓ DOI inserted and linked', 'success'); statusEl.textContent = 'Linked.'; btn.remove(); }
            });
          }
          statusEl.appendChild(btn);
        });
      }

      if (pmids.length) {
        const pmidBtn = document.createElement('button');
        pmidBtn.className = 'bb-btn bb-btn-plus'; pmidBtn.style.cssText = 'padding:2px 8px;font-size:11px;margin-left:6px;'; pmidBtn.textContent = `Link PMID ${pmids[0]}`;
        pmidBtn.addEventListener('click', () => {
          const didWrite = tinyWrite(() => linkifyPmidInEl(el, pmids[0]), 'link pmid', { ungated: true });
          if (didWrite) { toast('✓ PMID linked', 'success'); pmidBtn.remove(); }
        });
        row.appendChild(pmidBtn);
      }
    });
  }

  // ─── AUDIT TOOLKIT HANDOFF (read-only) ────────────────────────────────
  // The Audit Toolkit (view mode) writes a per-topic issue summary to
  // localStorage after each scan. Show it here as a banner so the author
  // knows Audit found something, without any direct call between scripts.
  function checkAuditHandoff() {
    const banner = document.getElementById('bb-tk-audit-banner');
    if (!banner || !S) return;
    const viewUrl = S.editUrlToViewUrl(location.pathname);
    const tid = viewUrl ? S.topicKeyFromViewUrl(viewUrl) : null;
    if (!tid) return;
    let data;
    try { data = JSON.parse(localStorage.getItem('rcpi-audit:' + tid) || 'null'); } catch { data = null; }
    if (!data) return;
    const ageMin = Math.round((Date.now() - data.scannedAt) / 60000);
    const total = (data.a11yErrors || 0) + (data.linksBroken || 0);
    if (!total) return;
    banner.style.display = 'block';
    banner.style.cssText = 'display:block;background:#fff3cd;border:1px solid #ffe08a;border-radius:4px;padding:6px 8px;font-size:11px;margin:0 0 8px;color:#664d03;';
    banner.innerHTML = `⚠️ Audit found ${total} issue(s) ~${ageMin < 1 ? '<1' : ageMin} min ago — <a href="#" id="bb-audit-banner-fix" style="color:#664d03;text-decoration:underline;">Check &amp; fix</a>`;
    const link = document.getElementById('bb-audit-banner-fix');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); runFixPage(); });
  }

  // ─── FOLDED IN: NEW PAGE UNIQUE NAMES ──────────────────────────────────
  // Originally the standalone "New Page Unique Names" userscript. On a
  // brand-new (unsaved) page, slugifies the filename with a date+uid on
  // first save (intercepting the PATCH to content.api.brightspace.com),
  // then restores the visible title the author typed, fighting D2L's own
  // re-reads for a couple of seconds. Ported verbatim aside from removing
  // its own IIFE wrapper — every helper here is local to this function, so
  // nothing here can collide with the block-builder code elsewhere in this
  // file even though some names (uid, escapeHtml, etc.) are reused.
  function initNewPageUniqueNames() {
    // ---- config -------------------------------------------------------
    const DATE_POSITION = 'after';   // 'after' → my-page-20260612-a3x9
                                      // 'before' → 20260612-a3x9-my-page
    const SEPARATOR     = '-';
    const SLUGIFY       = true;
    const UID_LENGTH    = 4;         // appended after date, e.g. -k7m2
    // -------------------------------------------------------------------

    function isNewPage() {
      const editor = document.querySelector('d2l-activity-content-editor');
      if (editor) return editor.hasAttribute('isnew');
      return /\/topic\/-1(\?|$)/.test(window.location.href);
    }

    if (!isNewPage()) return;

    let transformDone = false;
    let originalTitle = null;
    let pendingAction = null;
    let restoreActive = false;

    // ---- helpers ------------------------------------------------------

    function today() {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    }

    function uid() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      const arr = new Uint8Array(UID_LENGTH);
      crypto.getRandomValues(arr);
      for (const byte of arr) result += chars[byte % chars.length];
      return result;
    }

    function slugify(s) {
      s = s.trim();
      if (SLUGIFY) {
        s = s.toLowerCase()
          .replace(/[^a-z0-9]+/g, SEPARATOR)
          .replace(new RegExp(`\\${SEPARATOR}{2,}`, 'g'), SEPARATOR)
          .replace(new RegExp(`^\\${SEPARATOR}|\\${SEPARATOR}$`, 'g'), '');
      }
      return s;
    }

    function alreadyDated(s) {
      // matches slug-YYYYMMDD or slug-YYYYMMDD-uid at end
      return DATE_POSITION === 'after'
        ? /\d{8}(-[a-z0-9]+)?$/.test(s)
        : /^\d{8}(-[a-z0-9]+)?/.test(s);
    }

    function buildSlug(title) {
      if (!title || alreadyDated(title)) return null;
      const base = slugify(title);
      if (!base) return null;
      const stamp = `${today()}${SEPARATOR}${uid()}`;
      return DATE_POSITION === 'before'
        ? `${stamp}${SEPARATOR}${base}`
        : `${base}${SEPARATOR}${stamp}`;
    }

    // ---- DOM helpers --------------------------------------------------

    function deepQuerySelector(root, selector) {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const r = deepQuerySelector(el.shadowRoot, selector);
          if (r) return r;
        }
      }
      return null;
    }

    function getTitleField() {
      const host = deepQuerySelector(document, 'd2l-input-text#content-title');
      if (!host) return null;
      const labelAttr = (host.getAttribute('label') || '').toLowerCase();
      if (!labelAttr.startsWith('page title')) return null;
      const input = host.shadowRoot?.querySelector('input');
      if (!input) return null;
      return { host, input };
    }

    function forceValue(host, input, val) {
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      nativeSet.call(input, val);
      input.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      const vp = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(host), 'value');
      if (vp?.set) vp.set.call(host, val);
      else host.value = val;
    }

    function findButton(labelText) {
      const buttonsHost = deepQuerySelector(document, 'd2l-activity-editor-buttons');
      if (!buttonsHost) return null;
      const buttons = buttonsHost.shadowRoot?.querySelectorAll('d2l-button');
      if (!buttons) return null;
      for (const btn of buttons) {
        if (btn.textContent?.trim().toLowerCase() === labelText.toLowerCase()) return btn;
      }
      return null;
    }

    // ---- visible flash on the input ----------------------------------
    // Pulses the field border+background so the restore is obvious.
    // Green = working correctly. If you ever see it stay orange/red
    // after the flash, something went wrong.

    function flashField(input, success = true) {
      const colour = success ? '#d4edda' : '#ffeeba'; // green-ish or amber
      const border  = success ? '#28a745' : '#ffc107';
      const original = {
        bg:     input.style.backgroundColor,
        border: input.style.borderColor,
        trans:  input.style.transition,
      };
      input.style.transition       = 'background-color 0.15s, border-color 0.15s';
      input.style.backgroundColor  = colour;
      input.style.borderColor      = border;

      setTimeout(() => {
        input.style.transition       = 'background-color 0.6s, border-color 0.6s';
        input.style.backgroundColor  = original.bg;
        input.style.borderColor      = original.border;
        setTimeout(() => {
          input.style.transition = original.trans;
        }, 650);
      }, 600);
    }

    // ---- restore: fight D2L re-reads for up to 2.5s -----------------

    function startRestore() {
      if (!originalTitle) { completeAction(); return; }
      restoreActive = true;

      const tf = getTitleField();
      if (!tf) { restoreActive = false; completeAction(); return; }

      const { host, input } = tf;

      forceValue(host, input, originalTitle);
      flashField(input, true);

      const pollInterval = setInterval(() => {
        if (!restoreActive) { clearInterval(pollInterval); return; }
        if (input.value !== originalTitle) {
          forceValue(host, input, originalTitle);
          flashField(input, true); // flash again each time D2L stomps it
        }
      }, 80);

      const observer = new MutationObserver(() => {
        if (!restoreActive) return;
        if (input.value !== originalTitle) {
          forceValue(host, input, originalTitle);
        }
      });

      observer.observe(input, {
        attributes: true,
        attributeFilter: ['value'],
        characterData: true,
        childList: true,
      });

      setTimeout(() => {
        restoreActive = false;
        clearInterval(pollInterval);
        observer.disconnect();
        const tf2 = getTitleField();
        if (tf2) {
          forceValue(tf2.host, tf2.input, originalTitle);
          flashField(tf2.input, true); // final confirmation flash
        }
        completeAction();
      }, 2500);
    }

    function completeAction() {
      if (pendingAction === 'save-and-close') {
        const btn = findButton('save and close');
        if (btn) btn.click();
      }
    }

    // ---- intercept Save and Save and Close ---------------------------

    document.addEventListener('click', function (e) {
      if (transformDone) return;
      const path = e.composedPath();
      for (const el of path) {
        if (el.tagName?.toLowerCase() === 'd2l-button') {
          const text = el.textContent?.trim().toLowerCase();
          if (text === 'save and close') {
            e.preventDefault();
            e.stopImmediatePropagation();
            pendingAction = 'save-and-close';
            const saveBtn = findButton('save');
            if (saveBtn) saveBtn.click();
            return;
          }
          if (text === 'save') {
            pendingAction = 'save';
            return;
          }
        }
      }
    }, true);

    // ---- fetch intercept ---------------------------------------------

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      try {
        const req    = args[0];
        const isReq  = req instanceof Request;
        const url    = isReq ? req.url    : String(req);
        const method = isReq ? req.method : (args[1]?.method ?? 'GET');

        if (
          !transformDone &&
          url.includes('content.api.brightspace.com') &&
          url.includes('/files/') &&
          !url.includes('/commit') &&
          method.toUpperCase() === 'PATCH'
        ) {
          const bodyText = isReq ? await req.clone().text() : args[1]?.body;
          if (bodyText && bodyText.includes('name="title"')) {
            const titleMatch = bodyText.match(/(name="title"\r?\n\r?\n)([^\r\n-][^\r\n]*)/);
            if (titleMatch) {
              const currentTitle = titleMatch[2].trim();
              const newTitle     = buildSlug(currentTitle);

              if (newTitle && newTitle !== currentTitle) {
                originalTitle = currentTitle;
                const newBody = bodyText.replace(
                  /(name="title"\r?\n\r?\n)[^\r\n-][^\r\n]*/,
                  '$1' + newTitle
                );
                if (isReq) {
                  const headers = {};
                  req.headers.forEach((v, k) => headers[k] = v);
                  args[0] = new Request(url, {
                    method:      req.method,
                    headers:     headers,
                    body:        newBody,
                    credentials: req.credentials,
                    mode:        req.mode,
                  });
                } else {
                  args[1] = { ...args[1], body: newBody };
                }

                transformDone = true;

                return originalFetch.apply(this, args).then(response => {
                  if (response.ok) {
                    setTimeout(() => startRestore(), 800);
                  } else {
                    // Save failed — flash amber so it's obvious
                    const tf = getTitleField();
                    if (tf) flashField(tf.input, false);
                  }
                  return response;
                });

              } else {
                transformDone = true;
              }
            }
          }
        }
      } catch (_) {
        // pass through unchanged
      }

      return originalFetch.apply(this, args);
    };

    // ---- clear "Untitled" default on load ----------------------------

    function clearDefaultTitle() {
      const tf = getTitleField();
      if (!tf) return false;
      const { host, input } = tf;
      if (input.dataset.datedCleared) return true;
      input.dataset.datedCleared = '1';
      const current = input.value.trim();
      if (current && current.toLowerCase() !== 'untitled' && !alreadyDated(current)) return true;
      forceValue(host, input, '');
      return true;
    }

    let tries = 0;
    const wait = setInterval(() => {
      if (clearDefaultTitle() || ++tries > 40) clearInterval(wait);
    }, 300);
  }

  // ─── FOLDED IN: EDIT PAGE FILENAME & MANAGE FILES ──────────────────────
  // Originally the standalone "Edit Page Filename & Manage Files" userscript.
  // On existing pages, reads the topic id from the URL, GETs the documented
  // content-topic endpoint, and shows the real backend filename next to the
  // title field, with "Manage Files" and "Public Files" buttons. Ported
  // verbatim aside from removing its own IIFE wrapper.
  function initFilenameDisplayAndManageFiles() {
    // ============================================================
    // CONFIG  — if D2L changes something, this is the only place to edit
    // ============================================================
    const CFG = {
      // documented LE API. 'unstable' matches what this instance's UI uses;
      // pin to a number (e.g. '1.74') if you ever want it fixed.
      leVersion: 'unstable',
      versionsEndpoint: '/d2l/api/le/versions/',
      topicEndpoint: (ou, ver, topicId) =>
        `/d2l/api/le/${ver}/${ou}/content/topics/${topicId}`,

      titleHostSelector: 'd2l-input-text#content-title',
      titleLabelPrefix: 'page title',           // guards against grabbing the wrong input
      editorSelector: 'd2l-activity-content-editor',

      idResolveTimeoutMs: 6000,                  // fail loud after this if no id found
      genericNames: [
        'untitled', 'summary', 'overview', 'introduction', 'intro',
        'page', 'content', 'new-page', 'topic', 'lesson', 'module',
      ],
    };

    // Shared with the companion "Manage Files Locator" (now runManageFilesLocator()
    // in this same file). Must match there.
    const HANDOFF_KEY = 'd2l-mf-target';

    // ============================================================
    // STATE
    // ============================================================
    let state = null;
    function freshState() {
      return {
        ou: null,
        topicId: null,
        filename: null,
        path: null,         // full enforced path incl. folders, handed to Manage Files
        fetchedFor: null,   // topicId we already looked up (dedupe)
      };
    }
    // ============================================================
    // GUARD — skip new-page contexts where no topic file exists yet
    // ============================================================
    function isNewPageContext() {
      // 1) URL flag — D2L sets this when creating a brand-new topic
      if (/[?&]isNew=true/i.test(location.search)) return true;

      // 2) "New Page" heading — present when the editor opens for a
      //    not-yet-saved HTML page. We avoid fragile IDs/classes and
      //    instead walk the shadow DOM to find the <h1> inside the
      //    navigation component, then test its text content.
      const navHost = deepQuerySelector(document, 'd2l-labs-navigation-immersive');
      if (navHost) {
        // The h1 may be in light DOM children or inside a shadow slot
        const h1 = navHost.querySelector('h1')
          ?? (navHost.shadowRoot && navHost.shadowRoot.querySelector('h1'));
        if (h1 && h1.textContent.trim() === 'New Page') return true;
      }
      return false;
    }
    // ============================================================
    // URL / ID RESOLUTION
    // ============================================================
    function getOu() {
      const m = location.href.match(/[?&]ou=(\d+)/);
      if (m) return m[1];
      const m2 = location.pathname.match(/\/lessons\/(\d+)\//);
      if (m2) return m2[1];
      const m3 = location.pathname.match(/\/(\d+)\//);
      return m3 ? m3[1] : null;
    }

    // topic id from the URL. Two shapes, both reliable:
    //   content view: /lessons/{ou}/topics/{id}
    //   edit view:    /lessons/{ou}/edit/{activityId}/loadActivity/file/{topicId}
    // The trailing file/{id} IS the topic id (confirmed: /topics/57361 == file/57361).
    function topicIdFromLocation() {
      const edit = location.pathname.match(/\/loadActivity\/file\/(\d+)/);
      if (edit) return edit[1];
      const view = location.pathname.match(/\/topics?\/(\d+)(?:$|\/|\?)/);
      return view ? view[1] : null;
    }

    function isEditableContext() {
      if (document.querySelector(CFG.editorSelector)) return true;
      return /\/(topics?|edit)\//.test(location.pathname);
    }

    // ============================================================
    // We keep a private, un-wrappable reference to the real fetch so our
    // own GET can't be intercepted or broken by the SPA reassigning fetch.
    // ============================================================
    const _fetch = window.fetch.bind(window);

    // ============================================================
    // AUTHORITATIVE LOOKUP: documented GET → Url → filename
    // ============================================================
    let cachedVersion = null;
    async function resolveVersion() {
      if (cachedVersion) return cachedVersion;
      if (CFG.leVersion && CFG.leVersion !== 'auto') { cachedVersion = CFG.leVersion; return cachedVersion; }
      try {
        const r = await _fetch(CFG.versionsEndpoint, { credentials: 'include' });
        const arr = await r.json();
        const le = Array.isArray(arr) ? arr.find(x => x.ProductCode === 'LE') || arr[0] : null;
        cachedVersion = (le && le.LatestVersion) || 'unstable';
      } catch (_) {
        cachedVersion = 'unstable';
      }
      return cachedVersion;
    }

    function parseTopic(data) {
      if (!data || typeof data !== 'object') return null;
      // 1) classic ContentObject — the clean, plaintext path
      if (typeof data.Url === 'string' && /\.(html?|htm)(\?|$)/i.test(data.Url)) {
        return fromPath(data.Url);
      }
      // 2) content-service shape — name is plaintext; path is a bonus only
      if (data.properties && data.properties.name) {
        return { filename: data.properties.name, path: data.properties.name };
      }
      // 3) last resort: scan for any .html path
      const hit = scanForHtml(data);
      return hit ? fromPath(hit) : null;
    }

    function fromPath(rawPath) {
      const clean = String(rawPath).split('?')[0];
      let last = clean.split('/').filter(Boolean).pop() || clean;
      try { last = decodeURIComponent(last); } catch (_) { /* keep raw */ }
      return { filename: last, path: clean };
    }

    function scanForHtml(obj, depth = 0) {
      if (depth > 6 || !obj || typeof obj !== 'object') return null;
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && /\.(html?|htm)(\?|$)/i.test(v)) return v;
        if (v && typeof v === 'object') {
          const r = scanForHtml(v, depth + 1);
          if (r) return r;
        }
      }
      return null;
    }

    async function runDetection() {
      if (!state || !state.ou || !state.topicId) return;
      if (state.fetchedFor === state.topicId) return;   // already done/in-flight
      state.fetchedFor = state.topicId;

      try {
        const ver = await resolveVersion();
        const url = CFG.topicEndpoint(state.ou, ver, state.topicId);
        const res = await _fetch(url, {
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        if (!res.ok) { showError(`lookup failed (HTTP ${res.status})`); return; }
        const parsed = parseTopic(await res.json());
        if (parsed) {
          state.filename = parsed.filename;
          state.path = parsed.path;
          injectLabel();
        } else {
          showError('filename not in response');
        }
      } catch (e) {
        showError('lookup error');
      }
    }

    // ============================================================
    // DOM — label injection
    // ============================================================
    function deepQuerySelector(root, selector) {
      const found = root.querySelector(selector);
      if (found) return found;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const r = deepQuerySelector(el.shadowRoot, selector);
          if (r) return r;
        }
      }
      return null;
    }

    // Same traversal, but collect every match across open shadow roots.
    function deepQuerySelectorAll(root, selector, acc = []) {
      for (const el of root.querySelectorAll(selector)) acc.push(el);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) deepQuerySelectorAll(el.shadowRoot, selector, acc);
      }
      return acc;
    }

    function labelMatches(el) {
      return (el.getAttribute('label') || '').toLowerCase().startsWith(CFG.titleLabelPrefix);
    }

    // Defense-in-depth: id and label are robust against DIFFERENT failures, so we
    // try them in confidence order rather than requiring both.
    //   1) id + label agree            → original strict match, most confident
    //   2) label-only (any input)      → survives the #content-title id being renamed
    //   3) id-only                     → survives the label changing / a non-English instance
    function getTitleHost() {
      const tag = CFG.titleHostSelector.split('#')[0];   // 'd2l-input-text'
      const byId = deepQuerySelector(document, CFG.titleHostSelector);

      if (byId && labelMatches(byId)) return byId;                 // 1
      const byLabel = deepQuerySelectorAll(document, tag).find(labelMatches);
      if (byLabel) return byLabel;                                 // 2
      return byId || null;                                         // 3
    }

    function isGeneric(name) {
      return CFG.genericNames.some(w => name.toLowerCase().includes(w));
    }
    function isDateSlug(name) { return /\d{8}/.test(name); }

    function stripPrefix(p, fallback) {
      const s = String(p || fallback || '')
        .split('?')[0]
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/^.*\/enforced\/\d+-[^/]+\//, '')
        .replace(/^.*\/enforced\/\d+\//, '')
        .replace(/^\/content\/[^/]+\//, '');
      return s || fallback;
    }

    // Remove every label we may have placed — in BOTH the light DOM and the title
    // host's shadow root. The label lives INSIDE the component's shadow root, so a
    // plain document.querySelectorAll misses it (that was a real dedupe blind spot).
    function removeAllLabels(host) {
      document.querySelectorAll('#d2l-filename-display').forEach(el => el.remove());
      const root = host && host.getRootNode && host.getRootNode();
      if (root && root !== document && root.querySelectorAll) {
        root.querySelectorAll('#d2l-filename-display').forEach(el => el.remove());
      }
    }

    // Idempotent: clears any existing label (incl. shadow-root orphans) and
    // recreates exactly one as the LIVE host's next sibling, in the host's own
    // document so it lands in the correct (shadow) tree.
    function ensureContainer() {
      const host = getTitleHost();
      if (!host) return null;
      removeAllLabels(host);
      const el = (host.ownerDocument || document).createElement('div');
      el.id = 'd2l-filename-display';
      host.insertAdjacentElement('afterend', el);
      return el;
    }

    // ============================================================
    // KEEP-ALIVE — the title component <d2l-activity-content-editor-title> is
    // re-rendered/replaced during load (confirmed via lifecycle diagnostic), which
    // destroys its shadow root and any label we injected into it. A one-shot inject
    // loses that race → the label flashes and vanishes. So we watch the DOM and
    // re-attach the resolved label whenever it goes missing from the LIVE host's
    // root. Existence check is cheap and prevents needless churn.
    // ============================================================
    function labelHealthy() {
      const host = getTitleHost();
      if (!host) return true;                  // no host yet → nothing to maintain
      const root = host.getRootNode();
      return !!(root && root.querySelector && root.querySelector('#d2l-filename-display'));
    }

    function maintainLabel() {
      if (labelHealthy()) return;
      if (state && state.filename) injectLabel();   // restore the resolved label
      else if (state) showLoading();                // or the placeholder, pre-resolution
    }

    let maintainScheduled = false;
    function scheduleMaintain() {
      if (maintainScheduled) return;
      maintainScheduled = true;
      setTimeout(() => { maintainScheduled = false; maintainLabel(); }, 120);
    }

    function installKeepAlive() {
      if (installKeepAlive.done) return;            // once per page
      installKeepAlive.done = true;
      new MutationObserver(scheduleMaintain)
        .observe(document.documentElement, { childList: true, subtree: true });
    }

    function baseStyle(el, bg, fg, border) {
      el.style.cssText = `
        font-size:0.75rem;font-family:inherit;margin-top:5px;padding:3px 8px;
        border-radius:4px;display:inline-flex;align-items:center;gap:6px;
        background:${bg};color:${fg};border:1px solid ${border};
        user-select:text;flex-wrap:wrap;`;
    }

    function showLoading() {
      // never replace an already-resolved label with a placeholder
      if (state && state.filename) return;
      const el = ensureContainer();
      if (!el) return;
      baseStyle(el, '#f8f8f8', '#888', '#e0e0e0');
      el.textContent = '📄 detecting filename…';
    }

    function showError(msg) {
      try { console.warn('[D2L-FN]', msg, '|', location.href); } catch (_) {}
      const el = ensureContainer();
      if (!el) return;
      baseStyle(el, '#fdecea', '#a33', '#f5c2c0');
      el.textContent = `⚠️ ${msg}`;
    }

    function injectLabel() {
      const host = getTitleHost();
      if (!host || !state || !state.filename) return;
      const el = ensureContainer();
      if (!el) return;

      const name = state.filename;
      const warn = isGeneric(name) && !isDateSlug(name);
      const display = stripPrefix(state.path, name);
      baseStyle(el, warn ? '#fff3cd' : '#f0f4f8', warn ? '#856404' : '#4a5568', warn ? '#ffc107' : '#cbd5e0');
      el.title = state.path || name;

      el.innerHTML = `
        <span>${warn ? '⚠️' : '📄'}</span>
        <span><strong style="font-weight:600">filename:</strong>
          <span style="font-family:monospace">${escapeHtmlLocal(display)}</span></span>
        ${warn ? `<span style="font-size:0.7rem;opacity:0.75">(generic name)</span>` : ''}
        <a href="#" id="d2l-manage-files-link" title="Open Manage Files and highlight this file"
          style="margin-left:6px;padding:2px 7px;border-radius:3px;
          background:${warn ? '#fff0b3' : '#e2e8f0'};color:${warn ? '#7c5a00' : '#2b4a7a'};
          border:1px solid ${warn ? '#f0c040' : '#a0aec0'};font-size:0.7rem;
          text-decoration:none;white-space:nowrap;">🗂️ Manage Files</a>
        <a href="#" id="d2l-public-files-link" title="Open Public Files"
          style="margin-left:4px;padding:2px 7px;border-radius:3px;
          background:#e6ffed;color:#1a5c2e;
          border:1px solid #7bc99a;font-size:0.7rem;
          text-decoration:none;white-space:nowrap;">🌐 Public Files</a>`;

      el.querySelector('#d2l-manage-files-link').addEventListener('click', e => {
        e.preventDefault();
        openManageFiles(name, state.path || name);
      });
        el.querySelector('#d2l-public-files-link').addEventListener('click', e => {
        e.preventDefault();
        const url = 'https://brightspace.rcpi.ie/d2l/lp/manageFiles/main.d2l?g=1&ou=6606';
        const w = 1100, h = 700;
        const left = Math.round((screen.width - w) / 2);
        const top = Math.round((screen.height - h) / 2);
        const popup = window.open(url, 'd2l_public_files_popup',
          `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
        if (!popup) window.open(url, '_blank');
      });
    }

    // Locally named to avoid any ambiguity with the block-builder's own
    // top-level escapeHtml() elsewhere in this file — behaviour is identical.
    function escapeHtmlLocal(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ============================================================
    // HANDOFF — write the target, open the popup. runManageFilesLocator()
    // (matched on the Manage Files URL, at the top of this file) reads the
    // target on load.
    // We always open fresh so the Locator's on-load handler re-fires every
    // click; the named window simply reloads.
    // ============================================================
    // ⚠️ PAIRED PATH: this must stay in sync with the manageFiles @match at
    // the top of this file, and with the pathname check that dispatches to
    // runManageFilesLocator(). If D2L ever moves this tool, update all of
    // them — otherwise this opens a page the locator branch isn't watching.
    function manageFilesUrl() {
      return `/d2l/lp/manageFiles/main.d2l?ou=${encodeURIComponent(state.ou)}`;
    }

    function openManageFiles(filename, fullPath) {
      try {
        localStorage.setItem(HANDOFF_KEY, JSON.stringify({
          path: fullPath,
          filename,
          ou: state.ou,
          ts: Date.now(),
        }));
      } catch (_) { /* private mode / quota — popup still opens, just no auto-jump */ }

      const url = manageFilesUrl();
      const w = 1100, h = 700;
      const left = Math.round((screen.width - w) / 2);
      const top = Math.round((screen.height - h) / 2);
      const popup = window.open(url, 'd2l_manage_files_popup',
        `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);
      if (!popup) window.open(url, '_blank');   // popup blocked → plain tab
    }

    // ============================================================
    // ORCHESTRATION + SPA navigation handling
    // ============================================================
    let runToken = 0;
    let activeInterval = null;

    function start() {
      if (!isEditableContext()) return;
      if (isNewPageContext()) return;
      installKeepAlive();                  // re-attach the label across component re-renders
      const myToken = ++runToken;          // only the latest start() stays live
      if (activeInterval) clearInterval(activeInterval);

      state = freshState();
      state.ou = getOu();
      state.topicId = topicIdFromLocation();

      // wait for the title field, show a placeholder, kick the lookup
      let tries = 0;
      activeInterval = setInterval(() => {
        if (myToken !== runToken) { clearInterval(activeInterval); return; }
        const host = getTitleHost();
        if (host) {
          clearInterval(activeInterval);
          if (!state.topicId) { showError('no topic id in URL'); return; }
          if (!state.filename) showLoading();
          runDetection();
          setTimeout(() => {
            if (myToken !== runToken) return;
            const el = document.getElementById('d2l-filename-display');
            if (el && !state.filename) showError('lookup timed out');
          }, CFG.idResolveTimeoutMs);
        } else if (++tries > 60) {
          clearInterval(activeInterval);
        }
      }, 250);
    }

    // Re-run only if the user navigates to a genuinely different topic.
    let lastTopicId = null;
    function onNav() {
      const id = topicIdFromLocation();
      if (!id || id === lastTopicId) return;   // same page / no real change → do nothing
      lastTopicId = id;
      removeAllLabels(getTitleHost());
      if (isNewPageContext()) return;
      start();
    }
    window.addEventListener('popstate', onNav);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { lastTopicId = topicIdFromLocation(); start(); });
    } else {
      lastTopicId = topicIdFromLocation();
      start();
    }
  }

  // ─── FOLDED IN: MANAGE FILES LOCATOR (popup) ───────────────────────────
  // Originally the standalone "D2L Manage Files Locator" script. Runs
  // inside the Manage Files popup (dispatched to at the very top of this
  // file). Reads the target path handed off via localStorage, scrolls the
  // legacy YUI file list (lazy-loaded), navigates into subfolders if
  // needed, and highlights the matching file. Ported verbatim aside from
  // removing its own IIFE wrapper.
  function runManageFilesLocator() {
    // ============================================================
    // CONFIG  — confirmed selectors for this instance. The only place
    // to edit if D2L changes the Manage Files (legacy YUI) markup.
    // ============================================================
    const CFG = {
      mf: {
        // First-try class for the scrollable file-list pane. If D2L renames it,
        // getScroller() falls back to anchoring on the rows and climbing to the
        // nearest real scroll container — see getScroller().
        scroller: '.dsl_p_m',
        rowCheckbox: 'input[name="z_o_s"]',     // value = full enforced path (folders end in /)
      },
    };

    // Shared with initFilenameDisplayAndManageFiles() above. Must match there.
    const HANDOFF_KEY = 'd2l-mf-target';

    // Belt-and-suspenders only: the real safety is consume-on-read below.
    // The popup loads in well under a second, so this is never hit in the
    // normal flow; it just stops us acting on a stale leftover after a crash.
    const MAX_AGE_MS = 10 * 60 * 1000;          // 10 minutes

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ============================================================
    // PATH HELPERS
    // ============================================================
    function stripPrefix(p, fallback) {
      const s = String(p || fallback || '')
        .split('?')[0]
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/^.*\/enforced\/\d+-[^/]+\//, '')
        .replace(/^.*\/enforced\/\d+\//, '')
        .replace(/^\/content\/[^/]+\//, '');
      return s || fallback;
    }

    function folderInfo(path, fallback) {
      const rel = stripPrefix(path, fallback);
      const parts = rel.split('/').filter(Boolean);
      const filename = parts.pop() || fallback;
      return { folders: parts, filename };
    }

    // ============================================================
    // BANNER
    // ============================================================
    function makeBanner(pdoc, text) {
      pdoc.getElementById('d2l-tamper-banner')?.remove();
      const b = pdoc.createElement('div');
      b.id = 'd2l-tamper-banner';
      b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:99999;background:#fef3c7;
        border-bottom:2px solid #f59e0b;padding:8px 16px;font-family:sans-serif;font-size:13px;
        display:flex;align-items:center;gap:10px;color:#78350f;box-sizing:border-box;`;
      b.innerHTML = `<span>📄</span><span id="d2l-tamper-banner-text"></span>
        <button type="button" style="margin-left:auto;background:none;border:1px solid #f59e0b;
        border-radius:4px;padding:2px 8px;cursor:pointer;color:#78350f;font-size:12px;">✕</button>`;
      b.querySelector('#d2l-tamper-banner-text').textContent = text;
      b.querySelector('button').addEventListener('click', () => b.remove());
      pdoc.body.insertAdjacentElement('afterbegin', b);
      return b;
    }
    function setBanner(b, t) { const s = b?.querySelector('#d2l-tamper-banner-text'); if (s) s.textContent = t; }
    // Failure path: show it in the banner AND leave a greppable console breadcrumb,
    // so a problem months from now can be filtered from the console (it never fires
    // on success).
    function setFail(b, t) { setBanner(b, t); try { console.warn('[D2L-MF]', t, '|', location.href); } catch (_) {} }

    // ============================================================
    // ⚠️ DOM-DRIVEN SECTION (fragile) — drives the legacy Manage Files DOM,
    // so this is the part most likely to need future patching. Logic is
    // unchanged from the original; it just runs against this popup's own
    // `document` instead of reaching across `window.opener`.
    // ============================================================
    // Navigate into each path segment in turn. A folder opens via a delegated JS
    // click handler on its name link (href is "javascript://", onclick is null) —
    // so we must dispatch a real click on that <a>.
    //
    // Fragility note: we anchor on the STICKIEST signals, not YUI classes —
    //   • find the folder by its z_o_s checkbox value ending in /{segment}/  (the
    //     form-name + enforced-path contract), scrolling to load it if needed;
    //   • pick the link by matching the anchor whose visible text == the folder
    //     name (locale-independent — the name is our data). Name-cell/class and
    //     "first anchor in row" are fallbacks only.
    async function navFolders(pdoc, folders, banner) {
      for (const seg of folders) {
        setBanner(banner, `Opening folder: ${seg}`);
        const row = await findFolderRow(pdoc, seg, banner);
        if (!row) { setFail(banner, `Could not find folder "${seg}" — is it spelled exactly as in the path?`); return false; }

        const link = folderLink(row, seg);
        if (!link) { setFail(banner, `Folder "${seg}" row has no clickable name link — the Manage Files layout may have changed.`); return false; }

        const before = listingSignature(pdoc);
        link.scrollIntoView({ block: 'center' });
        await sleep(120);
        link.click();                      // delegated handler navigates the listing

        const changed = await waitForListingChange(pdoc, before);
        if (!changed) { setFail(banner, `Clicked folder "${seg}" but the list never changed — folder navigation may have changed.`); return false; }
      }
      return true;
    }

    // Scroll-find the folder row whose z_o_s value ends in /{segment}/.
    async function findFolderRow(pdoc, seg, banner) {
      const want = '/' + seg.toLowerCase() + '/';
      const find = () => {
        for (const cb of pdoc.querySelectorAll(CFG.mf.rowCheckbox)) {
          if ((cb.value || '').toLowerCase().endsWith(want)) return cb.closest('tr');
        }
        return null;
      };
      let row = find();
      if (row) return row;
      let prevH = -1, prevN = -1, stuck = 0;
      for (let i = 0; i < 120 && !row; i++) {
        const sc = getScroller(pdoc);
        const n = pdoc.querySelectorAll(CFG.mf.rowCheckbox).length;
        setBanner(banner, `Finding folder ${seg}… (${n} rows)`);
        sc.scrollTop = sc.scrollHeight;
        await sleep(i < 5 ? 600 : 400);
        row = find();
        const grew = sc.scrollHeight !== prevH || n !== prevN;
        if (!grew) { if (++stuck >= 4) break; } else { stuck = 0; }
        prevH = sc.scrollHeight; prevN = n;
      }
      return row || find();
    }

    // Confidence order: visible text == folder name → Name-cell link → first <a>.
    function folderLink(row, seg) {
      if (!row) return null;
      const anchors = Array.from(row.querySelectorAll('a'));
      const byText = anchors.find(a => (a.textContent || '').trim().toLowerCase() === seg.toLowerCase());
      if (byText) return byText;
      const nameCell = row.querySelector('td[class*="col-Name"], td[headers*="Name"]');
      const nameLink = nameCell && nameCell.querySelector('a');
      return nameLink || anchors[0] || null;
    }

    // A cheap fingerprint of the current listing — count + first/last row value.
    // Changes when we navigate into a folder (the whole table reloads).
    function listingSignature(pdoc) {
      const v = Array.from(pdoc.querySelectorAll(CFG.mf.rowCheckbox)).map(cb => cb.value || '');
      return v.length + '|' + (v[0] || '') + '|' + (v[v.length - 1] || '');
    }

    // Wait for the listing to change from `before`, then settle.
    async function waitForListingChange(pdoc, before) {
      const start = Date.now(); let last = null, stable = 0;
      while (Date.now() - start < 8000) {
        const sig = listingSignature(pdoc);
        if (sig !== before) {
          if (sig === last) { if (++stable >= 3) return true; } else { stable = 0; last = sig; }
        }
        await sleep(200);
      }
      return false;
    }

    async function findRowAutoScroll(pdoc, name, banner) {
      let prevH = -1, prevRows = -1, stuck = 0;
      for (let i = 0; i < 120; i++) {
        let row = findRowNow(pdoc, name);
        if (row) return row;
        const sc = getScroller(pdoc);
        if (!sc) { await sleep(500); continue; }

        const rows = pdoc.querySelectorAll(CFG.mf.rowCheckbox).length;
        setBanner(banner, `Loading file list… (${rows} so far)`);

        sc.scrollTop = sc.scrollHeight;
        await sleep(i < 5 ? 700 : 450);
        row = findRowNow(pdoc, name); if (row) return row;

        // stop when neither the height nor the row count grows across a few tries
        const grew = sc.scrollHeight !== prevH || rows !== prevRows;
        if (!grew) { if (++stuck >= 4) break; } else { stuck = 0; }
        prevH = sc.scrollHeight; prevRows = rows;
      }
      return findRowNow(pdoc, name);
    }

    // Try the declared class first (fast, exact). If it's gone — or it isn't
    // actually the scrolling element — anchor on something stable (the rows,
    // matched by their form `name`) and climb to the nearest ancestor that
    // genuinely scrolls. Class is a convenience; structure is the safety net.
    function isScrollable(el, view) {
      if (!el || el.nodeType !== 1) return false;
      const oy = view.getComputedStyle(el).overflowY;
      return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 50;
    }

    function getScroller(pdoc) {
      const view = pdoc.defaultView || window;

      // 1) AUTHORITATIVE — the scroll container that actually HOLDS the file rows.
      //    This page has several .dsl_p_m panes and more than one of them scrolls
      //    (the folder-tree pane is a scrollable decoy), so picking "the first
      //    .dsl_p_m that scrolls" grabs the wrong one. Anchor on a row and climb to
      //    its nearest scrolling ancestor — that is, by definition, the file list.
      const anchor = pdoc.querySelector(CFG.mf.rowCheckbox);
      const start = anchor ? (anchor.closest('table') || anchor) : null;
      for (let el = start; el; el = el.parentElement) {
        if (isScrollable(el, view)) return el;
      }

      // 2) declared class, but only a pane that BOTH contains rows AND scrolls
      for (const pane of pdoc.querySelectorAll(CFG.mf.scroller)) {
        if (pane.querySelector(CFG.mf.rowCheckbox) && isScrollable(pane, view)) return pane;
      }

      // 3) last resorts: any declared pane, then the page itself
      return pdoc.querySelector(CFG.mf.scroller) || pdoc.scrollingElement || pdoc.documentElement;
    }

    // Checkbox value is a TYPE-PREFIXED full enforced path, e.g.
    //   d_/content/enforced/{ou}-{course}/banners/      (folder — trailing slash)
    //   f_/content/enforced/{ou}-{course}/Lesson X.html (file — no trailing slash)
    // We match on the path ENDING in our filename, so the d_/f_ prefix and any
    // leading folders are irrelevant, and spaces/parens are handled exactly.
    function findRowNow(pdoc, name) {
      const lower = name.toLowerCase();
      for (const cb of pdoc.querySelectorAll(CFG.mf.rowCheckbox)) {
        const val = (cb.value || '').replace(/\/+$/, '');   // trim trailing slash
        if (val.toLowerCase().endsWith('/' + lower) || val.toLowerCase() === lower) {
          return cb.closest('tr');
        }
      }
      return null;
    }

    function highlight(pdoc, row) {
      row.style.background = '#fff9c4';
      row.style.outline = '2px solid #f59e0b';
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = true;
    }

    // ============================================================
    // ENTRY — read the handoff (one-shot), then locate.
    // ============================================================
    function readTarget() {
      let raw;
      try { raw = localStorage.getItem(HANDOFF_KEY); } catch (_) { return null; }
      if (!raw) return null;
      // consume immediately so a stray reload/manual open never re-triggers
      try { localStorage.removeItem(HANDOFF_KEY); } catch (_) {}
      let t;
      try { t = JSON.parse(raw); } catch (_) { return null; }
      if (!t || !t.filename) return null;
      if (t.ts && (Date.now() - t.ts) > MAX_AGE_MS) return null;   // stale leftover
      return t;
    }

    async function run(target) {
      const { folders, filename } = folderInfo(target.path, target.filename);
      const banner = makeBanner(document, `Looking for ${filename}…`);
      try {
        const navOk = await navFolders(document, folders, banner);
        if (!navOk) return;             // banner already names the folder that failed
        setBanner(banner, 'Scanning file list…');
        const row = await findRowAutoScroll(document, filename, banner);
        if (row) {
          highlight(document, row);
          setBanner(banner, `Highlighted: ${filename} — use the ⌄ arrow to rename`);
        } else {
          // Distinguish the two very different failures: we COULD read the list but
          // the name isn't here (a name/location problem — the common case), versus
          // we couldn't read any rows at all (the Manage Files tool likely changed).
          const rows = document.querySelectorAll(CFG.mf.rowCheckbox).length;
          if (rows > 0) {
            setFail(banner, `Scanned ${rows} item(s) in this folder — none named "${filename}". Check the exact name and extension.`);
          } else {
            setFail(banner, `Couldn't read any files here — the folder may be empty, or the Manage Files list structure has changed.`);
          }
        }
      } catch (e) {
        setFail(banner, `Stopped: an error occurred while scanning the file list.`);
        try { console.warn('[D2L-MF] exception', e); } catch (_) {}
      }
    }

    function init() {
      const target = readTarget();
      if (!target) return;            // opened manually / no fresh handoff → stay quiet
      run(target);
    }

    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
  }

  // ─── INIT ───────────────────────────────────────────────────────────────────
  function init() {
    buildPanel();
    attachIconSwapListener();
    attachMutationObserver();
    checkAuditHandoff();

    // Auto-snapshot the editor's opening state once it's available, and show the
    // initial word count. The snapshot gives a per-session restore point.
    if (tinyDoc) {
      takeSnapshot('auto');
      updateWordCount();
    }

    // Poll for editor changes — D2L can swap the active editor (e.g. after save)
    // syncTinyRefs() is cheap so polling every 3s is fine
    let snapshottedOnce = !!tinyDoc;
    setInterval(() => {
      const prevDoc = tinyDoc;
      if (syncTinyRefs() && tinyDoc !== prevDoc) {
        // Editor was replaced — re-attach listeners
        attachIconSwapListener();
        attachMutationObserver();
        refreshComponentList();
        scheduleAudit();
        // first time the editor becomes available (if it wasn't at startup),
        // take the opening auto-snapshot.
        if (!snapshottedOnce && tinyDoc) { takeSnapshot('auto'); snapshottedOnce = true; }
        updateWordCount();
      }
    }, 3000);
  }

  waitForTinyMCE(init);

})();