// ==UserScript==
// @name         Brightspace Agent Subject Editor
// @namespace    http://tampermonkey.net/
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/brightspace-agent-subject-editor.user.js
// @downloadURL  https://raw.githubusercontent.com/stevenpillayRCPI/TamperMonkey/refs/heads/main/brightspace-agent-subject-editor.user.js
// @description  Edits the email subject in Brightspace Intelligent Agents
// @author       Your Name
// @match        https://brightspace.rcpi.ie/d2l/le/intelligentagents/agent/*/Edit*
// @icon         https://www.rcpi.ie/wp-content/uploads/2020/01/cropped-favicon-32x32.png
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Check if the URL contains "Edit?agentId="
    if (window.location.href.includes('Edit?agentId=')) {
        // Target the subject input field
        const targetId = 'actionsData$EmailSubject';

        // New subject text (customize this value)
        const newSubject = 'Reminder: Your Tutorial Session for {OrgUnitName} is Approaching';

        // Function to modify the subject field
        function modifySubject() {
            const subjectInput = document.getElementById(targetId);
            if (subjectInput) {
                subjectInput.value = newSubject;
                console.log('Subject field updated successfully');
                return true;
            }
            return false;
        }

        // Try immediately or wait for DOM load
        if (!modifySubject()) {
            const observer = new MutationObserver(() => {
                if (modifySubject()) {
                    observer.disconnect();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }
    }
})();
