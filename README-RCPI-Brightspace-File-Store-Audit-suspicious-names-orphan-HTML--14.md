# RCPI Brightspace File Store Audit (Suspicious Names & Orphan HTML)

> **File:** `RCPI-Brightspace-File-Store-Audit-suspicious-names-orphan-HTML-.user-14.js`  
> **Version:** 1.0

## Overview

Walks the entire course Manage Files file store recursively and flags two categories of problem: files with **suspicious names** (Untitled, Copy, New Document, generic defaults like `overview.html`) and **orphan HTML pages** (HTML files that are not linked by any content topic). Displays a modal report with a downloadable CSV.

## Features

- Walks the full file store recursively via the D2L LP Manage Files API (up to 1500 requests)
- Detects suspicious filenames matching configurable regex patterns: Untitled, Copy, New Document, generic defaults
- Detects orphan HTML files — present in the file store but not referenced by any content topic
- Cross-references the file store against the full content topic tree
- Modal report with file path, flags, linked-by count, last modified, and file size
- Downloadable CSV (flagged files only, or all files)
- Handles pagination and subfolder traversal

## Usage

Install via Tampermonkey. Navigate to any page of a course on `brightspace.rcpi.ie`. The audit runs automatically. Requires Manage Files permission.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/*`.
- If Manage Files API is unavailable, the modal reports the access issue without crashing.
- Suspicious name patterns are configurable at the top of the script (`SUSPICIOUS` array).
