# D2L Manage Files Locator

> **File:** `D2L-Manage-Files-Locator.user-6.js`  
> **Version:** 1.3

## Overview

Companion script to **Edit Page Filename** (`Edit-Page-Filename-Manage-Files.user.js`). Runs inside the Manage Files popup and automatically scrolls to and highlights the file that was handed off by the companion script via `localStorage`. Does nothing if Manage Files is opened manually (no handoff present).

## Features

- Reads the target file path from `localStorage` (written by the companion Edit Page Filename script)
- Navigates into subfolders if the path includes them, using the YUI delegated click handler
- Lazy-scrolls the file list to load all rows before searching
- Highlights the matched row in amber and auto-checks its checkbox
- Shows a dismissable banner with status messages (found, not found, error)
- Consumes the handoff on first read to prevent stale re-triggers

## Usage

Install alongside **Edit Page Filename**. When you click the 'Manage Files' link injected by the companion script, Manage Files opens as a popup and this script automatically locates and highlights the file.

## Notes

- Matches `https://brightspace.rcpi.ie/d2lp/manageFiles/main.d2l*`.
- The match URL must stay in sync with the `manageFilesUrl()` function in the companion script — if D2L moves the Manage Files tool, update **both** scripts.
- Handoff expires after 10 minutes to prevent stale highlights.
