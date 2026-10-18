# Mellow Diary

A soft, colorful, responsive personal diary for plans, tasks, and real-life execution notes.

## Deploy

This is a static single-page application. Vercel can serve `index.html` directly from the repository root; no build command or package installation is required.

- Framework preset: Other
- Root directory: `./`
- Build command: leave blank
- Output directory: leave blank (or use the platform's static file default)

## Current storage model — important

The current deployed version uses the browser's `localStorage` and does not send diary content to a server. It can be used immediately in one browser profile without installing or configuring a database.

- Data persists on the same browser profile and origin.
- Data does **not** automatically synchronize to another browser, computer, or phone.
- Clearing this browser's site data can erase the diary. Use **돌아보기 → 데이터 내보내기** to create a JSON backup and keep it somewhere safe.
- The GitHub repository is private, but the public Vercel website URL is not made private merely by the repository being private. This frontend does not contain diary data, but anyone with the URL can open the app and use their own browser storage.

Login, server-side storage, and device-to-device sync are not configured yet. To make this a signed-in, single-owner cloud diary, connect a **separate Supabase project**, enable Auth, and apply per-user Row Level Security policies before storing any personal records in the database. Do not reuse credentials from another project and never put service-role secrets in browser code.

## Features

- General-purpose plans with date range, success criteria, estimated minutes and version history
- Tasks linked to a plan or independent, with status, due date, priority, tags and estimate
- Search and filters for task text, status, priority and tag
- Explicit sort modes: due date, priority, estimated time, recently created, and title
- Separate actual execution logs with start/end time, elapsed time, blockers, notes, and optional task association
- Completion event history: a task only creates an event when it transitions from not-done to done; a repeat click while already done is a no-op
- Export/import JSON backup

## Data integrity notes

Plan edits append the previous field values to the plan's history. Execution logs are stored independently from plan estimates. Deleting a task preserves its execution logs and removes their active task association. Completion history remains as an audit trail if a task is reopened.

## Repository structure

- `index.html` — app UI, styles, and client-side behavior
- `vercel.json` — static deployment settings
- `docs/BEHAVIOR_AND_LIMITS.md` — behavior and known limitations
