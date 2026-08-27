// ==UserScript==
// @name         D2L Manage Files Rename Next Batch
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Staged rollout batch renamer for Brightspace Manage Files. Renames visible HTML files using Last Modified date. Supports rename-all with chunked execution, live progress, and cancellation.
// @match        https://brightspace.rcpi.ie/d2l/lp/manageFiles/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ─── Config ────────────────────────────────────────────────────────────────

  const CFG = {
    rowCheckboxSelector:   'input[name="z_o_s"]',
    panelId:               'd2l-mf-rename-next-panel',
    bannerId:              'd2l-mf-rename-next-banner',
    debugPrefix:           '[D2L-MF-REN-BATCH]',

    maxWaitMs:             10000,
    observerDebounceMs:    180,
    saveSettleMs:          350,
    postRenameVerifyMs:    8000,

    defaultBatchSize:      5,
    batchDelayMs:          600,   // pause between individual renames within a chunk

    // "Rename all" chunking — stop every N renames to rescan and breathe
    renameAllChunkSize:    5,
    renameAllChunkPauseMs: 1500,  // settle time between chunks

    // Generic filename bases — matched against the stripped, slugified file base.
    // A file is only considered generic if its entire base (after stripping the
    // compliance suffix and any " - copy (N)" variants) exactly matches one of
    // these strings.
    genericNames: new Set([
      'untitled', 'summary', 'overview', 'introduction', 'intro',
      'page', 'content', 'new-page', 'topic', 'lesson', 'module',
      'review', 'section', 'week', 'unit', 'chapter',
    ]),

    // Max chars to take from the secondLast hierarchy segment when prepending
    // to disambiguate a generic last segment.
    secondLastMaxChars: 20,

    // Max chars for the slug portion of a hierarchy-derived filename.
    slugMaxChars: 50,
  };

  // ─── State ─────────────────────────────────────────────────────────────────

  const state = {
    seenRows:         new Map(),
    observer:         null,
    observerRoot:     null,
    observerBursts:   0,
    pendingDebounce:  null,
    lastPreview:      null,
    lastRename:       null,
    lastBatch:        [],
    batchRunning:     false,
    cancelRequested:  false,   // set to true to abort a rename-all mid-run
    renameLog:        [],      // persists across batches until page reload
  };

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function dbg(...a)  { try { console.debug(CFG.debugPrefix, ...a); } catch (_) {} }
  function warn(...a) { try { console.warn(CFG.debugPrefix,  ...a); } catch (_) {} }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function afterPaint() {
    return new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  }

  function visibleText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  // ─── DOM row helpers ────────────────────────────────────────────────────────

  function allRows(root = document) {
    const rows = [];
    for (const cb of root.querySelectorAll(CFG.rowCheckboxSelector)) {
      const tr = cb.closest('tr');
      if (tr) rows.push(tr);
    }
    return rows;
  }

  function rowRawValue(tr) {
    return tr?.querySelector(CFG.rowCheckboxSelector)?.value || '';
  }

  function rowPath(tr) {
    const raw = rowRawValue(tr);
    if (!raw || !/^f_/i.test(raw)) return null;
    return String(raw)
      .replace(/^f_\/?/i, '')
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/^\/+/, '');
  }

  function rowFilename(tr) {
    const raw = rowPath(tr);
    if (!raw) return null;
    let name = raw.split('/').filter(Boolean).pop() || raw;
    try { name = decodeURIComponent(name); } catch (_) {}
    return name;
  }

  function rowLooksHtml(tr) {
    const name = rowFilename(tr);
    return !!(name && /\.(html?|htm)$/i.test(name));
  }

  function alreadyCompliant(name) {
    return /-\d{6}-[a-z0-9]{4}\.html?$/i.test(name || '');
  }

  function rowNameCell(tr) {
    const cells = Array.from(tr.querySelectorAll('td'));
    for (const td of cells) {
      const link = td.querySelector('a[href]');
      const text = (link?.textContent || '').trim();
      if (text && /\.(html?|htm)$/i.test(text)) return td;
    }
    return cells.find(td => td.querySelector('a[href]')) || null;
  }

  function rowDisplayFilename(tr) {
    const td = rowNameCell(tr);
    if (!td) return rowFilename(tr);
    const input = Array.from(td.querySelectorAll('input[type="text"], input:not([type])')).find(isVisible);
    if (input && input.value) return input.value.trim();
    const linkText = td.querySelector('a span, a')?.textContent?.trim();
    if (linkText) return linkText;
    return rowFilename(tr);
  }

  function rowLastModifiedText(tr) {
    for (const td of tr.querySelectorAll('td')) {
      const text = (td.textContent || '').replace(/\s+/g, ' ').trim();
      const m = text.match(/\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M\b/);
      if (m) return m[0];
    }
    return null;
  }

  function parseRowDateToYYMMDD(text) {
    if (!text) return null;
    const m = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+\d{1,2}:\d{2}\s+[AP]M$/);
    if (!m) return null;
    const months = {
      january:'01', february:'02', march:'03',     april:'04',
      may:'05',     june:'06',     july:'07',       august:'08',
      september:'09', october:'10', november:'11', december:'12',
    };
    const dd = String(m[1]).padStart(2, '0');
    const mm = months[m[2].toLowerCase()];
    if (!mm) return null;
    return m[3].slice(-2) + mm + dd;
  }

  function random4() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function buildNewFilename(oldName, yymmdd) {
    const m = String(oldName || '').match(/^(.*?)(\.[^.]+)$/);
    if (!m) return null;
    let [, base, ext] = m;
    ext = ext.toLowerCase();
    base = base
      .replace(/-\d{6}-[a-z0-9]{4}$/i, '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ').replace(/\+/g, ' plus ')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${base}-${yymmdd}-${random4()}${ext}`;
  }

  // ─── Generic filename helpers ──────────────────────────────────────────────

  // Slugify a string: normalise accents, lower, replace non-alphanum runs with
  // hyphens, trim leading/trailing hyphens.
  function slugify(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ').replace(/\+/g, ' plus ')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Strip the compliance suffix (-yymmdd-xxxx) and any " - copy (N)" / " - copy"
  // variants, then slugify to get the bare base for genericness testing.
  function strippedBase(name) {
    return slugify(
      String(name || '')
        .replace(/\.[^.]+$/, '')               // strip extension
        .replace(/-[0-9]{6}-[a-z0-9]{4}$/i, '') // strip compliance suffix
        .replace(/\s*-?\s*copy\s*(\(\d+\))?\s*$/i, '') // strip " - copy (N)"
        .replace(/\s*\(\d+\)\s*$/,'')          // strip trailing (N) if any remain
    );
  }

  // Return true if the filename's bare base is generically named.
  function isGenericName(name) {
    return CFG.genericNames.has(strippedBase(name));
  }

  // Given a hierarchy string "A > B > C", return { last, secondLast }.
  function hierarchySegments(hierarchy) {
    const segs = String(hierarchy || '').split(' > ').map(s => s.trim()).filter(Boolean);
    return {
      last:       segs[segs.length - 1] || '',
      secondLast: segs[segs.length - 2] || '',
    };
  }

  // Build a slug from the content hierarchy for a generic filename.
  // Uses last segment; if that is itself generic, prepends up to
  // CFG.secondLastMaxChars of the secondLast segment.
  function hierarchySlug(hierarchy) {
    const { last, secondLast } = hierarchySegments(hierarchy);
    const lastSlug = slugify(last);
    if (!lastSlug) return null;

    if (CFG.genericNames.has(lastSlug)) {
      // Last segment is also generic — prepend secondLast
      const prefix = slugify(secondLast).slice(0, CFG.secondLastMaxChars).replace(/-+$/, '');
      return prefix ? `${prefix}-${lastSlug}` : lastSlug;
    }

    return lastSlug.slice(0, CFG.slugMaxChars);
  }

  // Build the proposed filename for a generic file using hierarchy data.
  // Reuses the existing yymmdd+4char code if the file was already compliance-
  // renamed, otherwise uses the supplied yymmdd with a fresh random4().
  function buildHierarchyFilename(oldName, hierarchy, yymmdd) {
    const slug = hierarchySlug(hierarchy);
    if (!slug) return null;

    // Try to reuse existing date+code from a prior compliance rename
    const reuseMatch = String(oldName || '').match(/-([0-9]{6})-([a-z0-9]{4})\.html?$/i);
    const date4 = reuseMatch ? reuseMatch[1] : yymmdd;
    const code4 = reuseMatch ? reuseMatch[2] : random4();
    if (!date4) return null;

    return `${slug}-${date4}-${code4}.html`;
  }

  // Look up the hierarchy for a file from D2L_MF_HIER.getFileMap() by its
  // current (possibly pre-rename) filename.
  function lookupHierarchyForFile(filename) {
    const hier = window.D2L_MF_HIER;
    if (!hier) return null;
    const entries = hier.getFileMap?.()?.get((filename || '').toLowerCase()) || [];
    return entries[0]?.hierarchy || null;
  }

  function rowMeta(tr) {
    const currentName  = rowDisplayFilename(tr);
    const modifiedText = rowLastModifiedText(tr);
    const yymmdd       = parseRowDateToYYMMDD(modifiedText);
    const wasCompliant = alreadyCompliant(currentName);
    const generic      = isGenericName(currentName);

    // For generic files, try to build a hierarchy-derived name.
    // For normal files, use the standard date-slug approach.
    let proposedName = null;
    if (generic) {
      const hierarchy = lookupHierarchyForFile(currentName);
      if (hierarchy) proposedName = buildHierarchyFilename(currentName, hierarchy, yymmdd);
    }
    if (!proposedName && !wasCompliant) {
      proposedName = currentName && yymmdd ? buildNewFilename(currentName, yymmdd) : null;
    }

    return {
      tr,
      rawValue:     rowRawValue(tr),
      path:         rowPath(tr),
      currentName,
      modifiedText,
      yymmdd,
      proposedName,
      html:         rowLooksHtml(tr),
      compliant:    wasCompliant && !generic,  // compliant only if dated AND not generic
      wasCompliant,
      generic,
    };
  }

  function visibleEligibleRows() {
    return allRows()
      .filter(isVisible)
      .map(rowMeta)
      .filter(m => {
        if (!m.html || !m.currentName || m.compliant) return false;
        if (!m.proposedName || m.proposedName === m.currentName) return false;
        // Generic files require hierarchy data — don't queue them without it
        if (m.generic && !lookupHierarchyForFile(m.currentName)) return false;
        // Non-generic files need a date from the table
        if (!m.generic && !m.yymmdd) return false;
        return true;
      });
  }

  function nextEligible() {
    return visibleEligibleRows()[0] || null;
  }

  // ─── Rename mechanics ───────────────────────────────────────────────────────

  function rowDropdownInnerButton(tr) {
    return tr?.querySelector('d2l-dropdown-context-menu')
      ?.shadowRoot?.querySelector('d2l-button-icon')
      ?.shadowRoot?.querySelector('button,[role="button"]') || null;
  }

  function visibleRenameEditor(tr) {
    const nameCell = rowNameCell(tr);
    if (!nameCell) return null;
    const input = Array.from(nameCell.querySelectorAll('input[type="text"], input:not([type])'))
      .find(isVisible);
    if (!input) return null;
    const buttons   = Array.from(nameCell.querySelectorAll('button')).filter(isVisible);
    const saveBtn   = buttons.find(b => /^save$/i.test((b.textContent || '').trim()));
    const cancelBtn = buttons.find(b => /^cancel$/i.test((b.textContent || '').trim()));
    return { input, saveBtn, cancelBtn };
  }

  function findVisibleRenameMenuItem() {
    const items = Array.from(document.querySelectorAll('d2l-menu-item,[role="menuitem"]'));
    const visible = items.filter(el => {
      const label = el.getAttribute('aria-label') || '';
      const txt   = visibleText(el);
      return isVisible(el) && (/^rename$/i.test(label) || /^rename$/i.test(txt));
    });
    return visible[visible.length - 1] || null;
  }

  async function waitFor(fn, timeoutMs = CFG.maxWaitMs, stepMs = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  function clickSynthetic(el) {
    if (!el) return false;
    for (const [type, Ctor] of [
      ['pointerdown', PointerEvent], ['mousedown', MouseEvent],
      ['pointerup',   PointerEvent], ['mouseup',   MouseEvent],
      ['click',       MouseEvent],
    ]) {
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window }));
    }
    return true;
  }

  function clickNative(el) {
    if (!el) return false;
    if (typeof el.click === 'function') { el.click(); return true; }
    return false;
  }

  function setInputValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    input.dispatchEvent(new Event('blur',   { bubbles: true }));
  }

  async function openRenameMode(tr) {
    let editor = visibleRenameEditor(tr);
    if (editor) return editor;

    const trigger = rowDropdownInnerButton(tr);
    if (!trigger) throw new Error('No clickable dropdown button found');

    tr.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    await afterPaint();
    trigger.focus?.();
    clickSynthetic(trigger);

    const renameItem = await waitFor(findVisibleRenameMenuItem, 4000, 100);
    if (!renameItem) throw new Error('Rename menu item did not appear');

    clickNative(renameItem) || clickSynthetic(renameItem);

    editor = await waitFor(() => visibleRenameEditor(tr), 4000, 100);
    if (!editor) throw new Error('Inline rename editor did not appear');
    return editor;
  }

  async function waitForRowRename(tr, expectedName, oldName) {
    return waitFor(() => {
      const live = rowDisplayFilename(tr);
      if (!live) return false;
      if (live === expectedName) return true;
      if (live !== oldName && alreadyCompliant(live)) return true;
      return false;
    }, CFG.postRenameVerifyMs, 120);
  }

  async function renameOne(metaOverride = null) {
    reindexVisibleRows(document);
    const next = metaOverride || nextEligible();
    if (!next) {
      setBanner('No eligible visible HTML files right now. Scroll to load more.');
      return null;
    }

    const { tr, currentName, proposedName, modifiedText } = next;
    state.lastRename = next;

    const liveBefore    = rowDisplayFilename(tr);
    const liveIsGeneric = isGenericName(liveBefore);
    if (!liveBefore || (alreadyCompliant(liveBefore) && !liveIsGeneric)) {
      throw new Error('Row is no longer eligible by the time rename started');
    }

    setBanner(`Renaming: ${currentName} → ${proposedName}`);
    updatePanelStatus(`Renaming ${currentName}…`);

    const editor = await openRenameMode(tr);
    if (!editor.input)   throw new Error('Rename input not found');
    if (!editor.saveBtn) throw new Error('Save button not found');

    editor.input.focus();
    setInputValue(editor.input, proposedName);
    await sleep(150);

    clickNative(editor.saveBtn) || clickSynthetic(editor.saveBtn);
    await sleep(CFG.saveSettleMs);
    await afterPaint();

    const verified = await waitForRowRename(tr, proposedName, currentName);
    reindexVisibleRows(document);

    if (!verified) throw new Error('Save clicked but row text did not update');

    const liveAfter = rowDisplayFilename(tr);
    const logEntry  = {
      oldName:         currentName,
      newName:         liveAfter,
      modifiedText,
      path:            rowPath(tr) || '',
      renamedAt:       new Date().toISOString(),
      wasCompliant:    next.wasCompliant || false,
      wasGeneric:      next.generic      || false,
      hierarchy:       lookupHierarchyForFile(currentName) || '',
    };
    state.renameLog.push(logEntry);
    const msg = `Renamed: ${currentName} → ${liveAfter} (${modifiedText})`;
    setBanner(msg);
    dbg('renamed', logEntry);
    return { oldName: currentName, newName: liveAfter, modifiedText };
  }

  // ─── Scroll helper ──────────────────────────────────────────────────────────

  function findTableScroller() {
    const grid = document.getElementById('z_o');
    if (grid) {
      let el = grid.parentElement;
      while (el && el !== document.body) {
        const oy = getComputedStyle(el).overflowY;
        if (el.scrollHeight > el.clientHeight + 50 && (oy === 'auto' || oy === 'scroll' || oy === 'hidden'))
          return el;
        el = el.parentElement;
      }
      el = grid.parentElement;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 200) return el;
        el = el.parentElement;
      }
    }
    return window;
  }

  // Scrolls to the bottom repeatedly until no new rows appear between passes.
  // Returns the total number of rows seen after loading completes.
  async function scrollToBottom(onProgress) {
    const scroller = findTableScroller();
    let   prevSeen = -1;

    while (true) {
      const atBottom = scroller === window
        ? (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 50
        : scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 50;

      const nowSeen = state.seenRows.size;

      // Stop when we're at the bottom AND no new rows appeared since last pass
      if (atBottom && nowSeen === prevSeen) break;
      prevSeen = nowSeen;

      const top = scroller === window ? document.body.scrollHeight : scroller.scrollHeight;
      if (scroller === window) window.scrollTo({ top, behavior: 'smooth' });
      else scroller.scrollTo({ top, behavior: 'smooth' });

      await sleep(1200);
      await afterPaint();
      reindexVisibleRows(document);

      if (onProgress) onProgress(state.seenRows.size, visibleEligibleRows().length);
    }

    return state.seenRows.size;
  }

  // ─── Batch helpers ──────────────────────────────────────────────────────────

  // Lock guard: returns false and shows a banner if a batch is already running,
  // or if the hierarchy script hasn't finished loading yet.
  function acquireLock() {
    if (state.batchRunning) {
      setBanner('A batch is already running. Click Cancel to stop it first.');
      return false;
    }
    const hier = window.D2L_MF_HIER;
    if (!hier) {
      setBanner('D2L_MF_HIER not found — load the Content Hierarchy script first.');
      return false;
    }
    if (!hier.progress?.().doneDiscovering) {
      setBanner('Content hierarchy is still loading — wait for it to finish and try again.');
      return false;
    }
    state.batchRunning   = true;
    state.cancelRequested = false;
    updateCancelButton(true);
    updateObserverStatus();
    return true;
  }

  function releaseLock() {
    state.batchRunning   = false;
    state.cancelRequested = false;
    updateCancelButton(false);
    updateObserverStatus();
  }

  // ─── Rename fixed batch (1 / 5 / 10) ───────────────────────────────────────

  async function renameBatch(count = CFG.defaultBatchSize) {
    if (!acquireLock()) return [];
    const results = [];

    try {
      for (let i = 0; i < count; i++) {
        if (state.cancelRequested) {
          setBanner(`Cancelled after ${results.length} rename(s).`);
          break;
        }

        reindexVisibleRows(document);
        let next = nextEligible();

        if (!next) {
          setBanner(`No eligible rows visible — scrolling to load more…`);
          await scrollToBottom((seen) => setBanner(`Loading… ${seen} rows seen`));
          reindexVisibleRows(document);
          next = nextEligible();
          if (!next) {
            setBanner(`Stopped after ${results.length}: no more eligible rows found.`);
            break;
          }
        }

        next.tr.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        await afterPaint();

        const result = await renameOne(next);
        if (!result) break;
        results.push(result);
        state.lastBatch = results.slice();

        if (i < count - 1) {
          await sleep(CFG.batchDelayMs);
          reindexVisibleRows(document);
        }
      }

      if (!state.cancelRequested) {
        setBanner(
          results.length
            ? `Batch complete: ${results.length} file(s) renamed.`
            : 'No files were renamed in this batch.'
        );
      }
      return results;
    } catch (e) {
      warn('renameBatch failed', e);
      makeBanner(`Batch stopped: ${e.message}`, '#fdecea', '#a33', '#f5c2c0');
      updatePanelStatus(`Error: ${e.message}`);
      return results;
    } finally {
      state.lastBatch = results.slice();
      releaseLock();
    }
  }

  // ─── Rename all ─────────────────────────────────────────────────────────────
  //
  // Phase 1: scroll to the absolute bottom of the table, waiting for each
  //   lazy-load batch to settle, until no new rows appear.
  // Phase 2: rename in chunks of CFG.renameAllChunkSize, pausing between each
  //   to let D2L settle, until cancelled or no eligible rows remain.
  // Phase 3: auto-download the CSV report.

  async function renameAll() {
    if (!acquireLock()) return [];

    const allResults = [];
    let   chunkNum   = 0;

    try {
      // ── Phase 1: pre-scroll to load every row ──
      setBanner('Scrolling to load all rows before renaming…');
      reindexVisibleRows(document);
      await scrollToBottom((seen, eligible) => {
        setBanner(`Loading rows… ${seen} seen, ${eligible} eligible so far`);
      });
      const totalEligible = visibleEligibleRows().length;
      setBanner(`Loaded ${state.seenRows.size} rows — ${totalEligible} eligible. Starting renames…`);
      dbg('pre-scroll complete', { seen: state.seenRows.size, eligible: totalEligible });

      // ── Phase 2: chunked rename loop ──
      while (true) {
        // ── Check for cancellation at the top of every chunk ──
        if (state.cancelRequested) {
          setBanner(`Cancelled after ${allResults.length} rename(s).`);
          break;
        }

        // ── Reindex + find work for this chunk ──
        reindexVisibleRows(document);
        let eligible = visibleEligibleRows();

        if (!eligible.length) {
          setBanner(`All done — ${allResults.length} file(s) renamed.`);
          break;
        }

        chunkNum++;
        const chunkSize = Math.min(CFG.renameAllChunkSize, eligible.length);
        dbg(`chunk ${chunkNum}: ${chunkSize} renames, ${eligible.length} eligible visible`);

        // ── Run a single chunk ──
        const chunkResults = [];
        for (let i = 0; i < chunkSize; i++) {
          if (state.cancelRequested) break;

          reindexVisibleRows(document);
          const next = nextEligible();
          if (!next) break;

          next.tr.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
          await afterPaint();

          const result = await renameOne(next);
          if (!result) break;

          chunkResults.push(result);
          allResults.push(result);

          // Live progress in banner
          setBanner(`Renaming… ${allResults.length} done so far (chunk ${chunkNum}, ${i + 1}/${chunkSize})`);

          if (i < chunkSize - 1) {
            await sleep(CFG.batchDelayMs);
          }
        }

        state.lastBatch = allResults.slice();

        if (state.cancelRequested) {
          setBanner(`Cancelled after ${allResults.length} rename(s).`);
          break;
        }

        // ── If the chunk produced nothing, we're done ──
        if (!chunkResults.length) {
          setBanner(`All done — ${allResults.length} file(s) renamed.`);
          break;
        }

        // ── Inter-chunk pause and rescan ──
        updatePanelStatus(
          `Chunk ${chunkNum} complete (${chunkResults.length} renames). ` +
          `Total: ${allResults.length}. Pausing ${CFG.renameAllChunkPauseMs}ms…`
        );
        await sleep(CFG.renameAllChunkPauseMs);
        reindexVisibleRows(document);
      }

      // ── Phase 3: auto-download report ──
      if (allResults.length && !state.cancelRequested) {
        await sleep(400); // let final DOM settle before download
        downloadReport();
      }

      return allResults;
    } catch (e) {
      warn('renameAll failed', e);
      makeBanner(`Rename-all stopped: ${e.message}`, '#fdecea', '#a33', '#f5c2c0');
      updatePanelStatus(`Error: ${e.message}`);
      return allResults;
    } finally {
      state.lastBatch = allResults.slice();
      releaseLock();
      dbg('renameAll finished, total renamed:', allResults.length);
    }
  }

  // ─── Observer & reindex ─────────────────────────────────────────────────────

  function reindexVisibleRows(root = document) {
    for (const tr of allRows(root)) {
      const raw = rowRawValue(tr);
      if (!raw) continue;
      state.seenRows.set(raw, {
        raw,
        currentName: rowDisplayFilename(tr),
        path:        rowPath(tr),
        eligible:    !alreadyCompliant(rowDisplayFilename(tr)) && rowLooksHtml(tr),
        seenAt:      Date.now(),
      });
    }
    updateObserverStatus();
  }

  function updateObserverStatus() {
    const eligible  = visibleEligibleRows().length;
    const batchMsg  = state.batchRunning ? ' Running…' : '';
    updatePanelStatus(
      `Eligible: ${eligible} visible. Seen: ${state.seenRows.size} rows. Bursts: ${state.observerBursts}.${batchMsg}`
    );
  }

  function scheduleReindex(root = null) {
    if (state.pendingDebounce) clearTimeout(state.pendingDebounce);
    state.pendingDebounce = setTimeout(() => {
      state.pendingDebounce = null;
      reindexVisibleRows(root || state.observerRoot || document);
    }, CFG.observerDebounceMs);
  }

  function findObserverRoot() {
    const firstCb = document.querySelector(CFG.rowCheckboxSelector);
    if (!firstCb) return document.documentElement;
    const tr = firstCb.closest('tr');
    if (!tr) return document.documentElement;
    let el = tr.parentElement;
    while (el && el !== document.body) {
      if (el.querySelector?.(CFG.rowCheckboxSelector)) return el;
      el = el.parentElement;
    }
    return tr.parentElement || document.documentElement;
  }

  function installObserver() {
    if (state.observer) return;
    state.observerRoot = findObserverRoot();
    state.observer = new MutationObserver(mutations => {
      state.observerBursts++;
      let interesting = false;
      for (const m of mutations) {
        if (m.type !== 'childList' || !m.addedNodes?.length) continue;
        for (const n of m.addedNodes) {
          if (!(n instanceof Element)) continue;
          if (n.matches?.('tr') || n.querySelector?.(CFG.rowCheckboxSelector)) {
            interesting = true; break;
          }
        }
        if (interesting) break;
      }
      if (interesting) scheduleReindex();
    });
    state.observer.observe(state.observerRoot, { childList: true, subtree: true });
    dbg('observer installed on', state.observerRoot);
  }

  // ─── UI ─────────────────────────────────────────────────────────────────────

  function makeBanner(text, bg = '#e6fffa', fg = '#234e52', border = '#38b2ac') {
    document.getElementById(CFG.bannerId)?.remove();
    const b = document.createElement('div');
    b.id = CFG.bannerId;
    b.style.cssText = [
      'position:fixed;top:0;left:0;right:0;z-index:99999',
      `background:${bg};color:${fg};border-bottom:2px solid ${border}`,
      'padding:8px 14px;font:13px/1.4 sans-serif;box-sizing:border-box',
      'display:flex;gap:10px;align-items:center',
    ].join(';');
    b.innerHTML = `
      <span>🗂️</span>
      <span id="d2l-mf-rename-next-banner-text"></span>
      <button type="button" style="margin-left:auto;border:1px solid ${border};background:transparent;border-radius:4px;padding:2px 8px;cursor:pointer;">✕</button>
    `;
    b.querySelector('#d2l-mf-rename-next-banner-text').textContent = text;
    b.querySelector('button').addEventListener('click', () => b.remove());
    document.body.appendChild(b);
    return b;
  }

  function setBanner(text) {
    const el = document.getElementById(CFG.bannerId)
      ?.querySelector('#d2l-mf-rename-next-banner-text');
    if (el) el.textContent = text;
    else makeBanner(text);
  }

  function updatePanelStatus(text) {
    const el = document.querySelector('#d2l-mf-rename-next-status');
    if (el) el.textContent = text;
  }

  // Show/hide the Cancel button depending on whether a batch is running.
  function updateCancelButton(running) {
    const btn = document.querySelector('#d2l-mf-rename-cancel-btn');
    if (btn) btn.style.display = running ? '' : 'none';
  }

  function panelHtml() {
    return `
      <div style="font-weight:600;margin-bottom:6px;">Manage Files rename</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" data-act="preview"    class="mfr-btn">Preview next</button>
        <button type="button" data-act="rename1"    class="mfr-btn">Rename next</button>
        <button type="button" data-act="rename5"    class="mfr-btn">Rename next 5</button>
        <button type="button" data-act="rename10"   class="mfr-btn">Rename next 10</button>
        <button type="button" data-act="renameAll"  class="mfr-btn mfr-btn-primary">Rename all</button>
        <button type="button" data-act="rescan"        class="mfr-btn">Rescan</button>
        <button type="button" data-act="report"        class="mfr-btn mfr-btn-success">Download report</button>
        <button type="button" id="d2l-mf-rename-cancel-btn" class="mfr-btn mfr-btn-danger" style="display:none">Cancel</button>
      </div>
      <div id="d2l-mf-rename-next-status" style="margin-top:8px;font-size:12px;line-height:1.35;color:#4a5568;"></div>
    `;
  }

  function installPanel() {
    if (document.getElementById(CFG.panelId)) return;

    const panel = document.createElement('div');
    panel.id = CFG.panelId;
    panel.style.cssText = [
      'position:fixed;top:56px;right:12px;z-index:99999',
      'background:#ffffff;color:#1a202c;border:1px solid #cbd5e0',
      'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12)',
      'padding:10px;width:300px;font:13px/1.4 sans-serif',
    ].join(';');
    panel.innerHTML = panelHtml();
    document.body.appendChild(panel);

    // Style all buttons uniformly, with variants for primary/danger
    for (const btn of panel.querySelectorAll('.mfr-btn')) {
      let bg = '#edf2f7', border = '#a0aec0', color = '#2d3748';
      if (btn.classList.contains('mfr-btn-primary')) { bg = '#ebf8ff'; border = '#63b3ed'; color = '#2b6cb0'; }
      if (btn.classList.contains('mfr-btn-success')) { bg = '#f0fff4'; border = '#68d391'; color = '#276749'; }
      if (btn.classList.contains('mfr-btn-danger'))  { bg = '#fff5f5'; border = '#fc8181'; color = '#c53030'; }
      btn.style.cssText = `border:1px solid ${border};background:${bg};color:${color};border-radius:6px;padding:6px 10px;cursor:pointer;font:12px sans-serif;`;
    }

    // Wire up action buttons
    panel.querySelector('[data-act="preview"]').addEventListener('click', () => previewNext());
    panel.querySelector('[data-act="rename1"]').addEventListener('click', () => renameBatch(1));
    panel.querySelector('[data-act="rename5"]').addEventListener('click', () => renameBatch(5));
    panel.querySelector('[data-act="rename10"]').addEventListener('click', () => renameBatch(10));
    panel.querySelector('[data-act="renameAll"]').addEventListener('click', () => renameAll());
    panel.querySelector('[data-act="rescan"]').addEventListener('click', () => rescan());
    panel.querySelector('[data-act="report"]').addEventListener('click', () => downloadReport());
    panel.querySelector('#d2l-mf-rename-cancel-btn').addEventListener('click', () => {
      if (state.batchRunning) {
        state.cancelRequested = true;
        setBanner('Cancelling after current rename…');
        updatePanelStatus('Cancel requested — finishing current file…');
      }
    });
  }

  // ─── Actions ─────────────────────────────────────────────────────────────────

  function rescan() {
    reindexVisibleRows(document);
    const eligible = visibleEligibleRows();
    const next     = eligible[0] || null;
    if (next) {
      setBanner(`Rescan found ${eligible.length} eligible file(s). Next: ${next.currentName} → ${next.proposedName}`);
    } else {
      const totalHtml = allRows().filter(rowLooksHtml).length;
      setBanner(`Rescan complete — ${state.seenRows.size} rows seen, ${totalHtml} HTML files visible, none eligible (all already compliant or missing date?).`);
    }
  }

  async function previewNext() {
    reindexVisibleRows(document);
    let next = nextEligible();
    if (!next) {
      setBanner('Nothing visible — scrolling to load more rows…');
      await scrollToBottom((seen) => setBanner(`Loading… ${seen} rows seen`));
      reindexVisibleRows(document);
      next = nextEligible();
    }
    state.lastPreview = next || null;
    if (!next) {
      setBanner('No eligible visible HTML files right now. Scroll further and try again.');
      return null;
    }
    next.tr.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    await afterPaint();
    const msg = `Next: ${next.currentName} → ${next.proposedName} (${next.modifiedText})`;
    setBanner(msg);
    updatePanelStatus(msg);
    return next;
  }

  // ─── Report / CSV download ───────────────────────────────────────────────────
  //
  // Triggers a browser download of a CSV summarising all renames performed in
  // this page session.  If the D2L_MF_HIER script is also running, its fileMap
  // is used to attach a "Content hierarchy" column — no extra API calls needed.

  function lookupHierarchy(filename) {
    const hier = window.D2L_MF_HIER;
    if (!hier) return '';
    const fk      = (filename || '').toLowerCase();
    const entries = hier.getFileMap?.()?.get(fk) || [];
    return entries.map(e => e.hierarchy).filter(Boolean).join(' | ');
  }

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function downloadReport() {
    const log = state.renameLog;
    if (!log.length) {
      setBanner('Nothing to report — no renames recorded yet.');
      return;
    }

    const hierAvailable = !!(window.D2L_MF_HIER?.getFileMap);
    const headers = [
      'Old filename', 'New filename', 'Last modified', 'File path',
      'Renamed at', 'Previously renamed', 'Was generic',
    ];
    if (hierAvailable) headers.push('Content hierarchy');

    const rows = log.map(e => {
      // Hierarchy: prefer what was captured at rename time; fall back to live
      // lookup against the OLD name (the key that exists in fileMap).
      const hierarchy = e.hierarchy ||
        (hierAvailable ? (lookupHierarchy(e.oldName) || lookupHierarchy(e.newName)) : '');
      const cols = [
        e.oldName, e.newName, e.modifiedText, e.path, e.renamedAt,
        e.wasCompliant ? 'true' : 'false',
        e.wasGeneric   ? 'true' : 'false',
      ];
      if (hierAvailable) cols.push(hierarchy);
      return cols.map(csvEscape).join(',');
    });

    const csv  = [headers.map(csvEscape).join(','), ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);

    const now      = new Date();
    const ts       = now.toISOString().replace(/^20(\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*$/, '$1$2$3-$4$5$6');
    const ou       = (location.search.match(/[?&]ou=(\d+)/) || location.pathname.match(/\/(\d+)(?:\/|$)/) || [])[1] || 'unknown-ou';
    const rawTitle = document.querySelector('.d2l-navigation-s-link')?.textContent?.trim() || document.title.replace(/\s*[-|].*$/, '').trim();
    const safeName = rawTitle.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'course';
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = `${ou}-${safeName}-${ts}.csv`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);

    setBanner(`Report downloaded: ${log.length} rename(s)${hierAvailable ? ' with content hierarchy' : ''}.`);
    dbg('report downloaded', { rows: log.length, hierAvailable });
  }

  // ─── Public console API ──────────────────────────────────────────────────────

  function observeStatus() {
    return {
      root:             state.observerRoot,
      bursts:           state.observerBursts,
      seenRows:         state.seenRows.size,
      visibleEligible:  visibleEligibleRows().length,
      batchRunning:     state.batchRunning,
      cancelRequested:  state.cancelRequested,
      lastBatchCount:   state.lastBatch.length,
    };
  }

  window.D2L_MF_RENAME = {
    cfg:                 CFG,
    state,
    allRows,
    rowRawValue,
    rowPath,
    rowFilename,
    rowDisplayFilename,
    rowLastModifiedText,
    parseRowDateToYYMMDD,
    buildNewFilename,
    alreadyCompliant,
    visibleEligibleRows,
    nextEligible,
    previewNext,
    renameOne,
    renameBatch,
    renameAll,
    rescan,
    downloadReport,
    observeStatus,
  };

  // ─── Boot ─────────────────────────────────────────────────────────────────

  function init() {
    installPanel();
    makeBanner('Rename loaded. Preview first, then rename 1, 5, 10, or all.');
    reindexVisibleRows(document);
    installObserver();
    dbg('ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();