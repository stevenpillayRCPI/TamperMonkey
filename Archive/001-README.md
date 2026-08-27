# RCPI Brightspace Userscripts — Suite Overview

A collection of Tampermonkey userscripts for the **RCPI Brightspace (D2L)** instance, covering content editing, file management, accessibility auditing, and workflow automation.

All scripts match `https://brightspace.rcpi.ie/*` unless otherwise noted.

---

## Scripts

| # | Script | Version | What it does |
|---|--------|---------|--------------|
| 1 | **Block Builder Edit Toolkit** | v1.5 | Alt+right-click context menu and floating panel for editing RCPI Block Builder components inside TinyMCE. Handles table colours, component conversion (accordion ↔ tabs ↔ flipcards), add/delete/duplicate items, accessibility auditing, and clipboard history. Optional direct-write via TinyMCE API. |
| 2 | **Brightspace Agent Subject Editor** | v1.0 | Auto-fills the email subject field when editing an Intelligent Agent. Matches the agent edit URL and injects a preset subject template. |
| 3 | **Brightspace Nav Expander & Duplicate Highlighter** | v2.0 | Recursively expands the entire course nav tree in the Lessons view, then highlights any nav items that share a duplicate `data-objectid` with a red outline. |
| 4 | **D2L Image Alt Text Checker** | v1.1 | Scans all images on a content page (including iframes) and shows a floating notification flagging missing or empty alt attributes. Triggered automatically and via Ctrl+Alt+I. |
| 5 | **D2L Manage Files Content Hierarchy** | v4.x | Builds a visual content hierarchy tree from the D2L content API, showing folder/file structure alongside topic titles. Includes quick links to Manage Files and CSV export. |
| 6 | **D2L Manage Files Locator** | v1.3 | Companion to Edit Page Filename. Runs inside the Manage Files popup and auto-scrolls/highlights the file passed from the companion script via localStorage. Navigates into subfolders automatically. |
| 7 | **D2L Manage Files Rename / Next Batch** | — | Adds batch file-rename controls and 'next batch' navigation to the Manage Files interface, enabling efficient bulk renaming of content files with pattern-based find/replace. |
| 8 | **Edit Page Filename & Manage Files** | v6.2 | Shows the backend HTML filename for the current topic below the title field when editing a page. Injects a Manage Files button that opens the popup pre-targeted to that file. Warns on generic filenames. Self-heals across Lit component re-renders. |
| 9 | **Heading Alt Checker** | — | Lightweight spot-check for empty headings or alt-text issues on the current page. Minimal UI. |
| 10 | **New Page Unique Names** | v1.1 | On first save of a new topic, intercepts the API call and renames the backend file to a unique date+UID slug (e.g. `my-page-20260612-a3x9.html`). Restores the visible title immediately after. |
| 11 | **RCPI Block Builder Standalone** | v2.0 | Adds a floating Block Builder FAB and resizable side panel (iframe) to the content editor, so you can drag components into TinyMCE without leaving the edit page. |
| 12 | **RCPI Brightspace Broken Links & Images** | v1.5 | Crawls every HTML content page in a course, extracts all links, images, CSS urls, iframes, and media references, and probes each for broken links. Modal report + CSV. Uses GM_xmlhttpRequest to bypass CORS on external URLs. |
| 13 | **RCPI Brightspace Duplicate Content File Detector** | v2.4 | Finds topics that point to the same backend file (a common import side-effect). Detects title divergence between duplicates. Modal report + CSV. Also confirms file liveness via HEAD probes. |
| 14 | **RCPI Brightspace File Store Audit** | v1.0 | Recursively walks the entire Manage Files store and flags suspicious filenames (Untitled, Copy, generic defaults) and orphan HTML pages not linked by any topic. Modal report + CSV. |
| 15 | **RCPI Brightspace Pre-Copy Overwrite Guard** | — | Intercepts course copy operations and warns before files in the destination are overwritten, showing a list of at-risk filenames. |
| 16 | **RCPI Brightspace Suspicious / At-Risk Linked Filenames** | v1.0 | Uses the content API (no Manage Files needed) to flag topics whose linked file has a suspicious or generic name. Modal report + CSV. |
| 17 | **RCPI Brightspace Edit Toolkit** | v3.1 | Comprehensive editing suite FAB for the TinyMCE editor. Tabs: Link/Image Checker (404, redirects, mixed content, oversized images), DOI/PMID Lookup, Accessibility WCAG 2.1 AA audit with auto-fix, Find & Replace with undo, URL Linter, Before-Save Intercept, and Settings. CSV + Markdown export. Shortcut: Alt+Shift+E. |
| 18 | **RCPI Obesity Designs Standalone** | — | Standalone FAB and side panel for inserting RCPI Obesity programme design components into the TinyMCE editor — analogous to Block Builder Standalone but for the Obesity course design set. |
| 19 | **RCPI Staff Login Button Clicker** | v0.1 | Automatically clicks the Azure AD Staff Login button on the RCPI identity page (iam.rcpi.ie), saving a manual click on every login. |

---

## Script Groups

### ✏️ Content Editing
- Block Builder Edit Toolkit
- RCPI Block Builder Standalone
- RCPI Obesity Designs Standalone
- RCPI Brightspace Edit Toolkit
- New Page Unique Names
- Brightspace Agent Subject Editor

### 🗂️ File Management
- Edit Page Filename & Manage Files
- D2L Manage Files Locator *(companion to above)*
- D2L Manage Files Content Hierarchy
- D2L Manage Files Rename / Next Batch

### 🔍 Auditing & QA
- RCPI Brightspace Broken Links & Images
- RCPI Brightspace Duplicate Content File Detector
- RCPI Brightspace File Store Audit
- RCPI Brightspace Suspicious / At-Risk Linked Filenames
- RCPI Brightspace Pre-Copy Overwrite Guard
- D2L Image Alt Text Checker
- Heading Alt Checker

### 🧭 Navigation & UX
- Brightspace Nav Expander & Duplicate Highlighter
- RCPI Staff Login Button Clicker

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open each `.user.js` file and click **Install** in the Tampermonkey prompt.
3. Scripts that require `GM_xmlhttpRequest` (Broken Links checker, Edit Toolkit) must be installed via Tampermonkey — Greasemonkey does not support all required APIs.

## Companion Scripts

Some scripts work as a pair and must both be installed:

| Script A | Script B | How they connect |
|----------|----------|-----------------|
| Edit Page Filename & Manage Files | D2L Manage Files Locator | Script A passes the file path via `localStorage`; Script B reads it inside the Manage Files popup |
