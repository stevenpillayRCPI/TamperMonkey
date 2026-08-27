# RCPI Block Builder Standalone

> **File:** `RCPI-Block-Builder-Standalone.user-11.js`  
> **Version:** 2.0

## Overview

Adds a persistent **Block Builder** side panel and floating action button (FAB) to the Brightspace content editor, independent of the Edit Toolkit. The panel loads the RCPI Block Builder tool in an iframe alongside the TinyMCE editor, so you can drag components directly into the editor without switching pages.

## Features

- Floating **Block Builder** button (FAB) pinned to the bottom-right of the editor page
- Opens a resizable side panel (420–92% of viewport width) loading the Block Builder in an iframe
- Panel width is persisted in `localStorage` and restored on next open
- Width can be adjusted via an input field in the panel header
- Closes automatically on SPA navigation to a different topic
- Escape key closes the panel
- Window resize re-clamps the stored width to valid bounds

## Usage

Install via Tampermonkey. Open a content topic in edit mode on `brightspace.rcpi.ie`. Click the **Block Builder** button at the bottom right to open the side panel. Drag components from the panel into the editor.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/le/lessons/*/edit` and `/d2l/lms/content/*/edit`.
- The Block Builder URL is hardcoded to the RCPI course redesign HTML file — update `BLOCKBUILDERURL` if the source file moves.
