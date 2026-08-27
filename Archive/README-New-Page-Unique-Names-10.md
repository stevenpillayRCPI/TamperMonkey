# New Page Unique Names

> **File:** `New-Page-Unique-Names.user-10.js`  
> **Version:** 1.1

## Overview

Intercepts the first save of a **new** Brightspace content topic and automatically transforms the backend filename into a unique, date-stamped slug (e.g. `my-page-20260612-a3x9.html`). The visible title is immediately restored to the original after the slug is applied, so the page title the learner sees is unaffected.

## Features

- Only runs on new (unsaved) topics — existing pages are never touched
- Intercepts the PATCH request to the Brightspace content API before the file is committed
- Slugifies the title, appends today's date and a 4-character random UID
- Date position is configurable (`after` or `before` the slug)
- Restores the original visible title within 2.5 seconds of the save completing
- Flashes the title field green on successful restore, amber on error
- Clears the default 'Untitled' placeholder on load

## Usage

Install via Tampermonkey. Create a new content topic in Brightspace, type a title, and click Save. The backend filename will be a unique slug; the displayed title returns to what you typed.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- Only fires on new pages (URL contains `?isNew=true` or the editor has the `isnew` attribute).
- Configurable options: `DATEPOSITION`, `SEPARATOR`, `SLUGIFY`, `UIDLENGTH`.
