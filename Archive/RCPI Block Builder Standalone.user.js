// ==UserScript==
// @name         RCPI Block Builder Standalone
// @namespace    rcpi-block-builder
// @description  Standalone Block Builder pane for Brightspace, independent of the Edit Toolkit FAB.
// @match        https://brightspace.rcpi.ie/d2l/le/lessons/*/edit/*
// @match        https://brightspace.rcpi.ie/d2l/lms/content/*/edit/*
// @version      2.0
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BLOCK_BUILDER_URL =
    'https://brightspace.rcpi.ie/content/enforced/11796-COURSEREDESIGN_06JAN2024/RCPI-BS-Block-Builder.html';

  const STORAGE_KEY = 'rcpi-block-builder-width';
  const MIN_WIDTH = 420;
  const MAX_WIDTH_RATIO = 0.92;
  const DEFAULT_WIDTH = 770;

  let bbPanelEl = null;
  let lastUrl = location.pathname + location.search;
  let currentWidth = loadSavedWidth();

  function defaultWidth() {
    return Math.min(DEFAULT_WIDTH, Math.max(600, Math.round(window.innerWidth * 0.5)));
  }

  function clampWidth(w) {
    const n = parseInt(w, 10);
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_RATIO));
    if (Number.isNaN(n)) return defaultWidth();
    return Math.max(MIN_WIDTH, Math.min(n, max));
  }

  function loadSavedWidth() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return clampWidth(saved);
    } catch (e) {}
    return defaultWidth();
  }

  function saveWidth(width) {
    try {
      localStorage.setItem(STORAGE_KEY, String(width));
    } catch (e) {}
  }

  function injectStyles() {
    if (document.getElementById('rcpi-block-builder-style')) return;

    const style = document.createElement('style');
    style.id = 'rcpi-block-builder-style';
    style.textContent = `
    .rcpi-bb-pane { z-index: 2001 !important; }
.rcpi-bb-fab  { z-index: 2000 !important; }

      .rcpi-bb-fab {
        position: fixed !important;
        bottom: 18px !important;
        right: 170px !important;
        z-index: 2000 !important;
      }

      .rcpi-bb-fab button {
        padding: 9px 14px;
        border-radius: 6px;
        border: 2px solid #fff;
        background: #057;
        color: #fff;
        cursor: pointer;
        font: 13px system-ui, Arial, sans-serif;
        box-shadow: 0 2px 8px rgba(0,0,0,.3);
        white-space: nowrap;
      }

      .rcpi-bb-pane {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        background: #fff;
        z-index: 2001 !important;
        display: flex;
        flex-direction: column;
        box-shadow: -6px 0 32px rgba(0,0,0,.25);
        font: 13px/1.4 system-ui, Arial, sans-serif;
        border-left: 1px solid #d0d0d0;
      }

      .rcpi-bb-pane .rcpi-hd {
        padding: 12px 16px;
        border-bottom: 1px solid #e2e2e2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex: 0 0 auto;
      }

      .rcpi-bb-pane .rcpi-hd h2 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      .rcpi-bb-head {
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1 1 auto;
        min-width: 0;
      }

      .rcpi-bb-size {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
        color: #555;
        font-size: 12px;
        white-space: nowrap;
      }

      .rcpi-bb-size input {
        width: 74px;
        padding: 4px 6px;
        border: 1px solid #bbb;
        border-radius: 4px;
        font: inherit;
        font-size: 12px;
        line-height: 1.2;
      }

      .rcpi-bb-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
      }

      .rcpi-bb-pane .rcpi-bd {
        flex: 1;
        overflow: hidden;
        padding: 0 !important;
      }

      .rcpi-bb-frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: #fff;
      }

      .rcpi-btn {
        padding: 6px 12px;
        border: 1px solid #0a5;
        background: #0a5;
        color: #fff;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
      }

      .rcpi-btn.sec {
        background: #fff;
        color: #333;
        border-color: #bbb;
      }
    `;
    document.head.appendChild(style);
  }

  function closeBlockBuilderPanel() {
    if (!bbPanelEl) return;
    bbPanelEl.remove();
    bbPanelEl = null;
  }

  function applyPaneWidth(pane, input, value) {
    const width = clampWidth(value);
    currentWidth = width;
    saveWidth(width);
    pane.style.width = `${width}px`;
    if (input) input.value = String(width);
  }


  function openBlockBuilderPanel() {
    if (bbPanelEl) {
      closeBlockBuilderPanel();
      return;
    }

    const pane = document.createElement('div');
    pane.className = 'rcpi-bb-pane';
    pane.style.width = `${clampWidth(currentWidth)}px`;
    bbPanelEl = pane;

    pane.innerHTML = `
      <div class="rcpi-hd">
        <div class="rcpi-bb-head">
          <h2>Block Builder</h2>
          <label class="rcpi-bb-size">
            Width
            <input type="text" value="${clampWidth(currentWidth)}" inputmode="numeric" />
            <span>px</span>
            <button type="button" class="rcpi-btn sec" data-apply-width>Set</button>
          </label>
        </div>
        <div class="rcpi-bb-actions">
          <button class="rcpi-btn sec" data-close>Close</button>
        </div>
      </div>
      <div class="rcpi-bd">
        <iframe
          class="rcpi-bb-frame"
          src="${BLOCK_BUILDER_URL}"
          allowfullscreen
        ></iframe>
      </div>
    `;

    const closeBtn = pane.querySelector('[data-close]');
    const widthInput = pane.querySelector('.rcpi-bb-size input');
    const applyBtn = pane.querySelector('[data-apply-width]');

    closeBtn.addEventListener('click', closeBlockBuilderPanel);

    applyBtn.addEventListener('click', () => {
      applyPaneWidth(pane, widthInput, widthInput.value);
    });

    widthInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyPaneWidth(pane, widthInput, widthInput.value);
      }
    });

    widthInput.addEventListener('blur', () => {
      applyPaneWidth(pane, widthInput, widthInput.value);
    });

    document.body.appendChild(pane);
  }

  function mountBlockBuilderFab() {
    if (document.querySelector('.rcpi-bb-fab')) return;

    const fab = document.createElement('div');
    fab.className = 'rcpi-bb-fab';
    fab.innerHTML = `<button type="button">Block Builder</button>`;

    fab.querySelector('button').addEventListener('click', openBlockBuilderPanel);
    document.body.appendChild(fab);
  }

  function ensureMounted() {
    injectStyles();
    mountBlockBuilderFab();
  }

  ensureMounted();

  const mountTimer = setInterval(() => {
    ensureMounted();
  }, 800);

  const urlWatcher = setInterval(() => {
    const nowUrl = location.pathname + location.search;
    if (nowUrl !== lastUrl) {
      lastUrl = nowUrl;
      closeBlockBuilderPanel();
      setTimeout(ensureMounted, 600);
    }
  }, 500);

  window.addEventListener('resize', () => {
    currentWidth = clampWidth(currentWidth);
    saveWidth(currentWidth);
    if (bbPanelEl) {
      const input = bbPanelEl.querySelector('.rcpi-bb-size input');
      applyPaneWidth(bbPanelEl, input, currentWidth);
    }
  });

  window.addEventListener('beforeunload', () => {
    clearInterval(mountTimer);
    clearInterval(urlWatcher);
  });
    document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (bbPanelEl) {
    bbPanelEl.remove();
    bbPanelEl = null;
  }
});

})();