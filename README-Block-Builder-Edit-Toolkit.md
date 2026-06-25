# Block Builder Edit Toolkit

> **File:** `Block-Builder-Edit-Toolkit.user.js`  
> **Version:** 1.5

## Overview

A comprehensive in-editor toolkit for working with RCPI Block Builder components inside the Brightspace/D2L TinyMCE editor. Activated via Shift+right-click in the editor, it provides a floating panel with three tabs: **Components**, **Audit**, and **History**.

## Features

- **Shift+right-click context menu** for table colours/structure, wrap, convert, columns, row colour/insert, and icon swap
- **Components tab** — lists all Block Builder components on the current page with add-item (+1), delete, and duplicate buttons
- **Direct-write mode** — optionally writes changes straight through the TinyMCE API (no paste needed); falls back to clipboard copy when off
- **Component conversion** — converts between accordions, horizontal tabs, vertical tabs, and flipcards while preserving content
- **Audit tab** — scans for missing alt text, empty headings, fake headings (bold paragraphs), non-descriptive link text, and broken Bootstrap icon classes
- **History tab** — stores the last 6 components copied from the Block Builder for easy re-copy
- **Clipboard history** — WYSIWYG-safe HTML copies for paste into TinyMCE
- **Two-column templates** — converts a selected paragraph into a text+image or text+icon column layout

## Usage

Install via Tampermonkey. Open a Brightspace content page in edit mode. The BB Toolkit panel appears automatically. Use Shift+right-click inside the TinyMCE editor for the context menu.

## Notes

- Set `USETINYMCEAPI: true` in the CONFIG block only after verifying that direct writes save correctly on your instance.
- Set `DEBUG: false` to suppress verbose console logging once you are satisfied with behaviour.
- Matches `https://brightspace.rcpi.ie/d2l/le/lessons/*` and `/d2l/lms/content/*`.
