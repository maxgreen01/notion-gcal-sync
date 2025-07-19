// Mapping from Google Calendar names (aka values in the Notion "Calendar" property) to corresponding Google Calendar IDs
const CALENDAR_IDS = {
    /* Add calendars here. 
    The key (string before ':') is what you name the calendar. 
    The value (string after ':') is the calendar ID. 
    e.g. ["My calendar name"]: "abcdefg1234@group.calendar.google.com", */

    ["Primary"]: "primary",
};

// The default Google Calendar name that is used when the Notion property is empty
const DEFAULT_CALENDAR_NAME = "Primary";
