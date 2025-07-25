# Yet Another Two-Way Notion-Google Calendar Sync Script

Yet another script to synchronize events between Google Calendar and a Notion database.

This script aims to be a simple to setup, set and forget method of achieving two-way synchronization between a Notion Database, and multiple personal Google Calendars. By using Google App Scripts, this project avoids the mess caused by potential differences in operating systems, needing to download and install extra programs, and needing a personal computer that is currently turned on. It also means access to special integration benefits such as triggers actioned by an update to a Google Calendar event.

Currently supports two-way event creation, deletion, and updating.
| Property | Synchronization | Info |
| ---- | ---- | ---- |
| Name | 🔀 Yes| Title |
| Date | 🔀 Yes| Date & Time (Start and End) |
| Tags | ⚠️ Notion Database Only | Multi-select - Personal organization and script interaction |
| Location | 🔀 Yes| Text |
| Description | 🔀 Yes| Text |

## For [setup instructions 🔰](https://github.com/hk21702/YA-GCal-Notion-Sync-Script/wiki/Setup-Instructions%F0%9F%94%B0) and FAQ, please go to the [wiki!](https://github.com/hk21702/YA-GCal-Notion-Sync-Script/wiki)

## Additional Info/Features

- Google App Script based
    - Operating System Agnostic
    - Nothing to download or install
    - Automatic Script Trigger
        - Time Intervals
        - Google Calendar Updates
    - Logs that are saved and can be looked at later
- Sync both from GCal, and from Notion
    - Creation
    - Updates
        - Changing calendars from Notion
    - Deletions
- Multi-calendar support
- Support for recurring Events (Only available by setting through GCal)
- No Notion formulas
- Flexible property names
- Support for all day events, multi day events and scheduled events

## Known limitations/Bugs

- Sync from Notion sometimes doesn't register when the page was recently updated by GCal
    - Caused by lack of precision in Notion's last edited timestamp
- Will only check 100 most recently edited pages in database
    - Caused by Notion API limit
- Rich text (bolding, italics, etc.) used in the description will be overwritten to plain text after syncing.
- Doesn't seem to work with auto-generated calendars such as Birthdays. Might be a limitation of GCal API. See https://github.com/hk21702/YA-GCal-Notion-Sync-Script/issues/3
- Descriptions can only have at most 2,000 characters. This is a limit imposed by Notion. The script will fail gracefully if the event is being newly created, but will fail catastrophically if it is trying to update an event. This is intentional to prevent data merge issues.

## Development

### Clasp

[![clasp](https://img.shields.io/badge/built%20with-clasp-4285f4.svg)](https://github.com/google/clasp)

This project can be built and deployed using [clasp](https://github.com/google/clasp), Google's tool for developing Google Apps Script applications locally. Be sure to follow the clasp usage guide to set up your project and prepare the necessary (but private) configuration files!

To sync your local version of the script with your local development setup, you can use the included npm scripts `npm push`, `npm watch`, or `npm pull` as shortcuts for the corresponding clasp commands.

### Private Configuration

If you're developing locally, be sure not to commit any private Google Calendar data in [calendarIds.gs](src/calendarIds.gs)! To **locally** prevent any changes from being tracked by Git without removing the entire file from the repository, run the following command:

```bash
git update-index --assume-unchanged ./src/calendarIds.gs
```

Or to start tracking the file again:

```bash
git update-index --no-assume-unchanged ./src/calendarIds.gs
```
