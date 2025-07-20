//
// ====================== Utility Functions & Variables ======================
//

// Appease ESLint by "importing" variables from other files
/* global DATABASE_ID:writable, DESCRIPTION_NOTION, LAST_SYNC_NOTION, DATABASE_URL_PROPERTY_SUFFIX, notionFetch */

//
// ~~~~~~~ Apps Script functions ~~~~~~~
//

/**
 * Retrieves the property keys for all the Notion databases stored in the script properties where the key ends with `DATABASE_URL_PROPERTY_SUFFIX`.
 * @returns {string[]} Array of database property keys
 */
/* exported retrieveDatabaseKeys */
function retrieveDatabaseKeys() {
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
 * Extracts a database ID from the script properties using its property key, and assigns it to `DATABASE_ID`.
 * @param {string} database_key - The key for the script property storing the current database's URL
 */
/* exported extractDatabaseId */
function extractDatabaseId(database_key) {
    const properties = PropertiesService.getScriptProperties();

    // Detect the database ID, which is a 32-character hexadecimal string after the `notion.so/` part of the URL
    const databaseIdRegex = /\bnotion\.so\/([a-f0-9]{32})\b/i;
    const matches = properties.getProperty(database_key).match(databaseIdRegex);
    DATABASE_ID = matches?.[1];
    if (!DATABASE_ID) {
        throw new Error(`Database ID not found in script property "${database_key}"! Ensure that the Notion URL is formatted correctly!`);
    }
}

//

//
// ~~~~~~~ Notion Database functions ~~~~~~~
//

const NOTION_API_URL = "https://api.notion.com/v1";
let NOTION_TOKEN; // Set in `retrieveNotionToken()`

/**
 * Retrieves the Notion API token from script properties and assigns it to the global variable NOTION_TOKEN.
 * @throws {Error} If the Notion API token is not set
 */
function retrieveNotionToken() {
    const properties = PropertiesService.getScriptProperties();
    NOTION_TOKEN = properties.getProperty("NOTION_TOKEN");
    if (!NOTION_TOKEN) {
        throw new Error("Notion API token is not set.");
    }
}

/**
 * Returns the headers required for Notion API requests, including authorization and version.
 * @returns {Object} Headers object
 */
/* exported getNotionHeaders */
function getNotionHeaders() {
    if (!NOTION_TOKEN) {
        retrieveNotionToken();
    }
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        Accept: "application/json",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
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
/* exported doesDatabaseHaveProperty */
function doesDatabaseHaveProperty(property_name) {
    if (typeof DATABASE_PROPERTIES_STORE[DATABASE_ID] === "undefined") {
        // Fetch the database properties because they haven't been stored yet
        const response_data = notionFetch(getDatabaseURL(), null, "GET");
        DATABASE_PROPERTIES_STORE[DATABASE_ID] = response_data.properties;
    }
    return !!DATABASE_PROPERTIES_STORE[DATABASE_ID][property_name];
}

/**
 * Checks if the provided Notion properties object is valid for Notion API.
 * Currently checks if the description is too long.
 * @param {*} properties - Properties object to check
 * @returns {boolean} True if valid, false if invalid
 */
/* exported checkNotionProperties */
function checkNotionProperties(properties) {
    // Check if description is too long
    if (properties[DESCRIPTION_NOTION].rich_text[0].text.content.length > 2000) {
        console.warn("Event description is too long.");
        return false;
    }

    return true;
}

/**
 * Returns the Notion API URL for querying the current database.
 * @returns {string} Query URL
 */
/* exported getDatabaseQueryURL */
function getDatabaseQueryURL() {
    return `${getDatabaseURL()}/query`;
}

/**
 * Returns the base Notion API URL for working with the current database.
 * @returns {string} Database URL
 */
/* exported getDatabaseURL */
function getDatabaseURL() {
    return `${NOTION_API_URL}/databases/${DATABASE_ID}`;
}

/**
 * Returns the base Notion API URL for working with individual pages.
 * @returns {string} Pages URL
 */
/* exported getPagesURL */
function getPagesURL() {
    return `${NOTION_API_URL}/pages`;
}

/**
 * Returns the Notion parent object representing the current database.
 * See https://developers.notion.com/reference/parent-object for more details.
 * @returns {Object} Notion parent object
 */
/* exported getNotionParent */
function getNotionParent() {
    return {
        type: "database_id",
        database_id: DATABASE_ID,
    };
}

//

//
// ~~~~~~~ Miscellaneous functions ~~~~~~~
//

/**
 * Returns a Date object that is offset from the current date and set exactly to a specific hour.
 * @param {number} daysOffset - Number of days to offset from today
 * @param {number} hour - Hour to set for the date
 * @returns {Date} Adjusted Date object
 */
/* exported getRelativeDate */
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
 * Determines if a Notion page result has been updated since the last recorded sync.
 * @param {Object} page_result - Page result from Notion database
 * @returns {boolean} True if page has been updated recently, false otherwise
 */
/* exported isPageUpdatedRecently */
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
/* exported flattenRichText */
function flattenRichText(rich_text_result) {
    let plain_text = "";
    for (let i = 0; i < rich_text_result.length; i++) {
        plain_text += rich_text_result[i].rich_text?.plain_text || rich_text_result[i].plain_text;
    }
    return plain_text;
}

//

//
// ~~~~~~~ Error types ~~~~~~~
//

/**
 * Error thrown when an event is invalid and cannot be pushed to either Google Calendar or Notion.
 */
/* exported InvalidEventError */
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
/* exported PageNotFoundError */
class PageNotFoundError extends Error {
    constructor(message, eventId) {
        super(`${message}. Event ID: "${eventId}"`);
        this.name = this.constructor.name;
    }
}
