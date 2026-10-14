# D2L Manage Files Rename / Next Batch

> **File:** `D2L-Manage-Files-Rename-Next-Batch.user-7.js`  
> **Version:** unknown

## Overview

Provides batch file renaming and bulk operations inside the Brightspace Manage Files interface. Designed to help rename large numbers of content files efficiently, with 'next batch' navigation to move through groups of files without losing context.

## Features

- Batch rename files with pattern-based find/replace on filenames
- 'Next batch' navigation to step through paginated file lists
- Highlights files matching rename patterns before applying
- Progress feedback during rename operations
- Integrates with the existing Manage Files YUI DOM structure

## Usage

Install via Tampermonkey. Open the Manage Files popup inside a Brightspace course. The script adds rename and batch-navigation controls to the interface.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- Test rename patterns on a small batch before applying to large file sets.
