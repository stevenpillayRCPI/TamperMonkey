// ==UserScript==
// @name         RCPI Staff Login Button Clicker
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Automatically clicks the RCPI Staff Login button
// @author       You
// @match        https://iam.rcpi.ie/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=rcpi.ie
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Function to find and click the button
    function clickLoginButton() {
        const button = document.querySelector('#IdPAzureActiveDirectoryExchange');
        if (button) {
            button.click();
            console.log('RCPI Staff Login button clicked!');
            return true;
        }
        return false;
    }

    // Try to click immediately in case the button is already loaded
    if (clickLoginButton()) {
        return;
    }

    // If button wasn't found, wait for it to appear
    const observer = new MutationObserver(function(mutations, obs) {
        if (clickLoginButton()) {
            obs.disconnect(); // Stop observing once button is clicked
        }
    });

    // Start observing the document with the configured parameters
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Fallback: try again after a short delay
    setTimeout(function() {
        if (clickLoginButton()) {
            observer.disconnect();
        }
    }, 2000);
})();
