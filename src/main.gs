// Google Apps Script project for syncing Notion database entries with Google Calendar events in both directions.
// Github repository:   https://github.com/maxgreen01/notion-gcal-sync
//
// Useful Terminology:
//  - Page: A database entry in Notion
//  - Event: A calendar event in Google Calendar (aka GCal)
//
//  - An "archived" Notion page is one that is effectively deleted
//  - A "cancelled" Google Calendar event is usually one that has been deleted
//
//  - A "COMPLETED" Notion page (or event) is one that has been marked as completed in Notion,
//    and will typically be deleted from GCal but not from Notion
//  - A "DELETED" Notion page (or event) is one that will typically be deleted from both Notion and GCal
//

//
// ========== Notion database property names (and corresponding Notion types) ==========
//
const NAME_NOTION = "Name"; // type = Title
const DATE_NOTION = "Due"; // type = Date
const STATUS_NOTION = "Status"; // type = Status (this property is optional)
const TAGS_NOTION = "Tags"; // type = Multi-select
const CALENDAR_NAME_NOTION = "Calendar"; // type = Select (values must match the keys in `CALENDAR_IDS`)
const DESCRIPTION_NOTION = "Description"; // type = Text
const LOCATION_NOTION = "Location"; // type = Text (this property is optional)

//
// ========== Special Notion property names ==========
// The values of these properties should not be modified manually!
//
const EVENT_ID_NOTION = "Event ID";
const CALENDAR_ID_NOTION = "Calendar ID";
const LAST_SYNC_NOTION = "Last Sync";

//
// ========== Special Notion data values ==========
// These tags and status values correspond to specific functionality,
//

// Notion pages with this status will persist on Notion, but will be deleted on Google Calendar the next time the script runs.
// If the status is changed back to something else, a new event will be created on Google Calendar as if the Notion page was just created.
// See `CALENDARS_IGNORING_COMPLETED_DELETION` to specify calendars where completed events should not be deleted.
const COMPLETED_STATUS_NAME = "Completed";

// Notion pages with this tag will be deleted on both Notion and Google Calendar the next time the script runs.
// Set `ARCHIVE_DELETED_PAGES = false` to only delete events from Google Calendar, but not Notion.
const DELETED_TAG_NAME = "DELETED";

// Notion pages with this tag will not be synced in either direction at all.
const IGNORE_SYNC_TAG_NAME = "Ignore Sync";

//
// ========== Script settings ==========
//

// Whether cancelled (deleted) Google Calendar events should be tagged as DELETED in Notion.
// Note that disabling this option means these events will be re-created in Google Calendar the next time the script runs.
const TAG_CANCELLED_EVENTS = true;

// Whether Notion pages tagged as DELETED should be archived in Notion, in addition to being deleted from Google Calendar.
// If both this and `TAG_CANCELLED_EVENTS` are enabled, cancelled Google Calendar events will immediately be archived in Notion.
const ARCHIVE_DELETED_PAGES = true;

// Whether events pushed from Notion to GCal should be synchronized back from GCal to Notion in the same script instance.
// Disabling this option may lead to duplicate Notion pages!
const IGNORE_RECENTLY_PUSHED = true;

// Whether to skip creating Notion pages for Google Calendar events with invalid properties
const SKIP_BAD_EVENTS = true;

// The limits of how far into the past and future (in days) that Google Calendar should search for events when performing a full sync,
// relative to the date when executing that current full sync.
const SYNC_RELATIVE_MAX_DAYS = 1825; // 5 years
const SYNC_RELATIVE_MIN_DAYS = 30;

// List of Google Calendar names where COMPLETED pages should NOT be deleted from GCal, meaning they aren't deleted on either platform.
const CALENDARS_IGNORING_COMPLETED_DELETION = ["Exams"];

// List of Notion databases (represented by their corresponding Apps Script "script property" names) that should NOT
// receive updates from Google Calendar, i.e. updates only go from Notion to Google Calendar but not the other way around.
const DATABASES_IGNORING_GCAL_UPDATES = ["EXTRACURRICULAR_DATABASE_URL"];

// The suffix that indicates which Apps Script "script properties" represent Notion databases that should be processed by this script
// by storing their corresponding URLs. This allows the script to handle multiple Notion databases.
const DATABASE_URL_PROPERTY_SUFFIX = "DATABASE_URL";

//

//
// ========== Script Internals & Implementation ==========
//

// The ID of the Notion DB that is currently being processed, as set in `parseNotionProperties()`.
let DATABASE_ID;

// The key used for the Tag on all GCal events to store the Notion database ID that each event is associated with.
// This is used to filter events when syncing from GCal to each Notion DB, allowing multiple Notion DBs to sync to the same calendar.
const GCAL_DB_TAG_KEY = "NotionDB";

// API constants
const MAX_PAGE_COUNT = 100; // The maximum number of pages to retrieve in a single Notion or Google Calendar API request
const NOTION_API_URL = "https://api.notion.com/v1";
let NOTION_TOKEN; // Set in `parseNotionProperties()`

//
// ~~~~~~~ Type definitions & aliases ~~~~~~~
//

/**
 * Represents a Google Calendar event.
 * @typedef {GoogleAppsScript.Calendar.CalendarEvent} CalendarEvent
 */

// Appease ESLint
/* global CALENDAR_IDS, DEFAULT_CALENDAR_NAME */

/**
 * Main driver function for the entire script during regular execution
 */
function main() {
    const databases = retrieveDatabaseURLs();

    // Repeat the syncing process for each detected database
    for (const db of databases) {
        // Update the global var indicating which database is being synced
        console.log();
        console.log(`Processing database with property key '${db}'`);

        // Set up the program to focus on this db
        parseNotionProperties(db);

        // Remove events marked as DELETED in Notion from GCal (and potentially Notion)
        const deleted_eIds = processDeletedPages("deleted");
        // Remove events marked as COMPLETED in Notion from GCal, but not Notion.
        // This is checked after DELETED events are processed because deletion has a higher priority.
        const completed_eIds = processDeletedPages("completed");

        // Sync from Notion to GCal
        const modified_eIds = syncToGCal();

        // Ignore GCal events that were cancelled because of something in Notion
        let ignored_eIds = new Set([...deleted_eIds, ...completed_eIds]);
        if (IGNORE_RECENTLY_PUSHED) {
            // Also ignore recent regular event changes
            ignored_eIds = new Set([...ignored_eIds, ...modified_eIds]);
        }

        // Sync from GCal to Notion, unless this database disables this functionality
        if (DATABASES_IGNORING_GCAL_UPDATES.includes(db)) {
            console.log(`Deliberately skipping syncing from GCal to Notion for database '${db}'`);
        } else {
            for (const cal_name of Object.keys(CALENDAR_IDS)) {
                syncFromGCal(cal_name, false, ignored_eIds);
            }
        }

        console.log(`Finished processing database with property key '${db}'`);
    } // end of main processing loop
}

/**
 * Syncs all calendars from Google Calendar to Notion using a full sync.
 *
 * Discards the old page token and generate a new one.
 * Resets time min and time max to use the the current time as origin time.
 * Only syncs from Google Calendar to Notion, and does not push Notion changes to Google Calendar.
 **/
function fullSync() {
    console.log("Preforming full sync. Page token, time min, and time max will be reset.");

    const databases = retrieveDatabaseURLs();

    // Repeat the syncing process for each detected database
    for (const db of databases) {
        // Update the global var indicating which database is being synced
        console.log();
        console.log(`Processing database with property key '${db}'`);

        // Set up the program to focus on this db
        parseNotionProperties(db);

        // Sync from GCal to Notion, unless this database disables this functionality
        if (DATABASES_IGNORING_GCAL_UPDATES.includes(db)) {
            console.log(`Deliberately skipping syncing from GCal to Notion for database '${db}'`);
        } else {
            for (const cal_name of Object.keys(CALENDAR_IDS)) {
                syncFromGCal(cal_name, true, new Set());
            }
        }

        console.log(`Finished processing database with property key '${db}'`);
    } // end of main processing loop
}

/**
 * Retrieves the URLs for each database stored in the script properties whose keys end with `DATABASE_URL_PROPERTY_SUFFIX`
 * @returns {string[]} Array of database URLs
 */
/**
 * Retrieves the property keys for each Notion database stored in script properties whose keys end with `DATABASE_URL_PROPERTY_SUFFIX`.
 * @returns {string[]} Array of database property keys (not URLs)
 */
function retrieveDatabaseURLs() {
    const properties = PropertiesService.getScriptProperties();
    const databases = [];
    for (const key of properties.getKeys()) {
        if (key.endsWith(DATABASE_URL_PROPERTY_SUFFIX)) {
            console.log(`Found database with property key '${key}'`);
            databases.push(key);
        }
    }
    return databases;
}

/**
 * Syncs Notion pages to Google Calendar, excluding pages marked as DELETED, COMPLETED, or IGNORE_SYNC.
 * Only updates/creates events in GCal for pages that have been updated since the last sync.
 * This should only be called after GCal events have already been checked for deletion
 * based on their corresponding Notion pages.
 * @returns {Set<string>} Set of GCal event IDs that were modified or created
 */
function syncToGCal() {
    console.log("[+GCal] Syncing to Google Calendar.");

    // Get up to `MAX_PAGE_COUNT` Notion pages in order of when they were last edited.
    // Only update GCal if a page doesn't have the `IGNORE_SYNC` tag AND isn't marked as COMPLETED
    const payload = {
        page_size: MAX_PAGE_COUNT,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        filter: {
            and: [
                {
                    property: TAGS_NOTION,
                    multi_select: {
                        does_not_contain: IGNORE_SYNC_TAG_NAME,
                    },
                },
                {
                    // Deleted pages should have already been processed, so don't try to re-create them
                    property: TAGS_NOTION,
                    multi_select: {
                        does_not_contain: DELETED_TAG_NAME,
                    },
                },
            ],
        },
    };
    if (doesDatabaseHaveProperty(STATUS_NOTION)) {
        payload.filter.and.push({
            property: STATUS_NOTION,
            status: {
                does_not_equal: COMPLETED_STATUS_NAME,
            },
        });
    }
    const response_data = notionFetch(getDatabaseQueryURL(), payload, "POST");

    const modified_eIds = new Set();

    for (let i = 0; i < response_data.results.length; i++) {
        let result = response_data.results[i];

        // Skip pages that haven't been updated since the last sync
        if (!isPageUpdatedRecently(result)) {
            continue;
        }

        let event = convertToGCalEvent(result);

        if (!event) {
            console.log(`[+GCal] Skipping Notion page "${flattenRichText(result.properties[NAME_NOTION].title) || result.id}" because it does not contain a date property.`);
            continue;
        }

        let calendar_id = result.properties[CALENDAR_ID_NOTION].select;
        calendar_id = calendar_id ? calendar_id.name : null;

        let calendar_name = result.properties[CALENDAR_NAME_NOTION].select;
        calendar_name = calendar_name ? calendar_name.name : DEFAULT_CALENDAR_NAME;

        // Check if the event already exists in GCal
        if (CALENDAR_IDS[calendar_name] && calendar_id && event.id) {
            if (calendar_id === CALENDAR_IDS[calendar_name]) {
                // Update event in original calendar.
                console.log(`[+GCal] Updating event "${event.summary}" (ID ${event.id}) in calendar "${calendar_name}".`);
                let updateSuccess = pushEventUpdate(event, event.id, calendar_id, result.id);
                if (updateSuccess) {
                    modified_eIds.add(event.id);
                }

                continue;
            }

            // Event being moved to a new calendar - delete from old calendar and then create using calendar name
            let deleteSuccess = deleteEvent(event.id, calendar_id);
            let modified_eId = createEvent(result, event, calendar_name);
            updateDatabaseSyncTime(result.id);

            if (deleteSuccess && modified_eId != false) {
                console.log(`[+GCal] Event "${event.summary}" (ID ${event.id}) moved to calendar "${calendar_name}".`);
                modified_eIds.add(modified_eId);

                continue;
            }

            console.log(`[+GCal] Failed to move event "${event.summary}" (ID ${event.id}) to calendar "${calendar_name}".`);
            continue;
        }

        // Try to create the event in GCal based on the Notion calendar name field
        if (CALENDAR_IDS[calendar_name]) {
            let modified_eId = createEvent(result, event, calendar_name);
            if (modified_eId != false) {
                modified_eIds.add(modified_eId);
                console.log(`[+GCal] Event "${event.summary}" (ID ${modified_eId}) created in calendar "${calendar_name}".`);
            }
            continue;
        }

        console.log(`[+GCal] Calendar name "${calendar_name}" not found in dictionary. No action taken.`);
    } // end of processing loop

    if (modified_eIds.size == 0) {
        console.log(`[+GCal] No GCal events needed to be modified or created.`);
        return modified_eIds;
    }

    return modified_eIds;
}

/**
 * Syncs events from Google Calendar to Notion for a given calendar name.
 * Only processes events tagged with the current Notion Database ID.
 * Handles incremental sync using sync tokens, or performs a full sync if requested or token is invalid.
 * @param {string} cal_name - Calendar name
 * @param {boolean} [fullSync=false] - Whether to discard the old sync token and perform a full sync
 * @param {Set<string>} [ignored_eIds=new Set()] - Event IDs to ignore during sync
 * @throws {Error} If there is an error during the sync process
 */
function syncFromGCal(cal_name, fullSync = false, ignored_eIds = new Set()) {
    console.log(`[+ND] Syncing from Google Calendar "${cal_name}".`);
    const properties = PropertiesService.getUserProperties();
    const syncToken = properties.getProperty("syncToken");
    let options = {
        maxResults: MAX_PAGE_COUNT,
        singleEvents: true, // Allow recurring events
    };

    if (syncToken && !fullSync) {
        options.syncToken = syncToken;
    } else {
        // Sync events up to thirty days in the past.
        options.timeMin = getRelativeDate(-SYNC_RELATIVE_MIN_DAYS, 0).toISOString();
        // Sync events up to x days in the future.
        options.timeMax = getRelativeDate(SYNC_RELATIVE_MAX_DAYS, 0).toISOString();
    }

    // Retrieve events one page at a time.
    let events;
    let pageToken;
    if (typeof Calendar.Events === "undefined") {
        throw new Error("Calendar.Events is undefined");
    }
    let calendar = CalendarApp.getCalendarById(CALENDAR_IDS[cal_name]);
    //todo make sure CALENDAR_IDS[cal_name] and `calendar` are defined, without repeating checks on cal_name everywhere
    do {
        options.pageToken = pageToken;
        try {
            events = Calendar.Events.list(CALENDAR_IDS[cal_name], options);

            // Only look at events corresponding to the current DB.
            // This is kinda scuffed because we want to use the web API (`Calendar.Events`) for the sync token functionality,
            // but we need the Apps Script API (`CalendarApp`) to get real CalendarEvent objects to check the DB tag.
            events.items = events.items.filter((e) => calendar.getEventById(e.id).getTag(GCAL_DB_TAG_KEY) == DATABASE_ID);
        } catch (e) {
            // Check to see if the sync token was invalidated by the server;
            // if so, perform a full sync instead.
            if (e.message === "Sync token is no longer valid, a full sync is required." || e.message === "API call to calendar.events.list failed with error: Sync token is no longer valid, a full sync is required.") {
                console.log(`[+ND] ${e.message} Attempting full sync.`);
                properties.deleteProperty("syncToken");
                syncFromGCal(CALENDAR_IDS[cal_name], true, ignored_eIds);
                return;
            } else {
                throw e;
            }
        }

        events["cal_name"] = cal_name;

        if (events.items && events.items.length === 0) {
            console.log(`[+ND] No relevant events found in calendar "${cal_name}".`);
            return;
        }
        console.log(`[+ND] Parsing new events in calendar "${cal_name}".`);
        parseEvents(events, ignored_eIds);

        pageToken = events.nextPageToken;
    } while (pageToken);

    properties.setProperty("syncToken", events.nextSyncToken);
}

/**
 * Parses an array of Google Calendar events and determines if they need to be updated, removed, or added in Notion.
 * @param {CalendarEvent[]} events - Google Calendar events to parse
 * @param {Set<string>} ignored_eIds - Event IDs to ignore during processing
 */
function parseEvents(events, ignored_eIds) {
    const requests = [];

    for (let i = 0; i < events.items.length; i++) {
        let event = events.items[i];

        // When an event is deleted in GCal, it is still included in this array, but the summary (title) isn't defined.
        // It also has `event.status` = "cancelled", but that might happen in other situations too
        if (typeof event.summary === "undefined") {
            continue;
        }

        event["cal_name"] = events["cal_name"];

        if (ignored_eIds.has(event.id)) {
            console.log(`[+ND] Manually ignoring event "${event.summary}" (ID ${event.id}).`);
            continue;
        }
        if (event.status === "cancelled") {
            // Remove the event from the database
            console.log(`[-ND] Handling that the event "${event.summary}" (ID ${event.id}) was cancelled in Google Calendar.`);
            handleEventCancelled(event);
            continue;
        }

        let start;
        let end;
        if (event.start.date) {
            // All-day event.
            start = new Date(event.start.date);
            end = new Date(event.end.date);
            console.log(`[+ND] Event found: "${event.summary}" (ID ${event.id}), (${start.toLocaleDateString()} -- ${end.toLocaleDateString()})`);
        } else {
            // Events that don't last all day; they have defined start times.
            start = event.start.dateTime;
            end = event.end.dateTime;
            console.log(`[+ND] Event found: "${event.summary}" (ID ${event.id}), (${start.toLocaleString()})`);
        }
        let page_response = getPageFromEvent(event);

        if (page_response) {
            console.log(`[+ND] Event "${event.summary}" (ID ${event.id}) database page ${page_response.id} exists already. Attempting update.`);
            let tags = page_response.properties[TAGS_NOTION].multi_select;
            requests.push(updateDatabaseEntry(event, page_response.id, tags || [], true));

            continue;
        }

        // Create the Notion page
        try {
            requests.push(createDatabaseEntry(event));
        } catch (e) {
            if (e instanceof InvalidEventError && SKIP_BAD_EVENTS) {
                console.log(`[+ND] Skipping creation of event "${event.summary}" (ID ${event.id}) due to invalid properties.`);
                continue;
            }

            throw e;
        }
    }

    if (requests.length == 0) {
        console.log(`[+ND] No Notion events needed to be modified or created.`);
        return;
    }

    console.log(`[+ND] Finished parsing GCal events. Sending batch request for ${requests.length} database entries.`);

    // todo streamline URLFetchApp usage (maybe by using new funcs on the branch not implemented here yet)
    const responses = UrlFetchApp.fetchAll(requests);

    for (let i = 0; i < responses.length; i++) {
        let response = responses[i];
        if (response.getResponseCode() === 401) {
            throw new Error("[+ND] Notion token is invalid.");
        } else if (response.getResponseCode() === 404) {
            throw new Error("[+ND] Notion page not found.");
        } else if (response.getResponseCode() === 403) {
            throw new Error("[+ND] Notion page is private.");
        } else if (response.getResponseCode() !== 200) {
            throw new Error(response.getContentText());
        }
    }
}

/**
 * Removes references to a page's corresponding GCal event by clearing its Event ID and Calendar ID properties in Notion.
 * Does not add the DELETED tag or archive the page.
 * @param {String} page_id - Page ID of the database entry to update
 * @returns {*} The fetch response from Notion API
 */
function removeEventReferences(page_id) {
    const properties = {
        // The Event ID and Calendar ID aren't valid anymore, so remove them
        [EVENT_ID_NOTION]: {
            type: "rich_text",
            rich_text: [],
        },
        [CALENDAR_ID_NOTION]: {
            type: "select",
            select: null,
        },
    };
    return pushDatabaseUpdate(properties, page_id);
}

/**
 * Updates a Notion database entry with a new LAST_SYNC value (current timestamp).
 * @param {String} page_id - Page ID of the database entry to update
 * @returns {*} The fetch response from Notion API
 */
function updateDatabaseSyncTime(page_id) {
    let properties = {
        [LAST_SYNC_NOTION]: {
            type: "date",
            date: {
                start: new Date().toISOString(),
            },
        },
    };

    return pushDatabaseUpdate(properties, page_id, false, false);
}

/**
 * Updates a Notion database entry with new event information from a Google Calendar event.
 * Optionally archives the page if the event was cancelled and settings allow.
 * @param {CalendarEvent} event - Modified Google Calendar event object
 * @param {string} page_id - Page ID of the database entry to update
 * @param {string[]} [existing_tags=[]] - Existing tags of the page to keep
 * @param {boolean} [multi=false] - Whether to return a request object for batch fetch
 * @returns {*} Request object if multi is true, fetch response if multi is false
 */
function updateDatabaseEntry(event, page_id, existing_tags = [], multi = false) {
    const properties = convertToNotionProperty(event, existing_tags);
    // If the GCal event was deleted, we might be able to immediately delete the Notion page
    const archive = event.status === "cancelled" && TAG_CANCELLED_EVENTS && ARCHIVE_DELETED_PAGES;

    return pushDatabaseUpdate(properties, page_id, archive, multi);
}

/**
 * Push update to Notion database page for page
 * @param {Object} properties - The updated properties for the database entry
 * @param {string} page_id - Page ID of the database entry to update
 * @param {boolean} [archive=false] - Whether to archive the database entry
 * @param {boolean} [multi=false] - Whether to return a request object for use with fetchAll instead of immediately performing the update
 * @returns {*} Request options dictionary if `multi` is true, otherwise a HTTPResponse object
 */
function pushDatabaseUpdate(properties, page_id, archive = false, multi = false) {
    const url = `${getPagesURL()}/${page_id}`;
    let payload = {};
    payload["properties"] = properties;
    payload["archived"] = archive;

    if (archive) {
        console.log(`[-ND] Archiving Notion page (ID ${page_id}).`);
    }

    let options = {
        method: "PATCH",
        headers: getNotionHeaders(),
        muteHttpExceptions: true,
        payload: JSON.stringify(payload),
    };

    if (multi) {
        options["url"] = url;
        return options;
    }

    return UrlFetchApp.fetch(url, options);
}

/**
 * Creates a fetch request object to create a new Notion database entry for a Google Calendar event.
 * @param {CalendarEvent} event - Google Calendar event object
 * @returns {*} Request object for batch fetch
 * @throws {InvalidEventError} If the event properties are invalid
 *
 * TODO: maybe include this in a UrlFetch logic refactor
 */
function createDatabaseEntry(event) {
    console.log(`[+ND] Creating Notion database entry for event "${event.summary}" (ID ${event.id}).`);

    let payload = {};

    payload["parent"] = {
        type: "database_id",
        database_id: DATABASE_ID,
    };

    payload["properties"] = convertToNotionProperty(event);

    if (!checkNotionProperty(payload["properties"])) {
        throw new InvalidEventError("Invalid Notion property structure");
    }

    let options = {
        url: getPagesURL(),
        method: "POST",
        headers: getNotionHeaders(),
        muteHttpExceptions: true,
        payload: JSON.stringify(payload),
    };
    return options;
}

/**
 * Checks if the provided Notion properties object is valid for Notion API.
 * Currently checks if the description is too long.
 * @param {*} properties - Properties object to check
 * @returns {boolean} True if valid, false if invalid
 */
function checkNotionProperty(properties) {
    // Check if description is too long
    if (properties[DESCRIPTION_NOTION].rich_text[0].text.content.length > 2000) {
        console.warn("Event description is too long.");
        return false;
    }

    return true;
}

/**
 * Gets the Notion page corresponding to a Google Calendar event (by Event ID), assuming it is not tagged with IGNORE_SYNC.
 * @param {CalendarEvent} event - Google Calendar event object
 * @returns {Object} Page response object if found
 * @throws {PageNotFoundError} If the page is not found
 */
function getPageFromEvent(event) {
    const payload = {
        filter: {
            and: [
                {
                    property: EVENT_ID_NOTION,
                    rich_text: {
                        equals: event.id,
                    },
                },
                {
                    property: TAGS_NOTION,
                    multi_select: {
                        does_not_contain: IGNORE_SYNC_TAG_NAME,
                    },
                },
            ],
        },
    };

    const response_data = notionFetch(getDatabaseQueryURL(), payload, "POST");

    if (response_data.results.length > 0) {
        if (response_data.results.length > 1) {
            console.warn(`Found multiple Notion pages with event id ${event.id}. This should not happen. Only processing index zero entry.`);
        }

        return response_data.results[0];
    }

    throw new PageNotFoundError("Page not found in Notion database", event.id);
}

/**
 * Retrieves a Notion page property by property name (deprecated).
 * Not used anymore due to Notion API change on Aug 31, 2022, but kept for reference.
 * @deprecated
 * @param {Object} result - Notion page result object
 * @param {string} property - Notion property name key
 * @returns {Object} Request response object
 */
function getPageProperty(result, property) {
    console.warn("Using deprecated function getPageProperty.");
    let page_id = result.id;
    try {
        let property_id = result.properties[property].id;

        const url = `${getPagesURL()}/${page_id}/properties/${property_id}`;
        return notionFetch(url, null, "GET");
    } catch (e) {
        throw new Error(`Error trying to get page property ${property} from page ${page_id}. Ensure that the database is set up correctly! EM: ${e.message}`);
    }
}

/**
 * Sends a request to the Notion API with the given URL, payload, and method.
 * @param {string} url - URL to send request to
 * @param {Object|null} payload_dict - Payload to send with request (or null for GET requests)
 * @param {string} [method="POST"] - HTTP method to use for request
 * @returns {Object} Response object from Notion API
 * @throws {Error} If the request returns an error code or if no data is returned
 */
function notionFetch(url, payload_dict, method = "POST") {
    // UrlFetchApp is sync even if async is specified
    let options = {
        method: method,
        headers: getNotionHeaders(),
        muteHttpExceptions: true,
        ...(payload_dict && { payload: JSON.stringify(payload_dict) }),
    };

    const response = UrlFetchApp.fetch(url, options);

    if (response.getResponseCode() === 200) {
        const response_data = JSON.parse(response.getContentText());
        if (response_data.length == 0) {
            throw new Error("No data returned from Notion API. Check your Notion token.");
        }
        return response_data;
    } else if (response.getResponseCode() === 401) {
        throw new Error("Notion token is invalid.");
    } else {
        throw new Error(response.getContentText());
    }
}

/**
 * Returns the headers required for Notion API requests, including authorization and version.
 * @returns {Object} Headers object
 */
function getNotionHeaders() {
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        Accept: "application/json",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    };
}

/**
 * Returns the Notion API URL for querying the current database.
 * @returns {string} Query URL
 */
function getDatabaseQueryURL() {
    return `${getDatabaseURL()}/query`;
}

/**
 * Returns the base Notion API URL for working with the current database.
 * @returns {string} Database URL
 */
function getDatabaseURL() {
    return `${NOTION_API_URL}/databases/${DATABASE_ID}`;
}

/**
 * Returns the base Notion API URL for working with individual pages.
 * @returns {string} Pages URL
 */
function getPagesURL() {
    return `${NOTION_API_URL}/pages`;
}

/**
 * Returns the Notion parent object representing the current database.
 * See https://developers.notion.com/reference/parent-object for more details.
 * @returns {Object} Notion parent object
 */
function getNotionParent() {
    return {
        type: "database_id",
        database_id: DATABASE_ID,
    };
}

/**
 * Returns a Date object that is offset from the current date and set exactly to a specific hour.
 * @param {number} daysOffset - Number of days to offset from today
 * @param {number} hour - Hour to set for the date
 * @returns {Date} Adjusted Date object
 */
function getRelativeDate(daysOffset, hour) {
    let date = new Date();
    date.setDate(date.getDate() + daysOffset);
    date.setHours(hour);
    date.setMinutes(0);
    date.setSeconds(0);
    date.setMilliseconds(0);
    return date;
}

/**
 * Converts a Google Calendar event object into a Notion properties object that can be used for database updates.
 * @param {CalendarEvent} event - Google Calendar event object
 * @param {string[]} [existing_tags=[]] - Existing tags to add to the event
 * @returns {Object} Notion properties object
 */
function convertToNotionProperty(event, existing_tags = []) {
    let properties = getBaseNotionProperties(event.id, event.cal_name);

    properties[NAME_NOTION] = {
        type: "title",
        title: [
            {
                type: "text",
                text: {
                    content: event.summary || "",
                },
            },
        ],
    };

    if (event.start) {
        let start_time;
        let end_time;

        if (event.start.date) {
            // All-day event.
            start_time = new Date(event.start.date);
            end_time = new Date(event.end.date);

            // Offset timezone
            start_time.setTime(start_time.getTime() + start_time.getTimezoneOffset() * 60 * 1000);
            end_time.setTime(end_time.getTime() + end_time.getTimezoneOffset() * 60 * 1000);

            // Offset by 1 day to get end date.
            end_time.setDate(end_time.getDate() - 1);

            start_time = start_time.toISOString().split("T")[0];
            end_time = end_time.toISOString().split("T")[0];

            end_time = start_time == end_time ? null : end_time;
        } else {
            // Events that don't last all day; they have defined start times.
            start_time = event.start.dateTime;
            end_time = event.end.dateTime;
        }

        properties[DATE_NOTION] = {
            type: "date",
            date: {
                start: start_time,
                end: end_time,
            },
        };
    }

    // The GCal event was deleted, so remove references to it
    if (event.status === "cancelled") {
        // The Event ID and Calendar ID aren't valid anymore, so remove them
        properties[EVENT_ID_NOTION] = {
            type: "rich_text",
            rich_text: [],
        };
        properties[CALENDAR_ID_NOTION] = {
            type: "select",
            select: null,
        };

        if (TAG_CANCELLED_EVENTS) {
            // Add the DELETED tag, ensuring we don't lose any existing tags during this update
            properties[TAGS_NOTION] = {
                multi_select: [
                    ...existing_tags,
                    {
                        name: DELETED_TAG_NAME,
                    },
                ],
            };
        }
    }

    properties[DESCRIPTION_NOTION] = {
        type: "rich_text",
        rich_text: [
            {
                text: {
                    content: event.description || "",
                },
            },
        ],
    };

    // Location property may not exist
    if (doesDatabaseHaveProperty(LOCATION_NOTION)) {
        properties[LOCATION_NOTION] = {
            type: "rich_text",
            rich_text: [
                {
                    text: {
                        content: event.location || "",
                    },
                },
            ],
        };
    }

    return properties;
}

/**
 * Returns a Notion properties object containing essential properties like event ID,
 * last sync time (now), and calendar info.
 * @param {string} event_id - Google Calendar event ID
 * @param {string} calendar_name - Calendar key name
 * @returns {Object} Base Notion properties object
 */
function getBaseNotionProperties(event_id, calendar_name) {
    return {
        [LAST_SYNC_NOTION]: {
            type: "date",
            date: {
                start: new Date().toISOString(),
            },
        },
        [EVENT_ID_NOTION]: {
            type: "rich_text",
            rich_text: [
                {
                    text: {
                        content: event_id, //use ICal uid?
                    },
                },
            ],
        },
        [CALENDAR_ID_NOTION]: {
            type: "select",
            select: {
                name: CALENDAR_IDS[calendar_name],
            },
        },
        [CALENDAR_NAME_NOTION]: {
            type: "select",
            select: {
                name: calendar_name,
            },
        },
    };
}

// "Store" of Notion database properties, with keys corresponding to Notion database IDs
// and values being the properties objects returned by the Notion API.
const DATABASE_PROPERTIES_STORE = {};

/**
 * Checks whether the current Notion database contains a property with the given name.
 * @param {string} property_name - The name of the property to check for
 * @returns {boolean} True if the property exists, false otherwise
 */
function doesDatabaseHaveProperty(property_name) {
    if (typeof DATABASE_PROPERTIES_STORE[DATABASE_ID] === "undefined") {
        // Fetch the database properties because they haven't been stored yet
        const response_data = notionFetch(getDatabaseURL(), null, "GET");
        DATABASE_PROPERTIES_STORE[DATABASE_ID] = response_data.properties;
    }
    return !!DATABASE_PROPERTIES_STORE[DATABASE_ID][property_name];
}

/**
 * Converts a Notion page object into an object representing a Google Calendar event.
 * @param {Object} page_result - Notion page result object
 * @returns {Object|undefined} Object representing a GCal event, or undefined if the date property is not found
 */
// todo use optional chaining on props in places like these
function convertToGCalEvent(page_result) {
    let e_id, e_summary, e_description, e_location, dates;

    e_id = page_result.properties[EVENT_ID_NOTION].rich_text;
    e_id = flattenRichText(e_id);

    e_summary = page_result.properties[NAME_NOTION].title;
    e_summary = flattenRichText(e_summary);

    e_description = page_result.properties[DESCRIPTION_NOTION].rich_text;
    e_description = flattenRichText(e_description);

    // Location property may not exist
    if (doesDatabaseHaveProperty(LOCATION_NOTION)) {
        e_location = page_result.properties[LOCATION_NOTION].rich_text;
        e_location = flattenRichText(e_location);
    }

    dates = page_result.properties[DATE_NOTION];

    if (dates.date) {
        let all_day = dates.date.end === null;

        if (dates.date.start && dates.date.start.search(/([A-Z])/g) === -1) {
            dates.date.start += "T00:00:00";
            all_day = true;
        } else if (!dates.date.end && dates.date.start && dates.date.start.search(/([A-Z])/g) !== -1) {
            all_day = false;
            let default_end = new Date(dates.date.start);
            default_end.setMinutes(default_end.getMinutes() + 30);

            dates.date.end = default_end.toISOString();
        } else if (dates.date.end && dates.date.end.search(/([A-Z])/g) === -1) {
            dates.date.end += "T00:00:00";
            all_day = true;
        }

        let event = {
            ...(e_id && { id: e_id }),
            ...(e_summary && { summary: e_summary }),
            ...(e_description && { description: e_description }),
            ...(e_location && { location: e_location }),
            ...(dates.date.start && { start: dates.date.start }),
            ...(dates.date.end && { end: dates.date.end }),
            all_day: all_day,
        };

        return event;
    } else {
        return undefined; // No date property found, so return undefined
    }
}

/**
 * Parses Notion information (API token & database ID) from script properties and assigns them to global variables.
 * @param {string} database_key - The key for the script property storing the current database's URL
 */
function parseNotionProperties(database_key) {
    const properties = PropertiesService.getScriptProperties();
    NOTION_TOKEN = properties.getProperty("NOTION_TOKEN");

    // Detect the database ID, which is a 32-character hexadecimal string after the `notion.so/` part of the URL
    const databaseIdRegex = /\bnotion\.so\/([a-f0-9]{32})\b/i;
    const matches = properties.getProperty(database_key).match(databaseIdRegex);
    DATABASE_ID = matches?.[1];
    if (!DATABASE_ID) {
        throw new Error(`Database ID not found in script property "${database_key}"! Ensure that the Notion URL is formatted correctly!`);
    }
}

/**
 * Handles a Google Calendar event that was cancelled (deleted) from the GCal side by updating the corresponding Notion page.
 * @param {CalendarEvent} event - Cancelled Google Calendar event object
 */
function handleEventCancelled(event) {
    try {
        const page_id = getPageFromEvent(event).id;
        //todo need to get the existing tags here somehow, maybe with a GET request
        //    maybe even use that function inside getNotionProperties so it's always called if we need to append a new tag
        updateDatabaseEntry(event, page_id, [], false);
    } catch (e) {
        if (e instanceof PageNotFoundError) {
            console.warn(`[-ND] Event "${event.summary}" (ID ${event.id}) not found in Notion database. Skipping.`);
            return;
        }
        throw e;
    }
}

/**
 * Delete events marked for removal in Notion (via the COMPLETED status or DELETED tag) from
 * Google Calendar, potentially archiving them in Notion too.
 * @param {string} type - Type of deletion to process, either "completed" (status) or "deleted" (tag)
 * @returns {Set<string>} Set of GCal event IDs that were deleted.
 */
function processDeletedPages(type) {
    if (!["completed", "deleted"].includes(type)) {
        console.error(`[-GCal] Invalid 'type' "${type}" for 'processDeletedEvents()'. Use "completed" or "deleted".`);
        return;
    }

    const delete_location = type === "completed" ? "GCal" : "GCal and Notion";
    console.log(`[-GCal] Deleting ${type} events from ${delete_location}.`);

    // Get all events which are newly marked for deletion and not being ignored.
    // Events that are newly marked for deletion events should have a non-empty Event ID, while this field is already empty
    // for events that have already been deleted.
    const payload = {
        filter: {
            and: [
                {
                    property: TAGS_NOTION,
                    multi_select: {
                        does_not_contain: IGNORE_SYNC_TAG_NAME,
                    },
                },
                {
                    property: EVENT_ID_NOTION,
                    rich_text: {
                        is_not_empty: true,
                    },
                },
            ],
        },
    };

    // Filter by either the COMPLETED status or DELETED tag
    if (type === "completed") {
        if (!doesDatabaseHaveProperty(STATUS_NOTION)) {
            console.error(`[-GCal] Notion database does not have a "${STATUS_NOTION}" status property, so cannot process completed events.`);
            return;
        }
        payload.filter.and.push({
            property: STATUS_NOTION,
            status: {
                equals: COMPLETED_STATUS_NAME,
            },
        });
        // Filter out events from calendars where completed events should not be deleted
        for (const cal_name of CALENDARS_IGNORING_COMPLETED_DELETION) {
            console.log(`[-GCal] Deliberately not deleting completed events from calendar "${cal_name}".`);
            payload.filter.and.push({
                property: CALENDAR_NAME_NOTION,
                select: {
                    does_not_equal: cal_name,
                },
            });
        }
    } else if (type === "deleted") {
        payload.filter.and.push({
            property: TAGS_NOTION,
            multi_select: {
                contains: DELETED_TAG_NAME,
            },
        });
    }

    const deleted_eIds = new Set();

    const response_data = notionFetch(getDatabaseQueryURL(), payload, "POST");

    for (let i = 0; i < response_data.results.length; i++) {
        let result = response_data.results[i];

        // Skip pages that haven't been updated since the last sync
        if (!isPageUpdatedRecently(result)) {
            continue;
        }

        let result_title = flattenRichText(result.properties[NAME_NOTION].title) || result.id;

        // Delete the event from GCal for all types of deletion
        let event_id = result.properties[EVENT_ID_NOTION].rich_text;
        event_id = flattenRichText(event_id);

        let calendar_id = result.properties[CALENDAR_ID_NOTION].select.name;

        if (event_id && calendar_id) {
            console.log(`[-GCal] Deleting event "${result_title}" (ID ${event_id}) from ${delete_location} because it is marked as ${type} in Notion.`);
            let delete_success = deleteEvent(event_id, calendar_id);
            if (delete_success) {
                deleted_eIds.add(event_id);
            } else {
                console.warn(`[-GCal] Failed to delete event "${result_title}" (ID ${event_id}) from GCal.`);
            }
        } else {
            console.warn(`[-GCal] ${EVENT_ID_NOTION} or ${CALENDAR_ID_NOTION} is empty for deleted page ${result_title}, so it cannot be deleted from GCal.`);
        }

        // Update the Notion page depending on the type of deletion
        if (type === "deleted" && ARCHIVE_DELETED_PAGES) {
            // Delete the page entirely
            console.log(`[-ND] Archiving page ${result_title} (ID ${result.id}) in Notion because it is marked as deleted.`);
            pushDatabaseUpdate([], result.id, true); // todo error check probably
        } else {
            // The page isn't archived, so remove the event-related fields.
            // This ensures the event can be re-made in Google Calendar later if desired.
            removeEventReferences(result.id, result.properties[TAGS_NOTION].multi_select || []);
        }
    } // end of processing loop

    return deleted_eIds;
}

/**
 * Deletes an event from Google Calendar.
 * @param {string} event_id - Event ID to delete
 * @param {string} calendar_id - Calendar ID to delete event from
 * @returns {boolean} True if event was deleted, false otherwise
 */
function deleteEvent(event_id, calendar_id) {
    console.log(`[-GCal] Deleting event with ID ${event_id} from Google Calendar "${calendar_id}".`);
    try {
        const calendar = CalendarApp.getCalendarById(calendar_id);
        const event = calendar.getEventById(event_id);
        if (event != null) {
            event.deleteEvent();
            return true;
        } else {
            console.warn(`[-GCal] Event with ID ${event_id} not found in calendar "${calendar_id}". This may be because it was deleted in GCal already.`);
            return false;
        }
    } catch (e) {
        console.error(e);
        return false;
    }
}

/**
 * Determines if a Notion page result has been updated since the last recorded sync.
 * @param {Object} page_result - Page result from Notion database
 * @returns {boolean} True if page has been updated recently, false otherwise
 */
function isPageUpdatedRecently(page_result) {
    let last_sync_date = page_result.properties[LAST_SYNC_NOTION];
    last_sync_date = last_sync_date.date ? last_sync_date.date.start : 0;

    return new Date(last_sync_date) < new Date(page_result.last_edited_time);
}

/**
 * Flattens a Notion rich text property into a singular string.
 * @param {Object} rich_text_result - Rich text property to flatten
 * @returns {string} Flattened rich text string
 */
function flattenRichText(rich_text_result) {
    let plain_text = "";
    for (let i = 0; i < rich_text_result.length; i++) {
        plain_text += rich_text_result[i].rich_text?.plain_text || rich_text_result[i].plain_text;
    }
    return plain_text;
}

/**
 * Creates a new event in Google Calendar based on an object describing it (usually from `convertToGCalEvent`).
 * Also tags the event to indicate which Notion DB the event belongs to, and saves the new event properties to the Notion page.
 * @param {Object} page - Notion page object from the database
 * @param {Object} event - Object describing the new GCal event
 * @param {string} calendar_name - Name of the calendar to push the event to
 * @returns {string|false} Newly created event ID if successful, undefined otherwise
 */
function createEvent(page, event, calendar_name) {
    event.summary = event.summary || "";
    event.description = event.description || "";
    event.location = event.location || "";

    let calendar_id = CALENDAR_IDS[calendar_name];
    let options = [event.summary, new Date(event.start)];

    if (event.end && event.all_day) {
        // add and shift
        let shifted_date = new Date(event.end);
        shifted_date.setDate(shifted_date.getDate() + 1);
        options.push(shifted_date);
    } else if (event.end) {
        options.push(new Date(event.end));
    }

    options.push({ description: event.description, location: event.location });

    let calendar = CalendarApp.getCalendarById(calendar_id);
    let new_event_id;
    try {
        let new_event = event.all_day ? calendar.createAllDayEvent(...options) : calendar.createEvent(...options);

        new_event_id = new_event.getId().split("@")[0];

        if (!new_event_id) {
            console.log(`[+GCal] Event "${event.summary}" not created in GCal.`);
            return undefined;
        }

        // Set a tag indicating which Notion DB this event belongs to
        new_event.setTag(GCAL_DB_TAG_KEY, DATABASE_ID);
    } catch (e) {
        console.error("[+GCal] Failed to push new event to GCal.", e);
        return undefined;
    }

    // Save the new event properties to the Notion page
    let properties = getBaseNotionProperties(new_event_id, calendar_name);
    pushDatabaseUpdate(properties, page.id);
    return new_event_id;
}

/**
 * Updates an existing Google Calendar event with new information from Notion.
 * Also updates the Notion page's LAST_SYNC value.
 * @param {CalendarEvent} event - Modified event object for GCal
 * @param {string} event_id - Event ID to update
 * @param {string} calendar_id - Calendar ID of calendar to update event from
 * @param {string} page_id - Page ID of the corresponding Notion page
 * @returns {boolean} True if successful, false otherwise
 */
function pushEventUpdate(event, event_id, calendar_id, page_id) {
    event.summary = event.summary || "";
    event.description = event.description || "";
    event.location = event.location || "";

    try {
        let calendar = CalendarApp.getCalendarById(calendar_id);
        let cal_event = calendar.getEventById(event_id);

        cal_event.setDescription(event.description);
        cal_event.setTitle(event.summary);
        cal_event.setLocation(event.location);

        if (event.end && event.all_day) {
            // all day, multi day
            let shifted_date = new Date(event.end);
            shifted_date.setDate(shifted_date.getDate() + 2);
            cal_event.setAllDayDates(new Date(event.start), shifted_date);
        } else if (event.all_day) {
            // all day, single day
            cal_event.setAllDayDate(new Date(event.start));
        } else {
            // not all day
            let event_end = event.end ? new Date(event.end) : null;
            cal_event.setTime(new Date(event.start), event_end);
        }

        updateDatabaseSyncTime(page_id);
        return true;
    } catch (e) {
        console.error("[+GCal] Failed to push event update to GCal.", e);
        return false;
    }
}

/**
 * Error thrown when an event is invalid and cannot be pushed to either Google Calendar or Notion.
 */
class InvalidEventError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

/**
 * Error thrown when the page corresponding to a Google Calendar event ID is not found in the Notion database.
 * Not always harmful depending on the context.
 * @param {string} message - Error message
 * @param {string} eventId - Event ID of the page that was not found
 */
class PageNotFoundError extends Error {
    constructor(message, eventId) {
        super(`${message}. Event ID: "${eventId}"`);
        this.name = this.constructor.name;
    }
}
