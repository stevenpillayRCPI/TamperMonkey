# D2L Image Alt Text Checker

> **File:** `D2L-Image-Alt-Text-Checker.user-4.js`  
> **Version:** 1.1

## Overview

Scans all images on the current Brightspace/D2L content page (including those inside iframes) and displays a floating notification reporting missing or empty alt attributes. Designed to support quick accessibility audits during content review.

## Features

- Checks all `<img>` elements in the main document and any accessible iframes
- Flags images with **no alt attribute** (error — screen readers will announce the filename)
- Flags images with an **empty alt attribute** (info — intentionally decorative)
- Shows a colour-coded floating notification (red for errors, blue for info, green for all-clear)
- Auto-dismisses after 45 seconds
- Re-runs automatically on SPA navigation (URL changes)
- Can be triggered manually with **Ctrl+Alt+I**

## Usage

Install via Tampermonkey. Navigate to any Brightspace content or lessons page. The checker runs automatically after a 2-second delay. Press Ctrl+Alt+I to re-run at any time.

## Notes

- Matches `brightspace.rcpi.ie/d2l/le/lessons*`, `brightspace.rcpi.ie/content/enforced*`, and wildcard `*.brightspace.com` / `*.d2l.com`.
- Cross-origin iframes are skipped silently.
