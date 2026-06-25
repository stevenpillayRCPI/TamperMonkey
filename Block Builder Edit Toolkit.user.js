// ==UserScript==
// @name         Block Builder Edit Toolkit
// @namespace    rcpi-block-builder
// @description  Alt+right-click toolkit for the RCPI block builder: tables, wrap+columns, convert, item-ops, row colour/insert/align, icon swap, image figure/decorative/transcript/search, fix/repair, strip formatting, Alt-hint overlay, leader-key shortcuts. Left dock.
// @match        https://brightspace.rcpi.ie/d2l/le/lessons/*/edit/*
// @match        https://brightspace.rcpi.ie/d2l/lms/content/*/edit/*
// @version      2.9
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const BB_ORIGIN = '*'; // tighten to your block builder origin if known
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
    // When true, actions that can be done in-place (apply colour, delete/dup item)
    // write directly through tinymce.activeEditor — one click, no paste.
    // When false, those same actions fall back to copy-a-row, which you paste.
    // Persisted across page loads (footer toggle). Safe operations (add/move/
    // delete item, image edits, etc.) always try the API regardless via ungated.
    USE_TINYMCE_API: gmBool('bb-cfg-api', false),

    // Verbose console logging ([BB]-prefixed) for contextmenu events, writes, and
    // menu decisions. Off by default now the toolkit is stable; flip it on from
    // the footer when debugging. Persisted across page loads.
    DEBUG: gmBool('bb-cfg-debug', false),

    // Suppress TinyMCE's native right-click menu when our handler claims the
    // event. If you ever want D2L's menu back, set false.
    SUPPRESS_NATIVE_MENU: true,
  };

  function dbg(...args) { if (CONFIG.DEBUG) console.log('[BB]', ...args); }

  // ─── DIRECT-WRITE HELPER (TinyMCE API) ──────────────────────────────────────
  // Central place for all editor writes. Returns true on success, false if the
  // API path is off/unavailable (caller then does the paste fallback). Every
  // write flags the editor dirty + fires input so D2L's Save activates.
  //
  // `opts.ungated` lets a SAFE, non-destructive operation (e.g. appending one
  // item to a component) attempt the API even when the global Direct-write
  // toggle is off — because the API path is strictly better there (it dodges
  // TinyMCE's paste filter that strips the row wrapper) and can't lose data. If
  // the editor isn't reachable, it still returns false and the caller falls back.
  function tinyWrite(mutateFn, label, opts) {
    const ungated = opts && opts.ungated;
    if (!CONFIG.USE_TINYMCE_API && !ungated) {
      dbg('tinyWrite skipped (API off):', label);
      return false;
    }
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
      ed.fire('input');
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
    iconCard: txt => `<div contenteditable="false"><div class="col-12"><div class="card card-white card-with-icon" contenteditable="false"><div class="card-body d-flex"><div class="icon-column"><i class="bi bi-star-fill" style="color: var(--bs-tertiary-dark);"></i></div><div class="content-column"><div contenteditable="true"><h3 class="card-title">Title</h3><p class="card-text">${txt}</p></div></div></div></div></div></div>`,

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
  };

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
      console.warn('[BB Toolkit] clipboard.writeText failed', err);
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
      console.warn('[BB Toolkit] TinyMCE not found after 40s — building panel anyway');
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

  // ─── FIX / REPAIR PAGE ──────────────────────────────────────────────────────
  // One-click checker that auto-fixes safe structural issues and reports the
  // ones needing human judgement (image accessibility). All edits go through one
  // tinyWrite so the whole repair is a single undo step + one Save flag.
  function runFixPage() {
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

  // Image placeholder (to replace an icon context)
  function genImagePlaceholder() {
    return `<figure class="">
  <div class="image-container" style="position: relative;" contenteditable="false">
    <img src="https://placehold.co/1920x1080/EEE/31343C" alt="ALT TEXT NEEDED" class="img-fluid">
  </div>
  <figcaption contenteditable="false"><span contenteditable="true">Caption </span></figcaption>
</figure>`;
  }

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
        <span id="bb-tk-title">🧱 BB Toolkit</span>
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
            <b>cell(s)</b> → table colours/structure · <b>selected text</b> → wrap / 2-columns · <b>component</b> → convert · <b>icon</b> → swap · <b>image</b> → figure/decorative · <b>row</b> → colour & insert · <b>gap</b> → insert row at cursor.</p>
            <button id="bb-tk-insert-row" class="bb-btn bb-btn-plus" style="margin:0 0 8px;">+ Insert row at cursor</button>
            <button id="bb-tk-fix" class="bb-btn bb-btn-goto" style="margin:0 0 8px;">🔧 Check &amp; fix page issues</button>
            <button id="bb-tk-audit-launch" class="bb-btn bb-btn-goto" style="margin:0 0 8px;">🔍 Content audit (404s, citations, a11y)</button>
            <div id="bb-tk-comp-list"></div>
          </div>
          <div id="bb-tk-audit" class="bb-tabpanel">
            <p class="bb-hint">Content quality checks. Click an item to highlight it in the editor.</p>
            <div id="bb-tk-audit-list"></div>
          </div>
          <div id="bb-tk-history" class="bb-tabpanel">
            <p class="bb-hint">Last ${HISTORY_MAX} components copied from the Block Builder.</p>
            <div id="bb-tk-hist-list"></div>
          </div>
        </div>
        <div id="bb-tk-footer">
          <label class="bb-toggle" title="Write directly into the editor (one click, no paste). Persists across page loads.">
            <input type="checkbox" id="bb-tk-api"> Direct-write mode
          </label>
          <label class="bb-toggle" title="Verbose console logging, prefixed [BB]. Persists across page loads.">
            <input type="checkbox" id="bb-tk-debug"> Debug
          </label>
          <div class="bb-shortcut-hint" title="Press Alt+B, release, then the action key">⌨ Alt+B then: R row · F fix · M min · D direct</div>
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
      minBar.title = 'Open BB Toolkit';
      minBar.innerHTML = '<span>🧱 BB&nbsp;Toolkit</span>';
      minBar.style.display = 'none';
      minBar.addEventListener('click', () => setMinimized(false));
      document.body.appendChild(minBar);
    }

    injectPanelStyles();

    // API + debug toggles reflect and mutate CONFIG live
    const apiCb = panel.querySelector('#bb-tk-api');
    const dbgCb = panel.querySelector('#bb-tk-debug');
    apiCb.checked = CONFIG.USE_TINYMCE_API;
    dbgCb.checked = CONFIG.DEBUG;
    apiCb.addEventListener('change', () => {
      CONFIG.USE_TINYMCE_API = apiCb.checked;
      try { GM_setValue('bb-cfg-api', apiCb.checked ? '1' : '0'); } catch {}
      dbg('USE_TINYMCE_API ->', CONFIG.USE_TINYMCE_API);
      refreshComponentList(); // show/hide −1 / dup buttons
      toast(`Direct-write mode ${CONFIG.USE_TINYMCE_API ? 'ON' : 'OFF'}`, CONFIG.USE_TINYMCE_API ? 'success' : 'warn');
    });
    dbgCb.addEventListener('change', () => {
      CONFIG.DEBUG = dbgCb.checked;
      try { GM_setValue('bb-cfg-debug', dbgCb.checked ? '1' : '0'); } catch {}
      console.log('[BB] DEBUG ->', CONFIG.DEBUG);
    });

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

    // Launcher for the separate Content Audit userscript (404s/citations/a11y).
    // That script exposes window.rcpiOpenPanel(); we just call it. If it isn't
    // installed, point the user to it rather than failing silently.
    const auditBtn = panel.querySelector('#bb-tk-audit-launch');
    if (auditBtn) {
      auditBtn.addEventListener('click', () => {
        const opener = (typeof unsafeWindow !== 'undefined' && unsafeWindow.rcpiOpenPanel)
          ? unsafeWindow.rcpiOpenPanel
          : window.rcpiOpenPanel;
        if (typeof opener === 'function') {
          try { opener(); }
          catch (err) { dbg('audit launch failed', err); toast('Could not open the Content Audit panel', 'error'); }
        } else {
          toast('Content Audit script not detected — is it installed and enabled?', 'warn');
        }
      });
    }

    // Tab switching
    panel.querySelectorAll('.bb-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.bb-tab').forEach(b => b.classList.remove('active'));
        panel.querySelectorAll('.bb-tabpanel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        panel.querySelector(`#bb-tk-${btn.dataset.tab}`).classList.add('active');
        if (btn.dataset.tab === 'components') refreshComponentList();
        if (btn.dataset.tab === 'audit') refreshAuditList();
        if (btn.dataset.tab === 'history') refreshHistoryList();
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
      const noAddTypes = ['Icon Card', 'Image', 'Image Column', 'Click and Reveal'];
      const replaceable = ['Accordion', 'Numbered Accordion', 'Icon Accordion',
                           'Horizontal Tabs', 'Vertical Tabs', 'Flipcards',
                           'Text Carousel', 'Image Carousel', 'Reveal Table', 'Icon List'];

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
              console.error('[BB Toolkit] +1 failed', err);
              toast('Could not add item — see console', 'error');
            }
          });
          actions.appendChild(replBtn);

          // −1 and dup: direct-write only (deleting/duplicating a single item
          // mid-component is clumsy as a paste, clean as an API edit). Shown
          // only when API mode is on, since they have no good paste fallback.
          if (CONFIG.USE_TINYMCE_API && comp.count && comp.count > 1) {
            const delBtn = document.createElement('button');
            delBtn.className = 'bb-btn bb-btn-goto';
            delBtn.title = 'Delete the last item of this component (direct edit)';
            delBtn.textContent = '−1';
            delBtn.addEventListener('click', () => deleteLastItem(comp));
            actions.appendChild(delBtn);
          }
          if (CONFIG.USE_TINYMCE_API && comp.count && comp.count >= 1) {
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
      // Refresh audit list if that tab is active
      if (document.querySelector('.bb-tab[data-tab="audit"]')?.classList.contains('active')) {
        refreshAuditList();
      }
    }, AUDIT_DEBOUNCE_MS);
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
      ed.fire('input');
      dbg('tableCmd ran:', cmd, value !== undefined ? value : '');
      return true;
    } catch (err) {
      dbg('tableCmd failed:', cmd, err);
      toast('Command failed: ' + cmd, 'error');
      return false;
    }
  }

  // Apply a background colour to the whole current cell selection at once.
  function applyCellBackground(hex) {
    const ok = tableCmd('mceTableApplyCellStyle', { 'background-color': hex });
    if (ok) toast(hex ? `✓ Cell background set` : '✓ Cell background cleared', 'success');
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
      ed.fire('input');
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
    //   Alt+B then R  → insert row at caret
    //   Alt+B then F  → run fix/repair
    //   Alt+B then M  → minimise / restore the panel
    //   Alt+B then D  → toggle direct-write
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
        syncTinyRefs();
        const ib = document.getElementById('bb-tk-insert-row');
        if (ib) { const r = ib.getBoundingClientRect(); openInsertRowMenu(r.left, r.bottom + 4, null, null, true); }
      } else if (k === 'f') {
        syncTinyRefs(); runFixPage();
      } else if (k === 'm') {
        const minimised = document.getElementById('bb-tk-minbar')?.style.display === 'flex';
        setMinimized(!minimised);
      } else if (k === 'd') {
        const cb = document.getElementById('bb-tk-api');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }
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
    { key: 'row',   sel: '.row.wysiwyg-mode', color: '#d63384', label: 'Row: colour / insert / align / strip / delete' },
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
    const imgEl  = tgt.closest && tgt.closest('img');
    const rowEl  = tgt.closest && tgt.closest('.row.wysiwyg-mode');
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

    // Priority 1: an icon -> icon swap
    if (iEl) {
      claim('icon-swap');
      openIconModal(iEl);
      return;
    }

    // Priority 1.2: an image -> image options (figure/caption, decorative).
    if (imgEl) {
      claim('image-options');
      openImageMenu(imgEl, e.clientX, e.clientY);
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
      openRowMenu(rowEl, e.clientX, e.clientY);
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
  function openRowMenu(rowEl, x, y) {
    closeAnyMenu();
    const current = ALL_ROW_COLOUR_CLASSES.find(c => rowEl.classList.contains(c)) || '';
    dbg('openRowMenu. current colour=', current || '(none)');

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
      btn.addEventListener('click', (e) => {
        // Stop this click from bubbling to the document, where the row menu's
        // armed closeAnyMenu listener would otherwise immediately close the
        // submenu we're about to open. Remove the existing menu first.
        e.stopPropagation();
        const cur = document.getElementById('bb-row-menu');
        if (cur) cur.remove();
        openInsertRowMenu(x, y, rowEl, pos);
      });
      menu.appendChild(btn);
    });

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

    const cleanBtn = document.createElement('button');
    cleanBtn.textContent = '🧹 Strip Word/paste formatting';
    cleanBtn.addEventListener('click', () => { stripFormattingIn(rowEl); closeAnyMenu(); });
    menu.appendChild(cleanBtn);
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

  function deleteRow(rowEl) {
    const didWrite = tinyWrite(() => { rowEl.remove(); }, 'delete row', { ungated: true });
    if (didWrite) { toast('✓ Row deleted', 'success'); scheduleAudit(); refreshComponentList(); }
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

    positionMenu(menu, x, y, absolute);
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

  const BB_MENU_IDS = ['bb-row-menu', 'bb-insertrow-menu', 'bb-wrap-menu', 'bb-image-menu',
    'bb-component-menu', 'bb-convert-menu', 'bb-table-menu', 'bb-icon-menu'];

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

    // Accessibility: add a transcript accordion below (for complex/text images).
    const sepA = document.createElement('div');
    sepA.className = 'bb-ctx-sub';
    sepA.textContent = 'Accessibility';
    menu.appendChild(sepA);
    add('+ Transcript accordion below', () => addTranscriptBelow(imgEl));

    // Replace the image source via a prompt.
    const sepR = document.createElement('div');
    sepR.className = 'bb-ctx-sub';
    sepR.textContent = 'Source';
    menu.appendChild(sepR);
    add('🔗 Replace image URL…', () => replaceImageSrc(imgEl));

    positionMenu(menu, x, y);
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

  // Insert a transcript accordion in its own row immediately AFTER the image's
  // enclosing row. Sets the image alt to "" (the accordion now carries meaning).
  function addTranscriptBelow(imgEl) {
    const didWrite = tinyWrite(() => {
      const id = uid('transcript');
      const rowHTML = TPL.wrapRow(TPL.transcriptAccordion(id, 'Image description', '<p>Describe the image / transcribe its text here.</p>'));
      const tmp = tinyDoc.createElement('div');
      tmp.innerHTML = rowHTML.trim();
      const newRow = tmp.firstElementChild;
      const hostRow = imgEl.closest('.row.wysiwyg-mode');
      if (hostRow && hostRow.parentNode) {
        hostRow.parentNode.insertBefore(newRow, hostRow.nextSibling);
      } else {
        // no row? append into the container after the image's top-level block
        const container = getTinyEditor().getBody().querySelector('.container') || getTinyEditor().getBody();
        container.appendChild(newRow);
      }
      // image now described by the accordion -> empty alt to avoid double-read
      imgEl.setAttribute('alt', '');
    }, 'add transcript accordion', { ungated: true });
    finishImage(didWrite, 'Transcript accordion added below (alt set to empty)');
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

  // Wrap a bare <img> in the standard figure structure.
  function imageToFigure(imgEl, decorative) {
    const didWrite = tinyWrite(() => {
      const src = imgEl.getAttribute('src') || '';
      const fig = tinyDoc.createElement('div');
      const alt = decorative ? '' : (imgEl.getAttribute('alt') || 'REQUIRED');
      const decoClass = decorative ? ' decorative' : '';
      const figcap = decorative ? '' : `<figcaption contenteditable="false"><span contenteditable="true">Caption </span></figcaption>`;
      fig.innerHTML = `<figure class="wysiwyg-mode${decoClass}"><div class="image-container" style="position: relative;" contenteditable="false"><div contenteditable="true"><img src="${src}" alt="${alt}" class="img-fluid${decoClass}"></div></div>${figcap}</figure>`;
      const figure = fig.firstElementChild;
      // Replace the img (or its nearest editable wrapper) with the figure
      const wrapper = imgEl.closest('[contenteditable="true"]');
      const replaceTarget = (wrapper && wrapper.children.length === 1 && wrapper.firstElementChild === imgEl) ? wrapper : imgEl;
      replaceTarget.replaceWith(figure);
    }, 'image -> figure' + (decorative ? ' (decorative)' : ''), { ungated: true });
    finishImage(didWrite, decorative ? 'Wrapped as decorative figure' : 'Wrapped in figure');
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
          cap.innerHTML = '<span contenteditable="true">Caption </span>';
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
      cap.innerHTML = '<span contenteditable="true">Caption </span>';
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
        width: 26px;
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
      .bb-btn {
        padding: 3px 8px; border-radius: 4px; border: 1px solid;
        cursor: pointer; font-size: 11px; white-space: nowrap;
      }
      .bb-btn-plus  { background: #002d72; color: #fff; border-color: #002d72; }
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

  // ─── INIT ───────────────────────────────────────────────────────────────────
  function init() {
    buildPanel();
    attachIconSwapListener();
    attachMutationObserver();

    // Poll for editor changes — D2L can swap the active editor (e.g. after save)
    // syncTinyRefs() is cheap so polling every 3s is fine
    setInterval(() => {
      const prevDoc = tinyDoc;
      if (syncTinyRefs() && tinyDoc !== prevDoc) {
        // Editor was replaced — re-attach listeners
        attachIconSwapListener();
        attachMutationObserver();
        refreshComponentList();
        scheduleAudit();
      }
    }, 3000);
  }

  waitForTinyMCE(init);

})();