// ==UserScript==
// @name         Brightspace Nav Expander + Duplicate Highlighter
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Expands all nav items recursively and highlights duplicate object IDs
// @author       You
// @match        https://brightspace.rcpi.ie/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const POLL_INTERVAL = 50;        // ms between expanding each item
    const MUTATION_DEBOUNCE = 800;    // ms to wait after URL change before running
    const CHILD_WAIT_TIMEOUT = 50;   // ms to wait for children to appear
    const IFRAME_WAIT_TIMEOUT = 10000; // ms to wait for iframe to appear

    let isRunning = false;
    let lastUrl = location.href;
    let debounceTimer = null;

    const log  = (...a) => console.log('[NavExp]', ...a);
    const warn = (...a) => console.warn('[NavExp]', ...a);
    const err  = (...a) => console.error('[NavExp]', ...a);

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ─── Find the lessons iframe ──────────────────────────────────────────────

    function getLessonsIframe() {
        // The lessons app lives in an iframe whose src contains smart-curriculum or d2l/le/lessons
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const frame = iframes.find(f => {
            try {
                const doc = f.contentDocument || f.contentWindow.document;
                return !!(doc && doc.querySelector('.navigation-menu'));
            } catch (e) {
                return false;
            }
        });
        return frame || null;
    }

    function getIframeDoc() {
        const frame = getLessonsIframe();
        if (!frame) return null;
        try {
            return frame.contentDocument || frame.contentWindow.document;
        } catch (e) {
            return null;
        }
    }

    // Wait for the iframe and its nav tree to be ready
    async function waitForIframe(timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const doc = getIframeDoc();
            if (doc && doc.querySelector('.navigation-menu div[role="tree"]')) {
                log('iframe and nav tree ready');
                return doc;
            }
            await sleep(300);
        }
        warn('timed out waiting for iframe/nav tree');
        return null;
    }

    // ─── Nav tree helpers ─────────────────────────────────────────────────────

    function getNavTree(doc) {
        return doc.querySelector('.navigation-menu div[role="tree"]');
    }

    function getCollapsedBoxes(tree) {
        return Array.from(tree.querySelectorAll(
            '.unit-box[aria-expanded="false"], .lesson-box[aria-expanded="false"]'
        ));
    }

    // ─── Expansion ────────────────────────────────────────────────────────────

    function getTitle(box) {
        const el = box.querySelector('.title-text span');
        return el ? el.textContent.trim() : '(no title)';
    }

    // Fire a real keyboard ArrowRight on the focused box — this is what
    // Brightspace React listens for to expand without navigating.
    function expandByKeyboard(box, iframeWindow) {
        box.focus();
        const evt = new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            code: 'ArrowRight',
            keyCode: 39,
            which: 39,
            bubbles: true,
            cancelable: true,
            view: iframeWindow,
        });
        box.dispatchEvent(evt);
    }

    // Also try a direct click on the triangle icon as a fallback
    function expandByClick(box) {
        const triangle = box.querySelector('.module-triangle, d2l-icon.module-triangle');
        const target = triangle || box.querySelector('.title-container') || box;
        target.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
        }));
    }

    function waitForChildren(navItem, timeout) {
        return new Promise(resolve => {
            const start = navItem.querySelectorAll('.navigation-item').length;
            const deadline = Date.now() + timeout;
            const iv = setInterval(() => {
                const now = navItem.querySelectorAll('.navigation-item').length;
                if (now > start || Date.now() > deadline) {
                    clearInterval(iv);
                    resolve(now > start);
                }
            }, 150);
        });
    }

    async function expandAll(doc) {
        const iframeWindow = doc.defaultView;
        const tree = getNavTree(doc);
        if (!tree) { err('no nav tree'); return; }

        let passes = 0;
        const MAX_PASSES = 60;

        while (passes < MAX_PASSES) {
            const collapsed = getCollapsedBoxes(tree);
            if (collapsed.length === 0) {
                log('all expanded after', passes, 'passes');
                break;
            }

            log(`pass ${passes + 1}: ${collapsed.length} collapsed items`);

            for (const box of collapsed) {
                if (box.getAttribute('aria-expanded') !== 'false') continue;

                const title = getTitle(box);
                const navItem = box.closest('.navigation-item');

                log(`  expanding: "${title}"`);

                // Try keyboard first (preferred — no navigation side effect)
                expandByKeyboard(box, iframeWindow);
                await sleep(100);

                // Check immediately
                if (box.getAttribute('aria-expanded') === 'true') {
                    log(`  expanded via keyboard: "${title}"`);
                } else {
                    // Fall back to click
                    expandByClick(box);
                    await sleep(100);
                    log(`  after click: aria-expanded = ${box.getAttribute('aria-expanded')}`);
                }

                // Wait for children to load into DOM
                if (navItem) {
                    const gotChildren = await waitForChildren(navItem, CHILD_WAIT_TIMEOUT);
                    if (!gotChildren) {
                        log(`  no new children appeared for "${title}" (may be a leaf or already loaded)`);
                    }
                }

                await sleep(POLL_INTERVAL);
            }

            passes++;
        }

        if (passes >= MAX_PASSES) warn('hit MAX_PASSES — stopping');
    }

    // ─── Duplicate Detection ──────────────────────────────────────────────────

    function highlightDuplicates(doc) {
        const tree = getNavTree(doc);
        if (!tree) return;

        // Clear previous highlights
        tree.querySelectorAll('[data-navexp-highlight]').forEach(el => {
            el.style.outline = '';
            el.style.backgroundColor = '';
            el.removeAttribute('data-navexp-highlight');
            el.title = '';
        });

        const allNavItems = Array.from(tree.querySelectorAll('.navigation-item[data-objectid]'));
        log(`checking ${allNavItems.length} items for duplicates`);

        const idMap = {};
        allNavItems.forEach(item => {
            const id = item.getAttribute('data-objectid');
            if (!idMap[id]) idMap[id] = [];
            idMap[id].push(item);
        });

        let dupeCount = 0;
        Object.entries(idMap).forEach(([id, items]) => {
            if (items.length < 2) return;
            dupeCount++;
            const titles = items.map(item => {
                const el = item.querySelector('.title-text span');
                return el ? el.textContent.trim() : '?';
            });
            log(`  DUPLICATE id=${id} (×${items.length}): ${titles.join(' | ')}`);

            items.forEach(item => {
                const box = item.querySelector('.unit-box, .lesson-box, .topic-box');
                if (box) {
                    box.style.outline = '3px solid red';
                    box.style.outlineOffset = '-3px';
                    box.setAttribute('data-navexp-highlight', id);
                    box.title = `⚠ Duplicate object ID: ${id} — also appears as: ${titles.filter(t => t !== (item.querySelector('.title-text span') || {}).textContent?.trim()).join(', ')}`;
                }
            });
        });

        if (dupeCount === 0) {
            log('no duplicate object IDs found');
        } else {
            log(`highlighted ${dupeCount} duplicate IDs`);
        }
    }

    // ─── Main ─────────────────────────────────────────────────────────────────

    async function run() {
        if (isRunning) { warn('already running, skipping'); return; }
        if (!location.href.includes('/d2l/le/lessons/')) {
            log('not a lessons page, skipping');
            return;
        }

        isRunning = true;
        log('run() started — waiting for iframe...');

        try {
            const doc = await waitForIframe(IFRAME_WAIT_TIMEOUT);
            if (!doc) { err('could not find lessons iframe'); return; }

            log('starting expansion');
            await expandAll(doc);

            log('expansion done — checking for duplicates');
            highlightDuplicates(doc);

            log('all done ✓');
        } catch (e) {
            err('unexpected error:', e);
        } finally {
            isRunning = false;
        }
    }

    // ─── URL change detection ─────────────────────────────────────────────────

    function onUrlChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        log('URL changed to', location.href);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(run, MUTATION_DEBOUNCE);
    }

    const _push = history.pushState.bind(history);
    history.pushState = function (...args) { _push(...args); onUrlChange(); };

    const _replace = history.replaceState.bind(history);
    history.replaceState = function (...args) { _replace(...args); onUrlChange(); };

    window.addEventListener('popstate', onUrlChange);

    // Watch for the iframe being added/replaced (covers initial load and
    // Brightspace swapping the iframe on course navigation)
    new MutationObserver(() => onUrlChange()).observe(document.body, {
        childList: true,
        subtree: false,
    });

    // Initial run
    log('script loaded, readyState =', document.readyState);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
    } else {
        run();
    }

})();