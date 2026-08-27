# Heading Alt Checker

> **File:** `Heading-Alt-Checker.user-9.js`  
> **Version:** unknown

## Overview

A lightweight script that checks headings and/or alt text on the current Brightspace page and reports issues via a console message or small UI notification. Acts as a quick spot-check companion to the more comprehensive Image Alt Text Checker.

## Features

- Scans headings or alt-text elements on the current page
- Reports empty or missing values
- Minimal footprint — no persistent UI panel

## Usage

Install via Tampermonkey. Navigate to a Brightspace content page. Issues are reported automatically.

## Notes

- Matches `https://brightspace.rcpi.ie/*`.
- For a full accessibility audit, use the **RCPI Brightspace Edit Toolkit** which includes a comprehensive a11y panel.
