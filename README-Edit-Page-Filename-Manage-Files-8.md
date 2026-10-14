# Edit Page Filename & Manage Files

> **File:** `Edit-Page-Filename-Manage-Files.user-8.js`  
> **Version:** 6.2

## Overview

When editing a content topic in Brightspace, this script reads the topic's backend HTML filename from the D2L content API and displays it as a label beneath the page title field. It also injects a **Manage Files** button that opens the Manage Files popup pre-targeted to that file, working in conjunction with the companion **D2L Manage Files Locator** script.

## Features

- Fetches the real backend filename/path for the current topic using the documented `d2l/api/le` content-topic endpoint
- Displays the filename as a persistent label below the page title input
- Highlights generic filenames (e.g. `untitled.html`, `overview.html`) in amber as a warning
- Injects a **Manage Files** link that opens the popup and passes the file path to the companion Locator script via `localStorage`
- Self-heals the label if the Lit/Web Component title field re-renders (keeps the label visible across SPA navigation)
- Uses shadow DOM traversal to find the title host across Brightspace's Lit components
- Skips new-page contexts where no backend file exists yet

## Usage

Install via Tampermonkey alongside **D2L Manage Files Locator**. Open any existing content topic in edit mode. The backend filename appears below the title field with an optional Manage Files link.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- The Manage Files URL in this script and the match URL in the Locator must stay in sync.
- Does not run on new (unsaved) pages — only on existing topics with a known `topicId`.
