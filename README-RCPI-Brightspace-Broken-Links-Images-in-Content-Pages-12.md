# RCPI Brightspace Broken Links & Images in Content Pages

> **File:** `RCPI-Brightspace-Broken-Links-Images-in-Content-Pages.user-12.js`  
> **Version:** 1.5

## Overview

Crawls every HTML content page in a course, extracts all `<a href>`, `<img src>`, CSS `url()`, iframe, video, audio, and stylesheet references, then probes each unique URL for broken links and images. Produces a modal report with a downloadable CSV, categorised by severity.

## Features

- Fetches the full course content topic list via the D2L LE API
- Downloads and parses each HTML page (up to 6 in parallel)
- Follows same-origin embedded content pages up to 3 levels deep
- Probes each unique URL once (HEAD-first, with GET fallback) — up to 10 concurrent probes
- Bypasses CORS on external URLs using `GM_xmlhttpRequest`
- Per-host throttling for external URLs (400ms gap, max 3 concurrent per host)
- Classifies results as: **broken**, **malformed URL**, **blocked**, **server error**, **rate-limited**, **redirect**, **media embed** (not checked), or **OK**
- Draggable modal report with FIX / REVIEW / INFO / LIKELY OK action labels
- Downloadable CSV with all results

## Usage

Install via Tampermonkey (requires `GM_xmlhttpRequest` permission). Navigate to any page of a course on `brightspace.rcpi.ie`. The audit runs automatically and shows a modal when complete.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/*`.
- Media embed URLs (YouTube, Panopto, Vimeo, etc.) are listed as INFO — not probed.
- Requires Tampermonkey (not Greasemonkey) for `GM_xmlhttpRequest` and `@connect` support.
- External probes may take several minutes on large courses.
