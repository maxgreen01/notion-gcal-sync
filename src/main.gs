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
const STATUS_NOTION = "Status"; // type = Status //todo make sure integrated properly & maybe make optional
const TAGS_NOTION = "Tags"; // type = Multi-select
const CALENDAR_NAME_NOTION = "Calendar"; // type = Select (values must match the keys in `CALENDAR_IDS`)
const DESCRIPTION_NOTION = "Description"; // type = Text
const LOCATION_NOTION = "Location"; // type = Text (the property itself is optional)

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

/**
 * Main driver function for the entire script during regular execution
 */
function main() {
    databases = retrieveDatabaseURLs();

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
 * -- Will discard the old page token and generate a new one. --
 * -- Will reset time min and time max to use the the current time as origin time --
 **/
function fullSync() {
    console.log("Preforming full sync. Page token, time min, and time max will be reset.");

    databases = retrieveDatabaseURLs();

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
 * Syncs to Google Calendar from Notion, without handling deleted events.
 * This should only be called after GCal events have already been checked for deletion
 * based on their corresponding Notion pages.
 * @returns {Set<string>} Set of GCal event IDs that were modified
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
                {
                    property: STATUS_NOTION,
                    status: {
                        does_not_equal: COMPLETED_STATUS_NAME,
                    },
                },
            ],
        },
    };
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
 * Syncs from Google Calendar to Notion.
 * Only processes events with a tag matching the current Notion DB.
 * @param {string} cal_name Calendar name
 * @param {boolean} [fullSync=false] Whenever or not to discard the old page token
 * @param {Set<string>} [ignored_eIds=new Set()] Event IDs to not act on.
 * @throws {Error} If there is an error during the sync process.
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
 * Determine if an array of GCal events need to be updated, removed, or added to the database
 * @param {CalendarEvent[]} events Google Calendar events
 * @param {Set<string>} ignored_eIds Event IDs to not act on.
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
 * Remove references to a page's corresponding GCal event by clearing
 * its Event ID and Calendar ID, but not adding the DELETED tag.
 * @param {String} page_id Page ID of database entry
 * @returns fetch response
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
 * Update a database entry with a new `LAST_SYNC` value
 * @param {String} page_id Page ID of database entry
 * @returns {*} the fetch response
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
 * Update a database entry with new event information from a Google Calendar event
 * @param {CalendarEvent} event Modified Google Calendar event
 * @param {string} page_id Page ID of database entry
 * @param {string[]} [existing_tags=[]] Existing tags of the page to keep.
 * @param {boolean} [multi=true] Whenever or not the update is meant for a multi-fetch
 * @returns {*} request object if multi is true, fetch response if multi is false
 */
function updateDatabaseEntry(event, page_id, existing_tags = [], multi = true) {
    const properties = convertToNotionProperty(event, existing_tags);
    // If the GCal event was deleted, we might be able to immediately delete the Notion page
    const archive = event.status === "cancelled" && TAG_CANCELLED_EVENTS && ARCHIVE_DELETED_PAGES;

    return pushDatabaseUpdate(properties, page_id, archive, multi);
}

/**
 * Push update to Notion database for page
 * @param {Object} properties - The updated properties for the database entry.
 * @param {string} page_id - The ID of the database entry to update.
 * @param {boolean} archive - Whether to archive the database entry.
 * @param {boolean} multi - Whether to use a single fetch or return options for fetchAll.
 * @returns {*} A request options dictionary if `multi` is `true`, otherwise a HTTPResponse object.
 *
 * TODO: Deprecate in favor of only using createDatabaseUpdateParams?
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
 * Create a new database entry for the event
 * @param {CalendarEvent} event modified GCal event object
 * @returns {*} request object
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
 * Checks if the properties are valid for Notion
 *
 * @param {*} properties Properties object to check
 * @returns {boolean} false if invalid, true if valid
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
 * Determine if a page exists for the event, and the page needs to be updated. Returns page response if found.
 * @param {CalendarEvent} event
 * @returns {*} Page response if found.
 */
function getPageFromEvent(event) {
    let payload = {
        filter: {
            and: [
                {
                    property: EVENT_ID_NOTION,
                    rich_text: {
                        equals: event.id,
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
    return false;
}

/**
 * Retrieve Notion page using page id
 * @deprecated This is not used anymore due to Notion API change on Aug 31, 2022, but kept for reference.
 * @param {Object} result
 * @param {string} property - Notion property name key
 * @returns {Object} request response object
 */
function getPageProperty(result, property) {
    console.warn("Using deprecated function getPageProperty.");
    let page_id = result.id;
    try {
        let property_id = result.properties[property].id;

        const url = `${getPagesURL()}/${page_id}/properties/${property_id}`;
        return notionFetch(url, null, "GET");
    } catch (e) {
        throw new Error(`Error trying to get page property ${property} from page ${page_id}. Ensure that the database is setup correctly! EM: ${e.message}`);
    }
}

/**
 * Interact with Notion API
 * @param {string} url - url to send request to
 * @param {Object} payload_dict - payload to send with request
 * @param {string} method - method to use for request
 * @returns {Object} request response object
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

function getNotionHeaders() {
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        Accept: "application/json",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    };
}

function getDatabaseQueryURL() {
    return `${getDatabaseURL()}/query`;
}

function getDatabaseURL() {
    return `${NOTION_API_URL}/databases/${DATABASE_ID}`;
}

function getPagesURL() {
    return `${NOTION_API_URL}/pages`;
}

function getNotionParent() {
    return {
        database_id: DATABASE_ID,
    };
}

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
 * Return Notion JSON property object based on event data
 * @param {CalendarEvent} event - modified GCal event object
 * @param {string[]} existing_tags - existing tags to add to event
 * @returns {Object} Notion property object
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
    // todo maybe make other properties optional too -- need to make sure the same logic works everywhere to avoid missteps
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
 * Return base Notion JSON property object including generation time
 * @param {string} event_id - event id
 * @param {string} calendar_name - calendar key name
 * @returns {Object} - base Notion property object
 *  */
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
            select: {
                name: CALENDAR_IDS[calendar_name],
            },
        },
        [CALENDAR_NAME_NOTION]: {
            select: {
                name: calendar_name,
            },
        },
    };
}

// "Cache" of the current Notion database's properties
let DATABASE_PROPERTIES = {};
/**
 * Return whether the current database contains a property with the given name.
 * @param {string} property_name - The name of the property to check for.
 * @returns {boolean} - True if the property exists, false otherwise.
 */
function doesDatabaseHaveProperty(property_name) {
    if (!DATABASE_PROPERTIES || Object.keys(DATABASE_PROPERTIES).length === 0) {
        // If the cache is empty, fetch the database properties
        const response_data = notionFetch(getDatabaseURL(), null, "GET");
        DATABASE_PROPERTIES = response_data.properties;
    }
    return !!DATABASE_PROPERTIES[property_name];
}

/**
 * Return GCal event object based on page properties
 * @param {Object} page_result - Notion page result object
 * @returns {Object} GCal event object, or false if the date property is not found
 */
// todo use optional chaining on places like these
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
        return false;
    }
}

/**
 * Parses Notion information from project properties and declares them into global variables.
 * @param {string} database_key - The key for the Property storing the current database's URL
 */
function parseNotionProperties(database_key) {
    let properties = PropertiesService.getScriptProperties();
    NOTION_TOKEN = properties.getProperty("NOTION_TOKEN");

    // todo this regex looks kinda horrible so see if it's possible to simplify
    let reURLInformation = /^(([^@:\/\s]+):\/?)?\/?(([^@:\/\s]+)(:([^@:\/\s]+))?@)?([^@:\/\s]+)(:(\d+))?(((\/\w+)*\/)([\w\-\.]+[^#?\s]*)?(.*)?(#[\w\-]+)?)?$/;

    let database_url = properties.getProperty(database_key).match(reURLInformation);
    DATABASE_ID = database_url[13];
    DATABASE_PROPERTIES = {}; // reset the DB properties "cache"
}

/**
 * Get the Notion page ID of corresponding GCal event. Throws error if nothing is found.
 * @param {CalendarEvent} event - Modified GCal event object
 * @returns {string} Notion page ID
 * @throws {PageNotFoundError} Page not found in Notion database
 */
function getPageId(event) {
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
            console.log(`Found multiple entries with event id ${event.id}. This should not happen. Only processing index zero entry.`);
        }

        return response_data.results[0].id;
    }
    return null;
}

/**
 * Deals with event cancelled from GCal side
 * @param {CalendarEvent} event - Modified GCal event object
 */
function handleEventCancelled(event) {
    try {
        const page_id = getPageId(event);
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
 * Delete events marked for removal in Notion (via the COMPLETED status or DELETED tag)
 * from GCal, optionally deleting them from Notion too.
 * @param {string} type - Type of deletion to process, either "completed" (status) or "deleted" (tag).
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

        try {
            // Always try deleting the event from GCal
            let event_id = result.properties[EVENT_ID_NOTION].rich_text;
            event_id = flattenRichText(event_id);

            if (event_id) {
                let calendar_id = result.properties[CALENDAR_ID_NOTION].select.name;

                console.log(`[-GCal] Deleting event "${result_title}" (ID ${event_id}) from ${delete_location} because it is marked as ${type} in Notion.`);
                let delete_success = deleteEvent(event_id, calendar_id);
                if (delete_success) {
                    deleted_eIds.add(event_id);
                } else {
                    console.warn(`[-GCal] Failed to delete event "${result_title}" (ID ${event_id}) from GCal.`);
                }
            } else {
                console.warn(`[-GCal] Event ID is empty for deleted page ${result_title}, so it cannot be deleted from GCal.`);
            }
        } catch (e) {
            // todo feels like this should be a null check instead
            if (e instanceof TypeError) {
                console.error(`[-GCal] Error. Page ${result_title} missing calendar ID or event ID.`, e);
            } else {
                throw e;
            }
        } finally {
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
        }
    } // end of processing loop

    return deleted_eIds;
}

/** Delete event from Google Calendar
 * @param {string} event_id - Event id to delete
 * @param {string} calendar_id - Calendar id to delete event from
 * @returns {boolean} True if event was deleted, false if not
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
 * Determine if a page result has been updated since the last recorded sync
 * @param {Object} page_result - Page result from Notion database
 * @returns {boolean} True if page has been updated recently, false otherwise
 */
function isPageUpdatedRecently(page_result) {
    let last_sync_date = page_result.properties[LAST_SYNC_NOTION];
    last_sync_date = last_sync_date.date ? last_sync_date.date.start : 0;

    return new Date(last_sync_date) < new Date(page_result.last_edited_time);
}

/**
 * Flattens rich text properties into a singular string.
 * @param {Object} rich_text_result - Rich text property to flatten
 * @returns {string} Flattened rich text
 * */
function flattenRichText(rich_text_result) {
    let plain_text = "";
    for (let i = 0; i < rich_text_result.length; i++) {
        plain_text += rich_text_result[i].rich_text ? rich_text_result[i].rich_text.plain_text : rich_text_result[i].plain_text;
    }
    return plain_text;
}

/**
 * Create event to Google Calendar. Return event ID if successful.
 * @param {Object} page - Page object from Notion database
 * @param {Object} event - Event object for GCal
 * @param {string} calendar_name - name of calendar to push event to
 * @returns {string} Event ID if successful, false otherwise
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
            return false;
        }

        // Set a tag indicating which Notion DB this event belongs to
        new_event.setTag(GCAL_DB_TAG_KEY, DATABASE_ID);
    } catch (e) {
        console.error("[+GCal] Failed to push new event to GCal.", e);
        return false;
    }

    let properties = getBaseNotionProperties(new_event_id, calendar_name);
    pushDatabaseUpdate(properties, page.id);
    return new_event_id;
}

/**
 * Update a Google Calendar event
 * @param {CalendarEvent} event - Modified event object for GCal
 * @param {string} page_id - Page ID of Notion page to update
 * @param {string} calendar_id - Calendar ID of calendar to update event from
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
            cal_event.setTime(new Date(event.start), new Date(event.end) || null);
        }

        updateDatabaseSyncTime(page_id);
        return true;
    } catch (e) {
        console.error("[+GCal] Failed to push event update to GCal.", e);
        return false;
    }
}

/**
 * Error thrown when an event is invalid and cannot be
 * pushed to either Google Calendar or Notion.
 */
class InvalidEventError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}

/**
 * Error thrown when the specified page is not found in the Notion database.
 * Could be harmless depending on the context.
 *
 * @param {string} message - Error message
 * @param {string} eventId - Event ID of the page that was not found
 */
class PageNotFoundError extends Error {
    constructor(message, eventId) {
        super(message + " Event ID: " + eventId);
        this.name = this.constructor.name;
    }
}

/**
 * Error thrown when an unexpected page is found when searching for a different page.
 *
 * @param {string} message - Error message
 * @param {string} foundId - Event ID of the page that was found
 * @param {string} expectedId - Event ID of the page that was expected
 */
class UnexpectedPageFoundError extends Error {
    constructor(message, foundId, expectedId) {
        super(message + " Found ID: " + foundId + ", Expected ID: " + expectedId);
        this.name = this.constructor.name;
    }
}
