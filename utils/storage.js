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
    SETTINGS: 'settings',
    DOMAIN_LIMITS: 'domainLimits'  // Per-domain time limits
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
    strictMode: false,  // If true, forbidden periods block immediately
    weekStartsOnMonday: true  // Week starts on Monday (ISO standard)
};

// Data retention: 1 month
const DATA_RETENTION_DAYS = 31;

// =====================
// Storage Cache & Batch Write
// =====================

// In-memory cache for frequently accessed data
const storageCache = {
    usage: null,
    activeState: null,
    categories: null,
    lastUsageWrite: 0,
    pendingTimeUpdates: new Map(), // categoryKey -> seconds to add
    pendingDomainUpdates: new Map(), // "categoryKey:domain" -> seconds to add
    writeInterval: null
};

// Batch write interval (write to storage every 10 seconds if there are pending changes)
const BATCH_WRITE_INTERVAL = 10000;

/**
 * Initialize the batch write system
 */
function initBatchWriteSystem() {
    if (storageCache.writeInterval) return;

    storageCache.writeInterval = setInterval(async () => {
        await flushPendingTimeUpdates();
    }, BATCH_WRITE_INTERVAL);
}

/**
 * Flush all pending time updates to storage (both category and domain level)
 */
async function flushPendingTimeUpdates() {
    if (storageCache.pendingTimeUpdates.size === 0 && storageCache.pendingDomainUpdates.size === 0) return;

    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();

    if (!usage[todayKey]) usage[todayKey] = {};

    let hasChanges = false;

    // Flush category-level time updates
    for (const [categoryKey, seconds] of storageCache.pendingTimeUpdates.entries()) {
        if (!usage[todayKey][categoryKey]) {
            usage[todayKey][categoryKey] = { totalTime: 0, sessions: [], byDomain: {} };
        }
        if (!usage[todayKey][categoryKey].byDomain) {
            usage[todayKey][categoryKey].byDomain = {};
        }
        usage[todayKey][categoryKey].totalTime += seconds;
        hasChanges = true;
    }

    // Flush domain-level time updates
    for (const [key, seconds] of storageCache.pendingDomainUpdates.entries()) {
        const [categoryKey, domain] = key.split(':');
        if (!usage[todayKey][categoryKey]) {
            usage[todayKey][categoryKey] = { totalTime: 0, sessions: [], byDomain: {} };
        }
        if (!usage[todayKey][categoryKey].byDomain) {
            usage[todayKey][categoryKey].byDomain = {};
        }
        usage[todayKey][categoryKey].byDomain[domain] =
            (usage[todayKey][categoryKey].byDomain[domain] || 0) + seconds;
        hasChanges = true;
    }

    if (hasChanges) {
        await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: usage });
        storageCache.usage = usage;
        storageCache.lastUsageWrite = Date.now();
        console.log(`[StorageCache] Flushed ${storageCache.pendingTimeUpdates.size} category updates, ${storageCache.pendingDomainUpdates.size} domain updates`);
    }

    storageCache.pendingTimeUpdates.clear();
    storageCache.pendingDomainUpdates.clear();
}

/**
 * Get cached usage data (reads from storage if cache is stale)
 */
async function getCachedUsage() {
    // Cache for 5 seconds
    if (!storageCache.usage || Date.now() - storageCache.lastUsageWrite > 5000) {
        const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
        storageCache.usage = data[STORAGE_KEYS.USAGE] || {};
    }
    return storageCache.usage;
}

// Initialize batch write system when module loads
initBatchWriteSystem();

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
 * Get yesterday's date key in YYYY-MM-DD format (local time)
 */
export function getYesterdayKey() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
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
 * Match a hostname against a configured domain pattern
 * Uses strict matching to prevent false positives
 * 
 * @param {string} hostname - The hostname to check (e.g., "video.youtube.com")
 * @param {string} pattern - The domain pattern (e.g., "youtube.com")
 * @returns {boolean} - True if hostname matches the pattern
 * 
 * Examples:
 *   matchDomain("youtube.com", "youtube.com") => true
 *   matchDomain("www.youtube.com", "youtube.com") => true (www already stripped)
 *   matchDomain("video.youtube.com", "youtube.com") => true (subdomain)
 *   matchDomain("notyoutube.com", "youtube.com") => false
 *   matchDomain("youtube.com.evil.com", "youtube.com") => false
 */
export function matchDomain(hostname, pattern) {
    // Normalize both to lowercase
    hostname = hostname.toLowerCase();
    pattern = pattern.toLowerCase();

    // Exact match
    if (hostname === pattern) {
        return true;
    }

    // Check if hostname is a subdomain of pattern
    // hostname must end with ".pattern"
    if (hostname.endsWith('.' + pattern)) {
        return true;
    }

    return false;
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

    if (!data[STORAGE_KEYS.DOMAIN_LIMITS]) {
        updates[STORAGE_KEYS.DOMAIN_LIMITS] = {};
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
 * Uses strict domain matching to prevent false positives
 */
export async function getCategoryForDomain(domain) {
    const categories = await getCategories();

    for (const [key, category] of Object.entries(categories)) {
        if (category.domains.some(d => matchDomain(domain, d))) {
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
 * IMPORTANT: Includes pending (unflushed) time for accurate limit checking
 */
export async function getCategoryUsage(categoryKey) {
    const todayUsage = await getTodayUsage();
    const baseUsage = todayUsage[categoryKey] || { totalTime: 0, sessions: [] };

    // Include pending time in the returned total for accurate limit checking
    const pendingTime = storageCache.pendingTimeUpdates.get(categoryKey) || 0;
    const totalWithPending = baseUsage.totalTime + pendingTime;

    return {
        totalTime: totalWithPending,
        sessions: baseUsage.sessions
    };
}

/**
 * Add time to a category (uses batched writes for efficiency)
 * Time is accumulated in memory and periodically flushed to storage
 */
export async function addCategoryTime(categoryKey, seconds) {
    const todayKey = getTodayKey();

    // Add to pending updates (will be flushed periodically)
    const currentPending = storageCache.pendingTimeUpdates.get(categoryKey) || 0;
    storageCache.pendingTimeUpdates.set(categoryKey, currentPending + seconds);

    // Get current usage from cache or storage
    const usage = await getCachedUsage();

    if (!usage[todayKey]) usage[todayKey] = {};
    if (!usage[todayKey][categoryKey]) {
        usage[todayKey][categoryKey] = { totalTime: 0, sessions: [] };
    }

    // Include pending time in the returned total for accurate limit checking
    const pendingTime = storageCache.pendingTimeUpdates.get(categoryKey) || 0;
    const totalWithPending = usage[todayKey][categoryKey].totalTime + pendingTime;

    // If we're close to a limit, flush immediately to ensure accuracy
    // This prevents users from exceeding limits due to batching delays
    const categories = await getCategories();
    const category = categories[categoryKey];
    if (category?.dailyLimit && totalWithPending >= category.dailyLimit * 0.95) {
        await flushPendingTimeUpdates();
    }

    return {
        totalTime: totalWithPending,
        sessions: usage[todayKey][categoryKey].sessions
    };
}

/**
 * Add time immediately without batching (used for critical updates)
 */
export async function addCategoryTimeImmediate(categoryKey, seconds) {
    // Flush any pending updates first
    await flushPendingTimeUpdates();

    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();

    if (!usage[todayKey]) usage[todayKey] = {};
    if (!usage[todayKey][categoryKey]) {
        usage[todayKey][categoryKey] = { totalTime: 0, sessions: [] };
    }

    usage[todayKey][categoryKey].totalTime += seconds;

    await chrome.storage.local.set({ [STORAGE_KEYS.USAGE]: usage });
    storageCache.usage = usage;

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

/**
 * End session for a category on a specific date key
 * Used during daily reset to close sessions from the previous day
 */
export async function endCategorySessionForDate(categoryKey, dateKey) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};

    if (usage[dateKey]?.[categoryKey]?.sessions) {
        const sessions = usage[dateKey][categoryKey].sessions;
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
 * Perform daily reset - end all active sessions and clear active states
 * This handles the midnight transition properly:
 * 1. End sessions from the previous day with proper accounting
 * 2. Clear rest periods but preserve session state for continuation if needed
 */
export async function performDailyReset() {
    // First, flush any pending time updates to ensure data integrity
    await flushPendingTimeUpdates();

    const now = Date.now();
    const activeState = await getActiveState();
    const yesterdayKey = getYesterdayKey();
    const todayKey = getTodayKey();

    console.log(`[DailyReset] Starting reset. Yesterday: ${yesterdayKey}, Today: ${todayKey}`);

    // Process each category's active state
    for (const [categoryKey, state] of Object.entries(activeState)) {
        if (state.inSession && state.sessionStart) {
            // Calculate how much of the session was in yesterday
            const midnightToday = new Date();
            midnightToday.setHours(0, 0, 0, 0);
            const midnightTimestamp = midnightToday.getTime();

            // End the session using yesterday's date key
            await endCategorySessionForDate(categoryKey, yesterdayKey);

            console.log(`[DailyReset] Ended session for ${categoryKey} from yesterday`);
        }

        // Clear rest periods - they don't carry over to the new day
        if (state.inRest) {
            console.log(`[DailyReset] Clearing rest period for ${categoryKey}`);
        }
    }

    // Clear all active states for the new day
    // Users will start fresh sessions when they visit sites
    await clearActiveStates();

    // Clear the usage cache to force fresh read
    storageCache.usage = null;

    console.log('[DailyReset] Daily reset completed - all sessions ended and states cleared');
}

/**
 * Check and handle date change (useful for tabs that span midnight)
 * Returns true if date changed
 */
export async function checkAndHandleDateChange(lastKnownDateKey) {
    const currentDateKey = getTodayKey();

    if (currentDateKey !== lastKnownDateKey) {
        console.log(`[DateChange] Date changed from ${lastKnownDateKey} to ${currentDateKey}`);
        await performDailyReset();
        return { changed: true, newDateKey: currentDateKey };
    }

    return { changed: false, newDateKey: currentDateKey };
}

/**
 * Clean up old usage data (keep last DATA_RETENTION_DAYS days)
 */
export async function cleanupOldData(retentionDays = DATA_RETENTION_DAYS) {
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

// =====================
// Domain-Level Time Tracking
// =====================

/**
 * Add time to a specific domain within a category (batched)
 * This enables per-site statistics while maintaining category totals
 */
export async function addDomainTime(categoryKey, domain, seconds) {
    const key = `${categoryKey}:${domain}`;

    // Add to pending updates (will be flushed periodically)
    const currentPending = storageCache.pendingDomainUpdates.get(key) || 0;
    storageCache.pendingDomainUpdates.set(key, currentPending + seconds);

    // Get current usage including pending time
    const todayKey = getTodayKey();
    const usage = await getCachedUsage();

    const storedTime = usage[todayKey]?.[categoryKey]?.byDomain?.[domain] || 0;
    const pendingTime = storageCache.pendingDomainUpdates.get(key) || 0;
    const totalWithPending = storedTime + pendingTime;

    // Check domain limit and flush if close to limit
    const limit = await getDomainLimit(domain);
    if (limit?.dailyLimit && totalWithPending >= limit.dailyLimit * 0.95) {
        await flushPendingTimeUpdates();
    }

    return totalWithPending;
}

/**
 * Get time usage for a specific domain today (includes pending time)
 */
export async function getDomainUsage(domain) {
    const todayUsage = await getTodayUsage();
    let totalTime = 0;
    let categoryKey = null;

    for (const [key, categoryUsage] of Object.entries(todayUsage)) {
        if (categoryUsage.byDomain && categoryUsage.byDomain[domain]) {
            totalTime = categoryUsage.byDomain[domain];
            categoryKey = key;
            break;
        }
    }

    // Include pending time
    for (const [pendingKey, seconds] of storageCache.pendingDomainUpdates.entries()) {
        const [catKey, dom] = pendingKey.split(':');
        if (dom === domain) {
            totalTime += seconds;
            if (!categoryKey) categoryKey = catKey;
            break;
        }
    }

    return { totalTime, categoryKey };
}

/**
 * Get all domain usage for a date range
 */
export async function getDomainUsageForDateRange(startDate, endDate) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const result = {};

    for (const [dateKey, dayUsage] of Object.entries(usage)) {
        const date = new Date(dateKey);
        if (date >= startDate && date <= endDate) {
            for (const [categoryKey, categoryUsage] of Object.entries(dayUsage)) {
                if (categoryUsage.byDomain) {
                    for (const [domain, time] of Object.entries(categoryUsage.byDomain)) {
                        if (!result[domain]) {
                            result[domain] = { totalTime: 0, byDate: {}, categoryKey };
                        }
                        result[domain].totalTime += time;
                        result[domain].byDate[dateKey] = (result[domain].byDate[dateKey] || 0) + time;
                    }
                }
            }
        }
    }

    return result;
}

// =====================
// Domain-Level Limits
// =====================

/**
 * Get all domain-specific limits
 */
export async function getDomainLimits() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.DOMAIN_LIMITS);
    return data[STORAGE_KEYS.DOMAIN_LIMITS] || {};
}

/**
 * Set limit for a specific domain
 * @param {string} domain - The domain to limit
 * @param {number|null} dailyLimit - Daily limit in seconds, or null to remove
 */
export async function setDomainLimit(domain, dailyLimit) {
    const limits = await getDomainLimits();

    if (dailyLimit === null || dailyLimit === undefined) {
        delete limits[domain];
    } else {
        limits[domain] = { dailyLimit };
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.DOMAIN_LIMITS]: limits });
    return limits;
}

/**
 * Get limit for a specific domain
 */
export async function getDomainLimit(domain) {
    const limits = await getDomainLimits();
    return limits[domain] || null;
}

/**
 * Check if domain has reached its individual limit
 * @returns {{ allowed: boolean, remaining: number, limit: number } | null}
 */
export async function checkDomainLimit(domain) {
    const limit = await getDomainLimit(domain);
    if (!limit) return null;  // No individual limit set

    const usage = await getDomainUsage(domain);
    const remaining = Math.max(0, limit.dailyLimit - usage.totalTime);

    return {
        allowed: usage.totalTime < limit.dailyLimit,
        remaining,
        limit: limit.dailyLimit,
        used: usage.totalTime
    };
}

// =====================
// Statistics Helpers
// =====================

/**
 * Get date range for current week (Monday to Sunday)
 */
export function getCurrentWeekRange() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ...

    // Calculate days since Monday (week starts on Monday)
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const monday = new Date(now);
    monday.setDate(now.getDate() - daysSinceMonday);
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    return { start: monday, end: sunday };
}

/**
 * Get date range for current month
 */
export function getCurrentMonthRange() {
    const now = new Date();

    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    firstDay.setHours(0, 0, 0, 0);

    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    lastDay.setHours(23, 59, 59, 999);

    return { start: firstDay, end: lastDay };
}

/**
 * Get usage statistics for a date range
 * Returns both category-level and domain-level stats
 * IMPORTANT: Includes pending (unflushed) time for today to ensure accurate display
 */
export async function getUsageStats(startDate, endDate) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.USAGE);
    const usage = data[STORAGE_KEYS.USAGE] || {};
    const todayKey = getTodayKey();

    const stats = {
        totalTime: 0,
        byCategory: {},
        byDomain: {},
        byDate: {}
    };

    for (const [dateKey, dayUsage] of Object.entries(usage)) {
        const date = new Date(dateKey);
        if (date >= startDate && date <= endDate) {
            stats.byDate[dateKey] = { totalTime: 0, byCategory: {}, byDomain: {} };

            for (const [categoryKey, categoryUsage] of Object.entries(dayUsage)) {
                let categoryTime = categoryUsage.totalTime || 0;

                // Include pending time for today's data
                if (dateKey === todayKey) {
                    const pendingTime = storageCache.pendingTimeUpdates.get(categoryKey) || 0;
                    categoryTime += pendingTime;
                }

                // Category stats
                stats.byCategory[categoryKey] = (stats.byCategory[categoryKey] || 0) + categoryTime;
                stats.byDate[dateKey].byCategory[categoryKey] = categoryTime;
                stats.byDate[dateKey].totalTime += categoryTime;
                stats.totalTime += categoryTime;

                // Domain stats
                if (categoryUsage.byDomain) {
                    for (const [domain, domainTime] of Object.entries(categoryUsage.byDomain)) {
                        let actualDomainTime = domainTime;

                        // Include pending domain time for today's data
                        if (dateKey === todayKey) {
                            const pendingKey = `${categoryKey}:${domain}`;
                            const pendingDomainTime = storageCache.pendingDomainUpdates.get(pendingKey) || 0;
                            actualDomainTime += pendingDomainTime;
                        }

                        stats.byDomain[domain] = (stats.byDomain[domain] || 0) + actualDomainTime;
                        stats.byDate[dateKey].byDomain[domain] = (stats.byDate[dateKey].byDomain[domain] || 0) + actualDomainTime;
                    }
                }
            }

            // Also check for pending time in categories not yet in storage for today
            if (dateKey === todayKey) {
                for (const [categoryKey, pendingTime] of storageCache.pendingTimeUpdates.entries()) {
                    if (!dayUsage[categoryKey]) {
                        // This category has pending time but no stored data yet
                        stats.byCategory[categoryKey] = (stats.byCategory[categoryKey] || 0) + pendingTime;
                        stats.byDate[dateKey].byCategory[categoryKey] = (stats.byDate[dateKey].byCategory[categoryKey] || 0) + pendingTime;
                        stats.byDate[dateKey].totalTime += pendingTime;
                        stats.totalTime += pendingTime;
                    }
                }
            }
        }
    }

    // Handle case where today has pending time but no storage entry yet
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (today >= startDate && today <= endDate && !stats.byDate[todayKey] && storageCache.pendingTimeUpdates.size > 0) {
        stats.byDate[todayKey] = { totalTime: 0, byCategory: {}, byDomain: {} };

        for (const [categoryKey, pendingTime] of storageCache.pendingTimeUpdates.entries()) {
            stats.byCategory[categoryKey] = (stats.byCategory[categoryKey] || 0) + pendingTime;
            stats.byDate[todayKey].byCategory[categoryKey] = pendingTime;
            stats.byDate[todayKey].totalTime += pendingTime;
            stats.totalTime += pendingTime;
        }

        for (const [key, pendingTime] of storageCache.pendingDomainUpdates.entries()) {
            const [, domain] = key.split(':');
            stats.byDomain[domain] = (stats.byDomain[domain] || 0) + pendingTime;
            stats.byDate[todayKey].byDomain[domain] = (stats.byDate[todayKey].byDomain[domain] || 0) + pendingTime;
        }
    }

    return stats;
}


/**
 * Get today's statistics
 */
export async function getTodayStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    return getUsageStats(today, endOfDay);
}

/**
 * Get this week's statistics
 */
export async function getWeekStats() {
    const { start, end } = getCurrentWeekRange();
    return getUsageStats(start, end);
}

/**
 * Get this month's statistics
 */
export async function getMonthStats() {
    const { start, end } = getCurrentMonthRange();
    return getUsageStats(start, end);
}

/**
 * Get pending (unflushed) time updates for all categories
 * Used by options page to display accurate usage including pending time
 * @returns {Object} Map of categoryKey -> pending seconds
 */
export function getPendingTimeUpdates() {
    const pending = {};
    for (const [categoryKey, seconds] of storageCache.pendingTimeUpdates.entries()) {
        pending[categoryKey] = seconds;
    }
    return pending;
}

export { STORAGE_KEYS, DEFAULT_CATEGORIES, DEFAULT_SETTINGS, DATA_RETENTION_DAYS };

