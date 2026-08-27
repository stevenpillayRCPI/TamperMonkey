# RCPI Brightspace Suspicious / At-Risk Linked Filenames

> **File:** `RCPI-Brightspace-Suspicious-At-Risk-Linked-Filenames.user-16.js`  
> **Version:** 1.0

## Overview

Scans the course content tree (via the D2L content API only — no Manage Files access required) and flags topics whose linked HTML file has a suspicious or generic name such as Untitled, Copy, index, summary, overview, or introduction. Shows a modal report with a downloadable CSV.

## Features

- Fetches the full course topic list via the D2L LE API
- Matches filenames against configurable suspicious-name patterns (Untitled, Copy, New Document, generic defaults)
- Groups results by file, listing all topics that link to each suspicious file
- Modal report showing filename, full path, flag labels, and linked topic titles with links
- Downloadable CSV of all flagged files and their topics
- Works without Manage Files permission (content API only)

## Usage

Install via Tampermonkey. Navigate to any page of a course on `brightspace.rcpi.ie`. The audit runs automatically.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/*`.
- Quicklinks and SCORM/package files are excluded from the scan.
- For a deeper audit including orphan files, use **RCPI Brightspace File Store Audit**.
