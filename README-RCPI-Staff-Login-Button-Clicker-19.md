# RCPI Staff Login Button Clicker

> **File:** `RCPI-Staff-Login-Button-Clicker.user-19.js`  
> **Version:** 0.1

## Overview

Automatically clicks the **RCPI Staff Login** (Azure Active Directory) button on the RCPI identity/login page, skipping the manual button click when accessing Brightspace via the staff SSO route.

## Features

- Attempts to click the `#IdPAzureActiveDirectoryExchange` button immediately on page load
- Falls back to a MutationObserver if the button isn't present at load time
- Secondary fallback after a 2-second delay covers slow-loading identity pages

## Usage

Install via Tampermonkey. Navigate to `https://iam.rcpi.ie`. The Staff Login button is clicked automatically.

## Notes

- Matches `https://iam.rcpi.ie/*`.
- Only one login method is targeted — if the button ID changes, update `#IdPAzureActiveDirectoryExchange` in the script.
