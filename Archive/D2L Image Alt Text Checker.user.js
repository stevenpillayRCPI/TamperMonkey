// ==UserScript==
// @name         D2L Image Alt Text Checker
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Check and display alt text from images in D2L iframe content
// @author       You
// @match        https://brightspace.rcpi.ie/d2l/le/lessons/*
// @match        https://brightspace.rcpi.ie/content/enforced/*
// @match        https://*.brightspace.com/*
// @match        https://*.d2l.com/*
// @include        https://brightspace.rcpi.ie/d2l/le/lessons/*
// @include        https://brightspace.rcpi.ie/content/enforced/*
// @include        https://*.brightspace.com/*
// @include        https://*.d2l.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    function checkImageAltText() {
        let altTextResults = [];

        // Function to check images in a given document/element
        function checkImagesInDocument(doc, context = "main page") {
            const images = doc.querySelectorAll('img');
            images.forEach((img, index) => {
                // Check if alt attribute exists at all
                const hasAltAttribute = img.hasAttribute('alt');
                const altText = img.getAttribute('alt') || "";
                const src = img.src || "No src";

                let issue = null;
                let severity = null;

                if (!hasAltAttribute) {
                    // Missing alt attribute entirely - screen reader will announce filename
                    issue = "Missing alt attribute";
                    severity = "error";
                } else if (altText.trim() === "") {
                    // Has alt attribute but it's empty - intentionally decorative
                    issue = "Empty alt attribute (decorative)";
                    severity = "info";
                } else {
                    // Has alt text - no issue
                    return;
                }

                altTextResults.push({
                    context: context,
                    index: index + 1,
                    src: src.substring(src.lastIndexOf('/') + 1) || src,
                    altText: altText,
                    issue: issue,
                    severity: severity,
                    hasAltAttribute: hasAltAttribute
                });
            });
        }

        // Check main document
        checkImagesInDocument(document, "Main Page");

        // Check all iframes
        function checkAllFrames() {
            const iframes = document.querySelectorAll('iframe');
            iframes.forEach((iframe, iframeIndex) => {
                try {
                    if (iframe.contentDocument) {
                        checkImagesInDocument(iframe.contentDocument, `Iframe ${iframeIndex + 1}`);
                    }
                } catch (e) {
                    console.log(`Cannot access iframe ${iframeIndex + 1} due to cross-origin policy`);
                }
            });
        }

        checkAllFrames();

        // Separate results by severity
        const errors = altTextResults.filter(r => r.severity === "error");
        const infos = altTextResults.filter(r => r.severity === "info");

        if (altTextResults.length > 0) {
            let message = "";

            if (errors.length > 0) {
                message += `🚫 MISSING ALT ATTRIBUTES (${errors.length}):\n`;
                message += "These images will have their filename announced by screen readers:\n\n";
                errors.forEach(result => {
                    message += `✗ [${result.context}] Image ${result.index}\n`;
                    message += `   File: ${result.src}\n`;
                    message += `   Issue: ${result.issue}\n\n`;
                });
            }

            if (infos.length > 0) {
                if (errors.length > 0) message += "\n" + "─".repeat(50) + "\n\n";
                message += `ℹ️ EMPTY ALT ATTRIBUTES (${infos.length}):\n`;
                message += "These are marked as decorative (alt=\"\") - OK if intentional:\n\n";
                infos.forEach(result => {
                    message += `○ [${result.context}] Image ${result.index}\n`;
                    message += `   File: ${result.src}\n`;
                    message += `   Status: Decorative image\n\n`;
                });
            }

            const notificationType = errors.length > 0 ? "error" : "info";
            showNotification(message, notificationType);
        }
    }

    // Create a notification with different styles for different severities
    function showNotification(message, type = "warning") {
        const notification = document.createElement('div');

        let bgColor, borderColor, headerText, headerIcon;

        switch(type) {
            case "error":
                bgColor = "#f8d7da";
                borderColor = "#f5c6cb";
                headerText = "Alt Attribute Issues";
                headerIcon = "🚫";
                break;
            case "info":
                bgColor = "#d1ecf1";
                borderColor = "#bee5eb";
                headerText = "Alt Attribute Info";
                headerIcon = "ℹ️";
                break;
            case "success":
                bgColor = "#d4edda";
                borderColor = "#c3e6cb";
                headerText = "Alt Attributes OK";
                headerIcon = "✅";
                break;
            default:
                bgColor = "#fff3cd";
                borderColor = "#ffeaa7";
                headerText = "Alt Attribute Check";
                headerIcon = "⚠️";
        }

        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            max-width: 450px;
            padding: 15px;
            background: ${bgColor};
            border: 1px solid ${borderColor};
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 10000;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            color: #333;
            max-height: 70vh;
            overflow-y: auto;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            font-weight: 600;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 14px;
        `;
        header.innerHTML = `
            <span>${headerIcon} ${headerText}</span>
            <button onclick="this.closest('div').remove()" style="
                background: none;
                border: none;
                font-size: 18px;
                cursor: pointer;
                padding: 0;
                line-height: 1;
                color: #666;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            ">×</button>
        `;

        const content = document.createElement('div');
        content.style.cssText = `
            white-space: pre-wrap;
            margin: 0;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.4;
            background: rgba(0,0,0,0.05);
            padding: 10px;
            border-radius: 4px;
        `;
        content.textContent = message;

        notification.appendChild(header);
        notification.appendChild(content);
        document.body.appendChild(notification);

        // Auto-remove after 45 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 45000);
    }

    // Wait for page to load then check images
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(checkImageAltText, 2000);
        });
    } else {
        setTimeout(checkImageAltText, 2000);
    }

    // Also check when navigating within the SPA
    let lastUrl = location.href;
    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            setTimeout(checkImageAltText, 3000);
        }
    }).observe(document, { subtree: true, childList: true });

    // Manual trigger with Ctrl+Alt+I
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.altKey && e.key === 'i') {
            checkImageAltText();
        }
    });
})();
