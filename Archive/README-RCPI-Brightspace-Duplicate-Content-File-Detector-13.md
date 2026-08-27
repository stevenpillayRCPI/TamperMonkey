# RCPI Brightspace Duplicate Content File Detector

> **File:** `RCPI-Brightspace-Duplicate-Content-File-Detector.user-13.js`  
> **Version:** 2.4

## Overview

Scans the course content tree and identifies multiple navigation topics (content items) that point to the same backend HTML file — a common side-effect of course imports or copy operations that overwrite files. Displays a modal report highlighting clashes, with title-divergence detection and an optional CSV download.

## Features

- Fetches the full course content tree via the D2L LE API (tries `contenttoc` then `contentroot`)
- Groups topics by their normalised file path
- Flags groups where 2+ topics share the same file
- Detects **title divergence** — groups where topics have noticeably different titles despite pointing at the same file (Jaccard similarity)
- Actively confirms file liveness via HEAD probes (catches dead links the API doesn't flag)
- Compact modal report sorted by divergence then collision count
- Downloadable CSV (collision report or full inventory mode)
- Exposes results on `window.rcpiAudit` for console inspection

## Usage

Install via Tampermonkey. Navigate to any page of a course on `brightspace.rcpi.ie`. The audit runs automatically and shows a modal when complete.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/*`.
- Requires Manage Content permissions.
- Title divergence threshold is configurable via `DIVERGENCE_FLAG` (default 0.5).
