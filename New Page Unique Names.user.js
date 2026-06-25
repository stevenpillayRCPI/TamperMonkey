// ==UserScript==
// @name         New Page Unique Names
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  On NEW pages only: slugifies filename on first save with date+uid, restores visible title, then completes original action.
// @match        https://brightspace.rcpi.ie/*
// @grant        none
// ==/UserScript==
(function () {
  'use strict';

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

})();