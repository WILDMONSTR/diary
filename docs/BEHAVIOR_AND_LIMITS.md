# Behavior and limits

## Daily journal entries

- Entries have a calendar date, title, free-form body, optional mood label, and comma-separated tags.
- Entries are sorted by date, with the most recently updated entry first for the same date.
- Create, edit, and delete actions operate on the browser-local data collection.
- The dashboard shows recent entries and links to the full journal.
- The journal collection is part of JSON export/import. Older backups without an `entries` array are accepted and normalized to an empty journal collection.
- Entry text is escaped before it is placed into the page, and line breaks are preserved when rendered.

## Plans

Each plan stores its latest fields and a version number. On a meaningful edit, the previously saved fields are appended to `history` before the latest fields are updated. The original estimated minutes and success criteria are not changed by execution logs.

## Tasks

Tasks can be associated with a plan or stand alone. Supported filters are free-text search, status, priority, and tag. The active sort is shown in the task list header and includes due date ascending, priority high-to-low, estimated minutes ascending, newest first, or Korean title order.

A task can be completed and later reopened. The completion history is an audit trail, so reopening does not remove an earlier completion event. Completing a task already marked done is a no-op. If the task is reopened and completed again later, that new transition is recorded as a new completion event.

## Execution logs

Runs are separate records. Start time, optional end time, duration, blocker, note, and optional task link are stored without updating plan estimates. If an associated task is deleted, the run retains its title snapshot and remains in the timeline.

## Persistence and privacy

This release stores data in browser `localStorage`. The data stays within the same browser profile and website origin; it is not backed up by the server. The JSON export/import feature is the backup path. A private GitHub repository does not make a Vercel deployment private.

No login or cloud database is configured in this release. For an authenticated cloud deployment, configure a new dedicated Supabase project and per-user RLS policies before enabling server persistence.
