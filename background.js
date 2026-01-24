/**
 * Background Service Worker
 * Handles global state, cross-tab coordination, daily reset, and timers
 */

import {
    initializeStorage,
    getTodayKey,
    getCategories,
    getCategoryForDomain,
    performDailyReset,
    cleanupOldData,
    getCategoryActiveState,
    updateCategoryActiveState,
    formatTime,
    matchDomain,
    addDomainTime,
    checkDomainLimit,
    getDomainLimits,
    setDomainLimit,
    getTodayStats,
    getWeekStats,
    getMonthStats
} from './utils/storage.js';

import {
    canAccessCategory,
    startSession,
    endSession,
    addEffectiveTime,
    getCategoryStatus,
    checkRestPeriods
} from './utils/sessionManager.js';

// =====================
// State
// =====================

let lastDateKey = getTodayKey();

// Track active tabs per category to prevent duplicate time counting
// Map<categoryKey, { tabId, lastActivity }>
const activeTabsPerCategory = new Map();

// =====================
// Initialization
// =====================

chrome.runtime.onInstalled.addListener(async () => {
    console.log('Advanced Time Tracker installed');
    await initializeStorage();
    await setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('Advanced Time Tracker starting');
    await initializeStorage();
    await setupAlarms();
    await cleanupOldData();
    await checkRestPeriods();
});

// =====================
// Alarms
// =====================

async function setupAlarms() {
    // Midnight reset alarm
    chrome.alarms.create('midnightReset', {
        when: getMidnightTimestamp(),
        periodInMinutes: 24 * 60
    });

    // Check rest periods every minute
    chrome.alarms.create('checkRestPeriods', {
        periodInMinutes: 1
    });

    // Check forbidden periods every minute
    chrome.alarms.create('checkForbiddenPeriods', {
        periodInMinutes: 1
    });

    // Daily cleanup
    chrome.alarms.create('dailyCleanup', {
        periodInMinutes: 24 * 60
    });
}

function getMidnightTimestamp() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    switch (alarm.name) {
        case 'midnightReset':
            await handleMidnightReset();
            break;
        case 'checkRestPeriods':
            await handleCheckRestPeriods();
            break;
        case 'checkForbiddenPeriods':
            await broadcastForbiddenPeriodStatus();
            break;
        case 'dailyCleanup':
            await cleanupOldData();
            break;
    }
});

async function handleMidnightReset() {
    console.log('Midnight reset triggered');
    lastDateKey = getTodayKey();
    await performDailyReset();

    // Notify all tabs about reset
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'DAILY_RESET' });
        } catch (e) {
            // Tab might not have content script
        }
    }
}

async function handleCheckRestPeriods() {
    const endedRests = await checkRestPeriods();

    if (endedRests.length > 0) {
        // Notify tabs that rest periods have ended
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            try {
                await chrome.tabs.sendMessage(tab.id, {
                    type: 'REST_PERIODS_ENDED',
                    categories: endedRests
                });
            } catch (e) {
                // Tab might not have content script
            }
        }
    }
}

async function broadcastForbiddenPeriodStatus() {
    const categories = await getCategories();

    for (const [categoryKey, category] of Object.entries(categories)) {
        const access = await canAccessCategory(categoryKey);

        if (!access.allowed && access.reason === 'forbidden_period') {
            // Notify tabs with this category's domains
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                if (!tab.url) continue;

                try {
                    const url = new URL(tab.url);
                    const domain = url.hostname.replace(/^www\./, '');

                    if (category.domains.some(d => matchDomain(domain, d))) {
                        await chrome.tabs.sendMessage(tab.id, {
                            type: 'FORBIDDEN_PERIOD_ACTIVE',
                            category: categoryKey,
                            ...access
                        });
                    }
                } catch (e) {
                    // Tab might not have content script
                }
            }
        }
    }
}

// =====================
// Message Handling
// =====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then(sendResponse)
        .catch(error => {
            console.error('Error handling message:', message.type, error);
            sendResponse({ error: error.message });
        });
    return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
    try {
        switch (message.type) {
            case 'GET_CATEGORY_FOR_DOMAIN':
                return await getCategoryForDomain(message.domain);

            case 'CAN_ACCESS':
                return await canAccessCategory(message.categoryKey);

            case 'START_SESSION':
                return await startSession(message.categoryKey);

            case 'END_SESSION':
                return await endSession(message.categoryKey, message.triggerRest);

            case 'ADD_TIME':
                return await handleAddTime(message.categoryKey, message.domain, message.seconds, sender);

            case 'GET_STATUS':
                return await getCategoryStatus(message.categoryKey);

            case 'GET_ALL_STATUS':
                return await getAllCategoryStatus();

            case 'CHECK_DATE':
                return await checkDateChange();

            // Tab coordination messages
            case 'REGISTER_TAB':
                return handleRegisterTab(message.categoryKey, sender);

            case 'UNREGISTER_TAB':
                return handleUnregisterTab(message.categoryKey, sender);

            case 'REPORT_ACTIVITY':
                return handleReportActivity(message.categoryKey, message.isActive, sender);

            case 'IS_ACTIVE_TAB':
                return isActiveTabForCategory(message.categoryKey, sender);

            // Statistics messages
            case 'GET_TODAY_STATS':
                return await getTodayStats();

            case 'GET_WEEK_STATS':
                return await getWeekStats();

            case 'GET_MONTH_STATS':
                return await getMonthStats();

            // Domain limit messages
            case 'GET_DOMAIN_LIMITS':
                return await getDomainLimits();

            case 'SET_DOMAIN_LIMIT':
                return await setDomainLimit(message.domain, message.dailyLimit);

            case 'CHECK_DOMAIN_LIMIT':
                return await checkDomainLimit(message.domain);

            default:
                console.warn('Unknown message type:', message.type);
                return { error: 'Unknown message type' };
        }
    } catch (error) {
        console.error('Error in handleMessage:', error);
        throw error;
    }
}

async function handleAddTime(categoryKey, domain, seconds, sender) {
    try {
        const tabId = sender?.tab?.id;

        // Check if this tab is the active tab for this category
        // Only count time from the active tab to prevent duplicate counting
        const isCurrentTabActive = isActiveTabForCategory(categoryKey, sender).isActive;
        
        if (tabId && !isCurrentTabActive) {
            // This tab is not the active one, check if it should become active
            const activeTab = activeTabsPerCategory.get(categoryKey);
            if (!activeTab) {
                // No active tab registered, make this one active
                activeTabsPerCategory.set(categoryKey, {
                    tabId,
                    lastActivity: Date.now()
                });
            } else {
                // Another tab is active, don't count this time
                // But return success so the tab doesn't show errors
                return { allowed: true, skipped: true, reason: 'not_active_tab' };
            }
        }

        // Update last activity time for this tab
        if (tabId) {
            activeTabsPerCategory.set(categoryKey, {
                tabId,
                lastActivity: Date.now()
            });
        }

        // Check domain-specific limit first (takes priority over category limit)
        if (domain) {
            const domainCheck = await checkDomainLimit(domain);
            if (domainCheck && !domainCheck.allowed) {
                // Domain limit reached
                return {
                    allowed: false,
                    reason: 'domain_limit',
                    domain,
                    limit: domainCheck.limit,
                    used: domainCheck.used
                };
            }
            
            // Record domain-level time
            await addDomainTime(categoryKey, domain, seconds);
        }

        const result = await addEffectiveTime(categoryKey, seconds);

        // If limit was reached, broadcast to all tabs with this category
        if (!result.allowed) {
            await broadcastLimitReached(categoryKey, result);
        }

        // Update badge
        await updateBadge(categoryKey, result);

        return result;
    } catch (error) {
        console.error('Error in handleAddTime:', error);
        return { allowed: true, error: error.message };
    }
}

// =====================
// Tab Coordination
// =====================

/**
 * Register a tab as tracking a category
 * If another tab is already active for this category, this tab won't count time
 */
function handleRegisterTab(categoryKey, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { success: false, reason: 'no_tab_id' };

    const existing = activeTabsPerCategory.get(categoryKey);

    if (!existing) {
        // No tab registered yet, this becomes the active tab
        activeTabsPerCategory.set(categoryKey, {
            tabId,
            lastActivity: Date.now()
        });
        console.log(`[TabCoord] Tab ${tabId} registered as active for ${categoryKey}`);
        return { success: true, isActive: true };
    }

    if (existing.tabId === tabId) {
        // Same tab re-registering
        existing.lastActivity = Date.now();
        return { success: true, isActive: true };
    }

    // Another tab is active - check if it's stale (no activity for 30 seconds)
    const staleThreshold = 30000;
    if (Date.now() - existing.lastActivity > staleThreshold) {
        // Take over as active tab
        activeTabsPerCategory.set(categoryKey, {
            tabId,
            lastActivity: Date.now()
        });
        console.log(`[TabCoord] Tab ${tabId} took over as active for ${categoryKey} (previous was stale)`);
        return { success: true, isActive: true };
    }

    // Another tab is active and not stale
    console.log(`[TabCoord] Tab ${tabId} registered as inactive for ${categoryKey} (tab ${existing.tabId} is active)`);
    return { success: true, isActive: false };
}

/**
 * Unregister a tab from tracking
 */
function handleUnregisterTab(categoryKey, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { success: false };

    const existing = activeTabsPerCategory.get(categoryKey);
    if (existing && existing.tabId === tabId) {
        activeTabsPerCategory.delete(categoryKey);
        console.log(`[TabCoord] Tab ${tabId} unregistered from ${categoryKey}`);
    }

    return { success: true };
}

/**
 * Report activity from a tab - used to determine which tab should be active
 */
function handleReportActivity(categoryKey, isActive, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { success: false };

    const existing = activeTabsPerCategory.get(categoryKey);

    if (isActive) {
        if (!existing || existing.tabId === tabId) {
            // This tab is active or becomes active
            activeTabsPerCategory.set(categoryKey, {
                tabId,
                lastActivity: Date.now()
            });
            return { success: true, isActive: true };
        }

        // Another tab is active, check if stale
        const staleThreshold = 10000; // 10 seconds for activity reports
        if (Date.now() - existing.lastActivity > staleThreshold) {
            activeTabsPerCategory.set(categoryKey, {
                tabId,
                lastActivity: Date.now()
            });
            return { success: true, isActive: true };
        }

        return { success: true, isActive: false };
    }

    return { success: true, isActive: existing?.tabId === tabId };
}

/**
 * Check if a tab is the active tab for a category
 */
function isActiveTabForCategory(categoryKey, sender) {
    const tabId = sender?.tab?.id;
    if (!tabId) return { isActive: false };

    const existing = activeTabsPerCategory.get(categoryKey);
    return { isActive: existing?.tabId === tabId };
}

/**
 * Clean up when a tab is closed
 */
function handleTabClosed(tabId) {
    for (const [categoryKey, data] of activeTabsPerCategory.entries()) {
        if (data.tabId === tabId) {
            activeTabsPerCategory.delete(categoryKey);
            console.log(`[TabCoord] Cleaned up tab ${tabId} from ${categoryKey}`);
        }
    }
}

// Listen for tab close events
chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabClosed(tabId);
});

// Listen for tab activation to potentially switch active tracking tab
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        if (!tab.url) return;

        const url = new URL(tab.url);
        const domain = url.hostname.replace(/^www\./, '');
        const category = await getCategoryForDomain(domain);

        if (category) {
            // User switched to a tab with a tracked category
            // Notify the tab that it should try to become active
            try {
                await chrome.tabs.sendMessage(activeInfo.tabId, {
                    type: 'TAB_ACTIVATED'
                });
            } catch (e) {
                // Tab might not have content script
            }
        }
    } catch (e) {
        // Tab might be closed or invalid
    }
});

async function broadcastLimitReached(categoryKey, result) {
    const categories = await getCategories();
    const category = categories[categoryKey];

    if (!category) return;

    const tabs = await chrome.tabs.query({});

    for (const tab of tabs) {
        if (!tab.url) continue;

        try {
            const url = new URL(tab.url);
            const domain = url.hostname.replace(/^www\./, '');

            if (category.domains.some(d => matchDomain(domain, d))) {
                await chrome.tabs.sendMessage(tab.id, {
                    type: 'LIMIT_REACHED',
                    category: categoryKey,
                    ...result
                });
            }
        } catch (e) {
            // Tab might not have content script
        }
    }
}

async function getAllCategoryStatus() {
    const categories = await getCategories();
    const statuses = {};

    for (const categoryKey of Object.keys(categories)) {
        statuses[categoryKey] = await getCategoryStatus(categoryKey);
    }

    return statuses;
}

async function checkDateChange() {
    const currentDateKey = getTodayKey();

    if (currentDateKey !== lastDateKey) {
        await handleMidnightReset();
        return { dateChanged: true, newDate: currentDateKey };
    }

    return { dateChanged: false };
}

// =====================
// Badge Management
// =====================

async function updateBadge(categoryKey, status) {
    if (!status.allowed) {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
        return;
    }

    if (status.isWarning) {
        const minutes = Math.ceil((status.sessionRemaining || 0) / 60);
        chrome.action.setBadgeText({ text: `${minutes}` });
        chrome.action.setBadgeBackgroundColor({ color: '#FFC107' });
        return;
    }

    if (status.sessionRemaining) {
        const minutes = Math.ceil(status.sessionRemaining / 60);
        chrome.action.setBadgeText({ text: `${minutes}` });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
        return;
    }

    chrome.action.setBadgeText({ text: '' });
}

// Initialize on load
(async () => {
    try {
        await initializeStorage();
        console.log('Background service worker ready');
    } catch (error) {
        console.error('Failed to initialize storage:', error);
    }
})();
