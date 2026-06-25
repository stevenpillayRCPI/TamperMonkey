// ==UserScript==
// @name        Heading & Alt Checker
// @match       https://brightspace.rcpi.ie/content/*
// @grant       none
// ==/UserScript==

(function() {
    // Check heading order
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    let levels = headings.map(h => parseInt(h.tagName.slice(1), 10));
    let last = null;
    let skipped = false;
    for (const lvl of levels) {
        if (last !== null && lvl > last + 1) {
            skipped = true;
            break;
        }
        last = lvl;
    }
    const headingStatus = skipped ? '❌ Headings skipped' : '✔️ Headings ok';

    // Count images
    const images = document.querySelectorAll('img');
    const imageCount = images.length;

    // Console logs for images with preview
    images.forEach(img => {
        if (!img.alt || img.alt.trim() === "") {
            console.log('%c❗️ EMPTY ALT: %c', 'color: red; font-weight: bold;', '', img);
        } else {
            console.log('Alt text:', img.alt, img);
        }
    });

    // Create and show popup
    const popup = document.createElement('div');
    popup.textContent = `${headingStatus} | Images: ${imageCount}`;
    Object.assign(popup.style, {
        position: 'fixed',
        top: '10px',
        right: '10px',
        backgroundColor: '#222',
        color: '#eee',
        padding: '10px 15px',
        fontSize: '14px',
        borderRadius: '5px',
        boxShadow: '0 0 10px rgba(0,0,0,0.5)',
        zIndex: 99999,
        opacity: '0.9',
        fontFamily: 'Arial, sans-serif',
    });
    document.body.appendChild(popup);

    // Auto-hide after 5 seconds
    setTimeout(() => {
        popup.style.transition = 'opacity 1s ease';
        popup.style.opacity = '0';
        setTimeout(() => popup.remove(), 1000);
    }, 2000);
})();