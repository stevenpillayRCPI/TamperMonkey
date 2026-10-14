// ==UserScript==
// @name         Envato Elements — Resize & Copy
// @namespace    rcpi-envato-tools
// @description  Adds a "Copy@1920" button to each Envato Elements card. On click it triggers the item's real download, intercepts the licensed file, copies a PNG resized to 1920px max-edge to the clipboard, and also saves the full-res original to disk.
// @match        https://elements.envato.com/*
// @match        https://app.envato.com/*
// @version      1.4
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      dam-assets.envatousercontent.com
// @connect      envatousercontent.com
// @connect      app.envato.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ─────────────────────────────────────────────────────────────────
  const MAX_EDGE = 1920;          // clipboard copy: resize down to this longest edge
  const SAVE_ORIGINAL = true;     // also save the untouched full-res file to disk
  const DEBUG = false;            // [ENV] console logging; flip on to debug
  const dbg = (...a) => { if (DEBUG) console.log('[ENV]', ...a); };

  // ─── PAGE-CONTEXT FETCH/XHR INTERCEPTION ────────────────────────────────────
  // The licensed download URL appears inside the JSON-ish response from
  // app.envato.com/download.data. Tampermonkey's sandbox means we must patch the
  // PAGE's fetch/XHR (unsafeWindow), not ours, to see the page's own calls. We do
  // this at document-start so the patch is in place before Envato's code runs.
  //
  // When a download.data response passes, we pull the signed dam-assets URL out
  // of the body and hand it to onDownloadUrl(). We DON'T block or alter Envato's
  // own download — it proceeds normally; we just observe the URL going past.

  const PW = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // Most-recent "intent": when the user clicks OUR button we set a flag so we
  // only run our pipeline for downloads the user asked us to handle (not every
  // download they do via Envato's own button). Cleared after a short window.
  let pendingIntent = null; // { uuid, type, at }
  function armIntent(uuid, type) {
    pendingIntent = { uuid, type, at: Date.now() };
    dbg('intent armed', uuid, type);
    // auto-disarm after 30s so a stale intent never hijacks a later manual download
    setTimeout(() => {
      if (pendingIntent && Date.now() - pendingIntent.at >= 30000) pendingIntent = null;
    }, 31000);
  }
  function consumeIntentIfAny() {
    const i = pendingIntent;
    pendingIntent = null;
    return i;
  }

  // Extract the signed dam-assets URL from a download.data response body.
  // Primary: find the literal "downloadUrl" marker and take the next token.
  // Fallback: regex for any dam-assets URL carrying a Signature= param.
  function extractDownloadUrl(text) {
    if (!text) return null;
    // Primary: "...","downloadUrl","https://...."  (turbo-stream-ish array)
    let m = text.match(/"downloadUrl"\s*,\s*"([^"]+)"/);
    if (m && m[1]) return decodeJsonString(m[1]);
    // Secondary: "downloadUrl":"https://..."  (plain JSON, just in case)
    m = text.match(/"downloadUrl"\s*:\s*"([^"]+)"/);
    if (m && m[1]) return decodeJsonString(m[1]);
    // Fallback: any signed dam-assets URL anywhere in the body
    m = text.match(/https:\/\/dam-assets\.envatousercontent\.com\/[^"'\\\s]+Signature=[^"'\\\s]+/);
    if (m && m[0]) return decodeJsonString(m[0]);
    return null;
  }
  // Response bodies may contain escaped slashes (\/) and unicode escapes.
  function decodeJsonString(s) {
    try { return JSON.parse('"' + s.replace(/"/g, '\\"') + '"'); }
    catch { return s.replace(/\\\//g, '/'); }
  }

  function isDownloadDataUrl(url) {
    return typeof url === 'string' && url.indexOf('download.data') !== -1;
  }

  function handleResponseText(url, text) {
    if (!isDownloadDataUrl(url)) return;
    const dl = extractDownloadUrl(text);
    dbg('download.data seen; extracted url?', !!dl);
    if (!dl) return;
    const intent = consumeIntentIfAny();
    if (!intent) {
      // The user downloaded via Envato's own button, not ours — leave it alone.
      dbg('no pending intent; ignoring this download.data');
      return;
    }
    onDownloadUrl(dl, intent);
  }

  // Patch fetch
  const origFetch = PW.fetch;
  if (typeof origFetch === 'function') {
    PW.fetch = function (...args) {
      const reqUrl = (args[0] && args[0].url) ? args[0].url : args[0];
      return origFetch.apply(this, args).then(res => {
        try {
          if (isDownloadDataUrl(String(reqUrl))) {
            // clone so we don't consume the body the page needs
            res.clone().text().then(t => handleResponseText(String(reqUrl), t)).catch(() => {});
          }
        } catch {}
        return res;
      });
    };
    dbg('fetch patched');
  }

  // Patch XMLHttpRequest
  const OrigXHR = PW.XMLHttpRequest;
  if (OrigXHR) {
    const open = OrigXHR.prototype.open;
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      this.__envUrl = url;
      return open.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.send = function (...a) {
      this.addEventListener('load', () => {
        try {
          if (isDownloadDataUrl(String(this.__envUrl))) {
            const t = this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : (typeof this.response === 'string' ? this.response : '');
            if (t) handleResponseText(String(this.__envUrl), t);
          }
        } catch {}
      });
      return send.apply(this, a);
    };
    dbg('XHR patched');
  }

  // ─── THE PIPELINE: fetch bytes → resize PNG → clipboard + save original ──────
  function onDownloadUrl(signedUrl, intent) {
    dbg('pipeline start', intent);
    toast('Fetching full-res image…', 'info');
    gmGetBlob(signedUrl)
      .then(async (blob) => {
        // 1) Resize to PNG at MAX_EDGE (dimension-only; never upscale).
        const pngBlob = await resizeToPngMaxEdge(blob, MAX_EDGE);
        // 2) Copy to clipboard FIRST, while the page still has focus. The disk
        //    save (an <a>.click) can steal focus, and clipboard.write() throws
        //    NotAllowedError if the document isn't focused — so copy before save.
        let copied = false;
        try {
          await copyPngToClipboard(pngBlob);
          copied = true;
        } catch (err) {
          // Recover: re-focus the window and retry once on the next tick.
          dbg('clipboard write failed, retrying after focus:', err && err.message);
          try {
            window.focus();
            await new Promise(r => setTimeout(r, 150));
            await copyPngToClipboard(pngBlob);
            copied = true;
          } catch (err2) {
            dbg('clipboard retry also failed:', err2 && err2.message);
          }
        }
        // 3) Save the untouched original to disk LAST (may take focus).
        if (SAVE_ORIGINAL) {
          const fname = filenameFromUrl(signedUrl) || `envato-${intent.uuid}.jpg`;
          saveBlob(blob, fname);
        }
        if (copied) {
          toast(`Copied @${MAX_EDGE}px to clipboard${SAVE_ORIGINAL ? ' · original saved' : ''}`, 'success');
        } else {
          toast(
            SAVE_ORIGINAL
              ? 'Clipboard blocked (click the page first), but original was saved'
              : 'Clipboard blocked — click the page, then try again',
            'error'
          );
        }
        dbg('pipeline done; copied=', copied, 'clipboard bytes:', pngBlob.size);
      })
      .catch(err => {
        console.error('[ENV] pipeline failed', err);
        toast('Copy failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
      });
  }

  // GM_xmlhttpRequest the signed URL as a blob. Bypasses CORS (privileged
  // request), so the resulting blob → object URL → <img> → canvas is never
  // tainted, and canvas.toBlob() works.
  function gmGetBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 60000,
        onload: r => {
          if (r.status >= 200 && r.status < 300 && r.response) resolve(r.response);
          else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout'))
      });
    });
  }

  function filenameFromUrl(url) {
    // The signed URL carries the descriptive name inside a content-disposition
    // parameter, but it's PERCENT-ENCODED within the query string, e.g.
    //   ...response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27macro-...-utc.jpg&Expires=...
    // So we must decode first, then pull out filename*=UTF-8''<name> (RFC 5987)
    // or a plain filename="<name>".
    try {
      const decoded = decodeURIComponent(url);
      // RFC 5987 extended form: filename*=UTF-8''<pct-encoded-name>
      let m = decoded.match(/filename\*\s*=\s*UTF-8''([^;&"]+)/i);
      if (m && m[1]) {
        // the name itself may still be percent-encoded
        try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
      }
      // plain form: filename="<name>" or filename=<name>
      m = decoded.match(/filename\s*=\s*"?([^;&"]+)"?/i);
      if (m && m[1]) return m[1].trim();
    } catch {}
    // Fallback: last path segment of the URL.
    try {
      const path = new URL(url).pathname;
      const seg = path.split('/').pop();
      if (seg) return seg;
    } catch {}
    return null;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    dbg('original saved as', filename);
  }

  // Resize down to maxEdge on the longest side; never upscale. Output PNG.
  // (PNG ignores any quality arg — this is dimension reduction only, by design.)
  function resizeToPngMaxEdge(blob, maxEdge) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { URL.revokeObjectURL(objUrl); reject(new Error('bad image dimensions')); return; }
        const longest = Math.max(w, h);
        const scale = longest > maxEdge ? maxEdge / longest : 1; // never > 1
        const tw = Math.round(w * scale), th = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = tw; canvas.height = th;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, tw, th);
        canvas.toBlob((out) => {
          URL.revokeObjectURL(objUrl);
          if (out) resolve(out);
          else reject(new Error('canvas.toBlob returned null'));
        }, 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('image decode failed')); };
      img.src = objUrl;
    });
  }

  async function copyPngToClipboard(pngBlob) {
    if (!navigator.clipboard || !window.isSecureContext) {
      throw new Error('clipboard API unavailable (needs https)');
    }
    await navigator.clipboard.write([ new ClipboardItem({ 'image/png': pngBlob }) ]);
  }

  // ─── CARD BUTTON INJECTION ──────────────────────────────────────────────────
  // Add a small "Copy@1920" button to each card. Keyed off [data-item-uuid]
  // (stable) with the item type from [data-analytics-item_type]. On click we arm
  // the intent, then click the card's own download button so Envato makes the
  // real download.data call — which our interceptor catches.

  function getCardInfo(card) {
    const uuid = card.getAttribute('data-item-uuid')
      || (card.querySelector('[data-analytics-item_id]') || {}).getAttribute?.('data-analytics-item_id')
      || altUuid(card);
    let type = null;
    const typed = card.querySelector('[data-analytics-item_type]');
    if (typed) type = typed.getAttribute('data-analytics-item_type');
    return { uuid, type };
  }
  function altUuid(card) {
    const img = card.querySelector('img[alt]');
    if (!img) return null;
    const m = (img.getAttribute('alt') || '').match(/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }
  function findCardDownloadButton(card) {
    return card.querySelector('[data-cy="item-action-download"]')
        || card.querySelector('[data-analytics-name="download"]');
  }

  function injectButton(card) {
    if (card.__envBtnAdded) return;
    const info = getCardInfo(card);
    if (!info.uuid) return; // can't identify the item
    const envDl = findCardDownloadButton(card);
    if (!envDl) return;     // no download button on this card; skip
    card.__envBtnAdded = true;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'env-copy-btn';
    btn.textContent = `Copy@${MAX_EDGE}`;
    btn.title = `Copy this image resized to ${MAX_EDGE}px to the clipboard, and save the original`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toast('Preparing copy…', 'info');
      // Make the download.data request OURSELVES (don't click Envato's button —
      // that would also trigger Envato's own download-to-disk, stealing focus
      // and duplicating the file). We fetch the signed URL, then run our pipeline
      // with full control over focus and saving.
      requestDownloadUrl(info.uuid, info.type || 'photos')
        .then(signedUrl => {
          if (!signedUrl) { toast('Could not get download URL for this item', 'error'); return; }
          onDownloadUrl(signedUrl, { uuid: info.uuid, type: info.type || 'photos' });
        })
        .catch(err => {
          console.error('[ENV] download.data request failed', err);
          toast('Download request failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
        });
    });

    // Float the button as an absolute overlay in the card's top-left corner so
    // it does NOT get inserted into Envato's own action-button row (which would
    // reflow their layout). We anchor to the card, ensuring it's positioned.
    const anchor = card.querySelector('[data-cy="item-card"]') || card;
    const cs = getComputedStyle(anchor);
    if (cs.position === 'static') anchor.style.position = 'relative';
    anchor.appendChild(btn);
  }

  // Make the download.data request directly and extract the signed URL, WITHOUT
  // triggering Envato's own download-to-disk. Uses the page's own fetch (via the
  // page context) so it carries session cookies. The endpoint shape was observed
  // in DevTools: app.envato.com/download.data?itemUuid=..&itemType=..&_routes=..
  // If Envato changes this, the page-fetch interceptor still works as a fallback
  // (the user could click Envato's own button), but this path avoids the dupe
  // download and focus theft entirely.
  function requestDownloadUrl(uuid, type) {
    const url = 'https://app.envato.com/download.data'
      + '?itemUuid=' + encodeURIComponent(uuid)
      + '&itemType=' + encodeURIComponent(type)
      + '&_routes=' + encodeURIComponent('routes/download/route');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        // download.data is a Remix data route. It commonly 403s unless the
        // request looks like the app's own fetch: a Remix marker header, an
        // explicit Accept, a same-site Referer/Origin, and fetch metadata.
        // GM_xmlhttpRequest doesn't set these automatically, so we add them.
        headers: {
          'Accept': '*/*',
          'X-Remix-Request': 'yes',
          'Referer': 'https://app.envato.com/' + encodeURIComponent(type),
          'Origin': 'https://app.envato.com',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'X-Requested-With': 'XMLHttpRequest'
        },
        onload: r => {
          if (r.status === 403 || r.status === 401) {
            dbg('download.data ' + r.status + ' — likely missing a required header/token. Response head:', (r.responseText || '').slice(0, 200));
            reject(new Error('HTTP ' + r.status + ' (auth/headers) — see console; may need header capture'));
            return;
          }
          if (r.status < 200 || r.status >= 300) { reject(new Error('HTTP ' + r.status)); return; }
          const dl = extractDownloadUrl(r.responseText || '');
          dbg('direct download.data; extracted url?', !!dl);
          resolve(dl);
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout'))
      });
    });
  }

  function scanCards(root) {
    (root || document).querySelectorAll('[data-item-uuid]').forEach(injectButton);
    // some layouts may not have data-item-uuid on the same node as the card;
    // also try item-card containers
    (root || document).querySelectorAll('[data-cy="item-card"]').forEach(ic => {
      const card = ic.closest('[data-item-uuid]') || ic.parentElement;
      if (card) injectButton(card);
    });
  }

  // ─── TOASTS ─────────────────────────────────────────────────────────────────
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'env-toast env-toast-' + (kind || 'info');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; }, 3200);
    setTimeout(() => t.remove(), 3800);
  }

  // ─── STYLES ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      .env-copy-btn{
        position: absolute; top: 6px; left: 6px; z-index: 6;
        font: 600 11px/1 system-ui, Arial, sans-serif;
        padding: 5px 8px;
        background: rgba(10,90,60,.92); color: #fff; border: none; border-radius: 5px;
        cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.35);
        opacity: 0; transition: opacity .15s ease;
        pointer-events: auto;
      }
      /* reveal on card hover so it doesn't clutter the grid */
      [data-cy="item-card"]:hover .env-copy-btn,
      [data-item-uuid]:hover .env-copy-btn{ opacity: 1; }
      .env-copy-btn:hover{ background: rgba(9,122,68,1); }
      .env-toast{
        position: fixed; bottom: 18px; right: 18px; z-index: 2147483647;
        background: #222; color: #fff; padding: 9px 13px; border-radius: 6px;
        font: 13px system-ui, Arial, sans-serif; box-shadow: 0 3px 12px rgba(0,0,0,.3);
        transition: opacity .4s ease; max-width: 360px;
      }
      .env-toast-success{ background: #0a5; }
      .env-toast-error{ background: #c0392b; }
      .env-toast-info{ background: #2c3e50; }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ─── BOOT ───────────────────────────────────────────────────────────────────
  function boot() {
    injectStyles();
    scanCards(document);
    // Envato is a SPA with lazy-loaded cards — observe DOM changes and re-scan.
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) {
            if (n.matches && (n.matches('[data-item-uuid]') || n.matches('[data-cy="item-card"]'))) {
              scanCards(n.parentElement || n);
            } else if (n.querySelector) {
              scanCards(n);
            }
          }
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    dbg('booted');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();