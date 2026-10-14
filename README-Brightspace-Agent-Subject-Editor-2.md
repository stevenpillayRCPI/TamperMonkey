# Brightspace Agent Subject Editor

> **File:** `Brightspace-Agent-Subject-Editor.user-2.js`  
> **Version:** 1.0

## Overview

Automatically pre-fills the email subject line when editing an Intelligent Agent in Brightspace, saving repetitive typing when the same subject template is needed across multiple agents.

## Features

- Detects when the Intelligent Agent edit page is open (URL contains `Edit?agentId`)
- Injects a preset subject string into the `actionsDataEmailSubject` field
- Uses a MutationObserver to handle cases where the field loads after the initial page render

## Usage

Install via Tampermonkey. Navigate to an Intelligent Agent edit page on `brightspace.rcpi.ie`. The subject field is populated automatically.

To change the subject template, edit the `newSubject` constant at the top of the script.

## Notes

- Matches `https://brightspace.rcpi.ie/d2l/le/intelligentAgents/agentEdit*`.
- Only fires on pages that include `Edit?agentId` in the URL.
