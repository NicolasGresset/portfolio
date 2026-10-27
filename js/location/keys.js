// keys.js - The user's own API keys, stored only in this browser (localStorage, never sent
// to the site). Storage may be unavailable (private mode, blocked site data): keys then only
// last for the page's lifetime.

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
