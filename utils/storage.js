/**
 * Storage Manager - Handles all Chrome storage operations
 * Provides abstraction for categories, limits, usage, and active state
 */

// =====================
// Constants & Defaults
// =====================

const STORAGE_KEYS = {
    CATEGORIES: 'categories',
    USAGE: 'usage',
    ACTIVE_STATE: 'activeState',
    SETTINGS: 'settings'
};

const DEFAULT_CATEGORIES = {
    video: {
        name: 'Video',
        type: 'video',
        domains: ['youtube.com', 'vimeo.com', 'netflix.com', 'twitch.tv', 'tiktok.com'],
        dailyLimit: 7200,        // 2 hours
        sessionDuration: 1800,   // 30 minutes
        sessionCount: 4,         // 4 sessions max
        restDuration: 600,       // 10 minutes rest
        forbiddenPeriods: [],
        enabled: true
    },
    reading: {
        name: 'Reading',
        type: 'reading',
        domains: ['reddit.com', 'wikipedia.org', 'medium.com'],
        idleTimeout: 30,         // 30 seconds idle = stop
        dailyLimit: 3600,        // 1 hour
        sessionDuration: 1200,   // 20 minutes
        sessionCount: 3,
        restDuration: 300,       // 5 minutes rest
        forbiddenPeriods: [],
        enabled: true
    },
    social: {
        name: 'Social Media',
        type: 'social',
        domains: ['twitter.com', 'x.com', 'facebook.com', 'instagram.com'],
        idleTimeout: 30,
        dailyLimit: 3600,
        sessionDuration: 900,    // 15 minutes
        sessionCount: 4,
        restDuration: 600,
        forbiddenPeriods: [],
        enabled: true
    }
};

const DEFAULT_SETTINGS = {
    globalEnabled: true,
    showNotifications: true,
    showBadge: true,
    strictMode: false  // If true, forbidden periods block immediately
};

// =====================
// Utility Functions
// =====================

/**
 * Get today's date key in YYYY-MM-DD format (local time)
 */
export function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Extract domain from URL (removes www. prefix)
 */
export function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        if (!['http:', 'https:'].includes(urlObj.protocol)) return null;
        return urlObj.hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

/**
 * Format seconds to human-readable string
 */
export function formatTime(seconds) {
    if (seconds < 0) seconds = 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

/**
 * Parse time string (HH:MM) to minutes from midnight
 */
export function parseTimeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
}

/**
 * Get current time as minutes from midnight
 */
export function getCurrentTimeMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
}

/**
 * Check if current time is within a forbidden period
 */
export function isInForbiddenPeriod(forbiddenPeriods) {
    if (!forbiddenPeriods || forbiddenPeriods.length === 0) return false;

    const currentMinutes = getCurrentTimeMinutes();

    for (const period of forbiddenPeriods) {
        const start = parseTimeToMinutes(period.start);
        const end = parseTimeToMinutes(period.end);

        // Handle overnight ranges (e.g., 22:00 to 08:00)
        if (start > end) {
            if (currentMinutes >= start || currentMinutes < end) return true;
        } else {
            if (currentMinutes >= start && currentMinutes < end) return true;
        }
    }

    return false;
}

/**
 * Get next allowed time after forbidden period ends
 */
export function getNextAllowedTime(forbiddenPeriods) {
    if (!forbiddenPeriods || forbiddenPeriods.length === 0) return null;

    const currentMinutes = getCurrentTimeMinutes();

    for (const period of forbiddenPeriods) {
        const start = parseTimeToMinutes(period.start);
        const end = parseTimeToMinutes(period.end);

        if (start > end) {
            if (currentMinutes >= start || currentMinutes < end) {
                const now = new Date();
                const nextAllowed = new Date(now);
                if (currentMinutes >= start) {
                    nextAllowed.setDate(nextAllowed.getDate() + 1);
                }
                nextAllowed.setHours(Math.floor(end / 60), end % 60, 0, 0);
                return nextAllowed.getTime();
            }
        } else {
            if (currentMinutes >= start && currentMinutes < end) {
                const now = new Date();
                const nextAllowed = new Date(now);
                nextAllowed.setHours(Math.floor(end / 60), end % 60, 0, 0);
                return nextAllowed.getTime();
            }
        }
    }

    return null;
}

/**
 * Get midnight timestamp for tomorrow
 */
export function getTomorrowMidnight() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime();
}

// =====================
// Storage Operations
// =====================

/**
 * Initialize storage with defaults
 */
export async function initializeStorage() {
    const data = await chrome.storage.local.get(null);
    const updates = {};

    if (!data[STORAGE_KEYS.CATEGORIES]) {
        updates[STORAGE_KEYS.CATEGORIES] = DEFAULT_CATEGORIES;
    }

    if (!data[STORAGE_KEYS.USAGE]) {
        updates[STORAGE_KEYS.USAGE] = {};
    }

    if (!data[STORAGE_KEYS.ACTIVE_STATE]) {
        updates[STORAGE_KEYS.ACTIVE_STATE] = {};
    }

    if (!data[STORAGE_KEYS.SETTINGS]) {
        updates[STORAGE_KEYS.SETTINGS] = DEFAULT_SETTINGS;
    }

    if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
    }

    return { ...data, ...updates };
}

/**
 * Get all categories configuration
 */
export async function getCategories() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.CATEGORIES);
    return data[STORAGE_KEYS.CATEGORIES] || DEFAULT_CATEGORIES;
}

/**
 * Update a category configuration
 */
export async function updateCategory(categoryKey, config) {
    const categories = await getCategories();
    categories[categoryKey] = { ...categories[categoryKey], ...config };
    await chrome.storage.local.set({ [STORAGE_KEYS.CATEGORIES]: categories });
    return categories[categoryKey];
}

/**
 * Find category for a domain
 */
export async function getCategoryForDomain(domain) {
    const categories = await getCategories();

    for (const [key, category] of Object.entries(categories)) {
        if (category.domains.some(d => domain.includes(d) || d.includes(domain))) {
            return { key, ...category };
        }
    }

    return null;
}

/**
 * Get settings
 */
export async function getSettings() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return data[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
}

/**
 * Update settings
 */
export async function updateSettings(newSettings) {
    const settings = await getSettings();
    const updated = { ...settings, ...newSettings };
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: updated });
    return updated;
}

// =====================
// Usage Tracking
// =====================

/**
 * Get usage for today
 */
export async function getTodayUsage() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();
    return usage[todayKey] || {};
}

/**
 * Get usage for a specific category today
 */
export async function getCategoryUsage(categoryKey) {
    const todayUsage = await getTodayUsage();
    return todayUsage[categoryKey] || { totalTime: 0, sessions: [] };
}

/**
 * Add time to a category
 */
export async function addCategoryTime(categoryKey, seconds) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();

    if (!usage[todayKey]) usage[todayKey] = {};
    if (!usage[todayKey][categoryKey]) {
        usage[todayKey][categoryKey] = { totalTime: 0, sessions: [] };
    }

    usage[todayKey][categoryKey].totalTime += seconds;

    await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: usage });
    return usage[todayKey][categoryKey];
}

/**
 * Start a new session for a category
 */
export async function startCategorySession(categoryKey) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();

    if (!usage[todayKey]) usage[todayKey] = {};
    if (!usage[todayKey][categoryKey]) {
        usage[todayKey][categoryKey] = { totalTime: 0, sessions: [] };
    }

    const session = {
        start: Date.now(),
        end: null,
        duration: 0
    };

    usage[todayKey][categoryKey].sessions.push(session);
    await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: usage });

    return session;
}

/**
 * End current session for a category
 */
export async function endCategorySession(categoryKey) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();

    if (usage[todayKey]?.[categoryKey]?.sessions) {
        const sessions = usage[todayKey][categoryKey].sessions;
        const lastSession = sessions[sessions.length - 1];

        if (lastSession && !lastSession.end) {
            lastSession.end = Date.now();
            lastSession.duration = Math.floor((lastSession.end - lastSession.start) / 1000);
            await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: usage });
            return lastSession;
        }
    }

    return null;
}

// =====================
// Active State Management
// =====================

/**
 * Get active state for all categories
 */
export async function getActiveState() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE_STATE);
    return data[STORAGE_KEYS.ACTIVE_STATE] || {};
}

/**
 * Get active state for a specific category
 */
export async function getCategoryActiveState(categoryKey) {
    const state = await getActiveState();
    return state[categoryKey] || {
        inSession: false,
        sessionStart: null,
        inRest: false,
        restEnd: null
    };
}

/**
 * Update active state for a category
 */
export async function updateCategoryActiveState(categoryKey, newState) {
    const state = await getActiveState();
    state[categoryKey] = { ...state[categoryKey], ...newState };
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_STATE]: state });
    return state[categoryKey];
}

/**
 * Clear all active states (for daily reset)
 */
export async function clearActiveStates() {
    await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_STATE]: {} });
}

// =====================
// Daily Reset
// =====================

/**
 * Perform daily reset - clear today's usage and active states
 */
export async function performDailyReset() {
    await clearActiveStates();
    // Usage is keyed by date, so old data naturally stays separate
    console.log('Daily reset completed');
}

/**
 * Clean up old usage data (keep last 30 days)
 */
export async function cleanupOldData(retentionDays = 30) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    let hasChanges = false;
    for (const dateKey of Object.keys(usage)) {
        if (new Date(dateKey) < cutoff) {
            delete usage[dateKey];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: usage });
    }
}

export { STORAGE_KEYS, DEFAULT_CATEGORIES, DEFAULT_SETTINGS };
