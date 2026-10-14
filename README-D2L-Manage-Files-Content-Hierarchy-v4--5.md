# D2L Manage Files Content Hierarchy

> **File:** `D2L-Manage-Files-Content-Hierarchy-v4-.user-5.js`  
> **Version:** 4.x

## Overview

Builds a visual, expandable content hierarchy tree from the D2L/Brightspace content API and displays it as an overlay panel. Allows instructional designers to quickly audit the folder/file structure of a course's Manage Files store in relation to its content topics.

## Features

- Fetches the full content tree (modules and topics) via the D2L LE API
- Displays a collapsible tree view showing the folder/file hierarchy
- Shows backend filenames and paths alongside topic titles
- Provides quick links to open Manage Files at a specific folder
- Exportable to CSV for offline review

## Usage

Install via Tampermonkey. Navigate to any course page on `brightspace.rcpi.ie`. The script adds a panel/button to access the content hierarchy view.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- Requires Manage Content permissions on the course.
