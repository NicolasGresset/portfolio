// keys.js - The user's own API keys and the page's settings, stored only in this browser
// (localStorage, never sent to the site). Storage may be unavailable (private mode, blocked site
// data): they then only last for the page's lifetime.

const STORAGE_KEY = 'location.apiKeys';
let memory = {};

export function loadKeys() {
    try {
        memory = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
        // keep the in-memory keys
    }
    return { ...memory };
}

// Returns false when the keys could not be persisted
export function saveKeys(keys) {
    memory = Object.fromEntries(Object.entries(keys).filter(([, v]) => v));
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
        return true;
    } catch {
        return false;
    }
}

export function clearKeys() {
    memory = {};
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // nothing stored
    }
}

// The page's settings (view, score, candidates, transit engine), kept the same way; {} if none
const SETTINGS_KEY = 'location.settings';
let memorySettings = {};

export function loadSettings() {
    try {
        memorySettings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
        // keep the in-memory settings
    }
    return { ...memorySettings };
}

export function saveSettings(settings) {
    memorySettings = { ...settings };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(memorySettings));
    } catch {
        // kept for the page's lifetime only
    }
}
