# Brightspace Nav Expander & Duplicate Highlighter

> **File:** `Brightspace-Nav-Expander-Duplicate-Highlighter.user-3.js`  
> **Version:** 2.0

## Overview

Automatically expands the entire course navigation tree in the Brightspace lessons view, then scans all nav items for duplicate `data-objectid` values and highlights them in red. Useful for identifying content structure issues after course imports or copies.

## Features

- Recursively expands all collapsed modules and lessons in the nav tree using keyboard events (ArrowRight)
- Falls back to click events if keyboard expansion fails
- After full expansion, scans all `.navigation-item` elements for shared `data-objectid` values
- Highlights duplicate items with a red outline and tooltip showing which other items share the same ID
- Handles SPA navigation — re-runs automatically when the URL changes
- Targets the lessons iframe (`smart-curriculum` / `d2l/le/lessons`) rather than the outer page

## Usage

Install via Tampermonkey. Navigate to any course Lessons page on `brightspace.rcpi.ie`. The script runs automatically, expanding the nav and logging/highlighting any duplicates.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- Only runs on pages that include `d2l/le/lessons` in the URL.
- Duplicate highlights appear as a red 3px outline on the affected nav boxes.
