# RCPI Brightspace Audit Toolkit

> **File:** `RCPI-Brightspace-Audit-Toolkit.user-17.js`  
> **Version:** 3.1

## Overview

A full content-editing suite for the Brightspace TinyMCE editor, accessed via a floating action button (FAB). Provides link/image checking, DOI/PMID lookup, WCAG 2.1 AA accessibility auditing, find-and-replace with undo, URL linting, a before-save intercept, and CSV/Markdown export — all in a resizable side panel.

## Features

- **Link & Image Checker** — probes all links and images for 404s, redirects, mixed content, and oversized images; HEAD-first with GET fallback; per-host throttling
- **DOI / PMID Lookup** — resolves DOIs and PubMed IDs to full citations with confidence scores; auto-runs on page load
- **Accessibility (WCAG 2.1 AA)** — checks alt text, heading structure, non-descriptive links, colour contrast, empty elements, fake headings, table accessibility, language attribute, duplicate IDs, and more; one-click auto-fixes for common issues
- **Find & Replace** — rule-based URL and text replacement with dry-run preview, per-session undo stack, and CSV export
- **URL Linter** — detects and auto-fixes malformed URLs (doubled schemes, stray brackets, whitespace, trailing punctuation)
- **Before-Save Intercept** — shows a confirmation dialog if accessibility errors/warnings are found when clicking Save
- **Settings tab** — configurable thresholds (image size/width), ignore-list for domains, probe behaviour, and keyboard shortcut
- **Keyboard shortcut** — Alt+Shift+E opens the panel
- CSV and Markdown export for all audit results

## Usage

Install via Tampermonkey (requires `GM_xmlhttpRequest`, `GM_getValue`/`GM_setValue`, `unsafeWindow`). Open any content topic in edit mode. Click the green **✓** FAB at the bottom right, or press **Alt+Shift+E**.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/le/lessons/*/edit` and `/d2l/lms/content/*/edit`.
- The Link Checker `autoRunPageLoad` is off by default to avoid hammering external servers on every page open — enable in Settings if desired.
- All settings and ignore-list entries are persisted via `GM_getValue`/`GM_setValue`.
