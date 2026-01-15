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
    formatTime
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

                    if (category.domains.some(d => domain.includes(d))) {
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
                return await handleAddTime(message.categoryKey, message.seconds, sender);

            case 'GET_STATUS':
                return await getCategoryStatus(message.categoryKey);

            case 'GET_ALL_STATUS':
                return await getAllCategoryStatus();

            case 'CHECK_DATE':
                return await checkDateChange();

            default:
                console.warn('Unknown message type:', message.type);
                return { error: 'Unknown message type' };
        }
    } catch (error) {
        console.error('Error in handleMessage:', error);
        throw error;
    }
}

async function handleAddTime(categoryKey, seconds, sender) {
    try {
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

            if (category.domains.some(d => domain.includes(d))) {
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
