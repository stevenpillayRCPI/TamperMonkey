# RCPI Brightspace Pre-Copy Overwrite Guard

> **File:** `RCPI-Brightspace-Pre-Copy-Overwrite-Guard.user-15.js`  
> **Version:** unknown

## Overview

Intercepts Brightspace course copy operations and warns before content files are overwritten. Helps prevent accidental data loss when copying a course into an org unit that already contains content, by auditing potential filename collisions before the copy proceeds.

## Features

- Hooks into the Brightspace course copy workflow
- Detects potential filename conflicts between source and destination file stores
- Presents a warning modal listing files at risk of being overwritten
- Allows the user to proceed or cancel the copy after reviewing the report
- Provides a downloadable summary of at-risk files

## Usage

Install via Tampermonkey. Navigate to the Brightspace course copy page. The guard runs automatically and presents a warning if overwrite risks are detected before you confirm the copy.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- Always review the report carefully before proceeding with a copy into a non-empty course.
