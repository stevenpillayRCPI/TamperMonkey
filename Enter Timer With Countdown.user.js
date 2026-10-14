// ==UserScript==
// @name         Enter Timer With Countdown
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Shows a countdown and presses Enter on the currently focused element
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const HOURS = 0;
    const MINUTES = 25;
    const SECONDS = 0;

    let totalSeconds = (HOURS * 3600) + (MINUTES * 60) + SECONDS;

    if (totalSeconds <= 0) {
        console.log('Timer must be greater than 0.');
        return;
    }

    const box = document.createElement('div');
    box.id = 'tm-enter-timer-box';
    box.style.position = 'fixed';
    box.style.top = '12px';
    box.style.right = '12px';
    box.style.zIndex = '999999';
    box.style.background = 'rgba(20,20,20,0.9)';
    box.style.color = '#fff';
    box.style.padding = '10px 14px';
    box.style.borderRadius = '8px';
    box.style.fontFamily = 'Arial, sans-serif';
    box.style.fontSize = '14px';
    box.style.lineHeight = '1.4';
    box.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    box.style.minWidth = '180px';

    document.body.appendChild(box);

    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;

        return [
            String(h).padStart(2, '0'),
            String(m).padStart(2, '0'),
            String(s).padStart(2, '0')
        ].join(':');
    }

    function getFocusedLabel(el) {
        if (!el) return 'none';
        const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '';
        return `${tag}${id}${cls}`;
    }

    function render() {
        const focused = document.activeElement;
        box.innerHTML = `
            <div style="font-weight:bold; margin-bottom:4px;">Enter timer active</div>
            <div>Time left: ${formatTime(totalSeconds)}</div>
            <div style="opacity:0.8; margin-top:4px;">Focus: ${getFocusedLabel(focused)}</div>
        `;
    }

    function pressEnter(target) {
        target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        }));

        target.dispatchEvent(new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
        }));
    }

    render();

    const timer = setInterval(() => {
        totalSeconds--;
        render();

        if (totalSeconds <= 0) {
            clearInterval(timer);

            const target = document.activeElement;

            if (target && target !== document.body) {
                pressEnter(target);
                box.innerHTML = `<div style="font-weight:bold;">Enter sent</div><div>Target: ${getFocusedLabel(target)}</div>`;
            } else {
                box.innerHTML = `<div style="font-weight:bold;">Timer done</div><div>No focused element found</div>`;
            }

            setTimeout(() => {
                box.remove();
            }, 5000);
        }
    }, 1000);
})();