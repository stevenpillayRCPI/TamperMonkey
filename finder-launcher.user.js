// ==UserScript==
// @name         Finder launcher (RCPI Brightspace)
// @namespace    https://brightspace.rcpi.ie/
// @version      1.4.0
// @updateURL    https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/Finder.js
// @downloadURL  https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/Finder.js
// @description  Adds a "Finder" tab on the left edge of every Brightspace page that opens the Finder widget in a popup.
// @match        https://brightspace.rcpi.ie/*
// @exclude      https://brightspace.rcpi.ie/shared/Widgets/*
// @noframes
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // ---- Settings -----------------------------------------------------------
  // Path of the widget page in Manage Files (same one the homepage iframe uses).
  const TOOLKIT_URL = "/shared/Widgets/LT%20Toolkit/lt-toolkit.html";
  const ICON_URL = "/shared/Widgets/LT%20Toolkit/Finder.png";
  const BUTTON_LABEL = "Finder";
  const ICON_SIZE = 40;   // px — size of the icon on the left edge
  const SHORTCUT = { altKey: true, key: "l" };   // Alt+L toggles the popup
  const POPUP_WIDTH = "min(1000px, 94vw)";
  const POPUP_HEIGHT = "min(820px, 90vh)";
  // -------------------------------------------------------------------------

  if (document.getElementById("lt-launch-btn")) return;

  const Z = 2147483000;
  const css = `
    #lt-launch-btn {
      position: fixed; left: 0; top: 50%; transform: translateY(-50%);
      z-index: ${Z}; display: flex; align-items: center; justify-content: center;
      padding: 6px 6px 6px 4px; border: 0; border-radius: 0 10px 10px 0;
      background: #fff; cursor: pointer; line-height: 0;
      box-shadow: 2px 0 10px rgba(0,0,0,.25); opacity: .9; transition: opacity .15s, padding .15s;
    }
    #lt-launch-btn img { width: ${ICON_SIZE}px; height: ${ICON_SIZE}px; object-fit: contain; display: block; }
    #lt-launch-btn.no-icon { writing-mode: vertical-rl; padding: 12px 7px; background: #006fbf; color: #fff;
      font: 600 13px/1 "Lato", "Segoe UI", Arial, sans-serif; }
    #lt-launch-btn:hover, #lt-launch-btn:focus-visible { opacity: 1; padding-left: 8px; outline: none; }
    #lt-launch-btn:focus-visible { box-shadow: 0 0 0 3px #006fbf; }
    #lt-overlay {
      position: fixed; inset: 0; z-index: ${Z + 1}; display: none;
      background: rgba(15, 23, 42, .45); align-items: center; justify-content: center;
    }
    #lt-overlay.open { display: flex; }
    #lt-popup {
      width: ${POPUP_WIDTH}; height: ${POPUP_HEIGHT}; display: flex; flex-direction: column;
      background: #fff; border-radius: 10px; overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
      font: 14px/1.4 "Lato", "Segoe UI", Arial, sans-serif; color: #1f2933;
    }
    #lt-popup header {
      display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px;
      border-bottom: 1px solid #d9e2ec; background: #f5f7fa;
    }
    #lt-popup header strong { flex: 1; font-size: 15px; display: flex; align-items: center; gap: 8px; }
    #lt-popup header strong img { width: 22px; height: 22px; object-fit: contain; }
    #lt-popup header button {
      border: 1px solid #d9e2ec; background: #fff; border-radius: 6px;
      padding: 4px 10px; cursor: pointer; font: inherit; color: inherit;
    }
    #lt-popup header button:hover { background: #e4e7eb; }
    #lt-popup iframe { flex: 1; width: 100%; border: 0; }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "lt-launch-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", `Open ${BUTTON_LABEL}`);
  const icon = new Image();
  icon.src = ICON_URL;
  icon.alt = "";
  // If the icon can't load, fall back to a text tab so the button never disappears
  icon.onerror = () => { btn.classList.add("no-icon"); btn.textContent = BUTTON_LABEL; };
  btn.appendChild(icon);
  btn.title = `Open ${BUTTON_LABEL} (Alt+L)`;

  const overlay = document.createElement("div");
  overlay.id = "lt-overlay";
  overlay.innerHTML = `
    <div id="lt-popup" role="dialog" aria-modal="true" aria-label="${BUTTON_LABEL}">
      <header>
        <strong><img src="${ICON_URL}" alt="">${BUTTON_LABEL}</strong>
        <button type="button" data-act="reload" title="Reload Finder">Reload</button>
        <button type="button" data-act="tab" title="Open in a new tab">Open in tab ↗</button>
        <button type="button" data-act="close" title="Close (Esc)">✕</button>
      </header>
    </div>`;
  const popup = overlay.querySelector("#lt-popup");
  const headIcon = overlay.querySelector("header strong img");
  headIcon.addEventListener("error", () => headIcon.remove());
  let frame = null; // created on first open, then kept so searches survive closing

  function open() {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.src = TOOLKIT_URL;
      frame.title = BUTTON_LABEL;
      popup.appendChild(frame);
    }
    overlay.classList.add("open");
    frame.focus();
  }
  function close() {
    overlay.classList.remove("open");
    btn.focus();
  }
  const isOpen = () => overlay.classList.contains("open");

  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("header").addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "close") close();
    if (act === "reload" && frame) frame.src = TOOLKIT_URL;
    if (act === "tab") { window.open(TOOLKIT_URL, "_blank", "noopener"); close(); }
  });

  function onKey(e) {
    if (e.key === "Escape" && isOpen()) { close(); return; }
    if (e.altKey === SHORTCUT.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === SHORTCUT.key) {
      e.preventDefault();
      isOpen() ? close() : open();
    }
  }
  document.addEventListener("keydown", onKey);

  // Same-origin, so Esc / Alt+L also work while focus is inside the toolkit
  function hookFrameKeys() {
    try { frame.contentWindow.document.addEventListener("keydown", onKey); } catch { /* ignore */ }
  }
  new MutationObserver(() => {
    if (frame && !frame.dataset.hooked) {
      frame.dataset.hooked = "1";
      frame.addEventListener("load", hookFrameKeys);
    }
  }).observe(popup, { childList: true });

  document.body.appendChild(btn);
  document.body.appendChild(overlay);
})();