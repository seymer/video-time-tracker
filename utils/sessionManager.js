/**
 * Session Manager - Handles session logic, limits, and access control
 * Implements session-based limits with mandatory rest periods
 */

import {
    getCategories,
    getCategoryForDomain,
    getCategoryUsage,
    getCategoryActiveState,
    updateCategoryActiveState,
    startCategorySession,
    endCategorySession,
    addCategoryTime,
    isInForbiddenPeriod,
    getNextAllowedTime,
    getTomorrowMidnight,
    formatTime
} from './storage.js';

/**
 * Check if access to a category is allowed
 * Returns detailed status including reason for blocking
 */
export async function canAccessCategory(categoryKey) {
    const categories = await getCategories();
    const category = categories[categoryKey];

    if (!category || !category.enabled) {
        return { allowed: true, hasLimits: false };
    }

    const usage = await getCategoryUsage(categoryKey);
    const activeState = await getCategoryActiveState(categoryKey);
    const now = Date.now();

    // Check 1: Forbidden time period
    if (isInForbiddenPeriod(category.forbiddenPeriods)) {
        return {
            allowed: false,
            reason: 'forbidden_period',
            reasonText: 'This site is blocked during this time period',
            nextAvailable: getNextAllowedTime(category.forbiddenPeriods),
            category
        };
    }

    // Check 2: Currently in rest period
    if (activeState.inRest && activeState.restEnd) {
        if (now < activeState.restEnd) {
            const restRemaining = Math.ceil((activeState.restEnd - now) / 1000);
            return {
                allowed: false,
                reason: 'rest_period',
                reasonText: 'Taking a mandatory break',
                restRemaining,
                restRemainingFormatted: formatTime(restRemaining),
                nextAvailable: activeState.restEnd,
                category
            };
        } else {
            // Rest period ended, clear it
            await updateCategoryActiveState(categoryKey, {
                inRest: false,
                restEnd: null
            });
        }
    }

    // Check 3: Daily total limit
    if (category.dailyLimit && usage.totalTime >= category.dailyLimit) {
        return {
            allowed: false,
            reason: 'daily_limit',
            reasonText: 'Daily time limit reached',
            nextAvailable: getTomorrowMidnight(),
            totalTime: usage.totalTime,
            dailyLimit: category.dailyLimit,
            category
        };
    }

    // Check 4: Session count limit
    const completedSessions = usage.sessions.filter(s => s.end).length;
    const totalSessionsUsed = completedSessions + (activeState.inSession ? 1 : 0);

    if (category.sessionCount && totalSessionsUsed >= category.sessionCount && !activeState.inSession) {
        return {
            allowed: false,
            reason: 'sessions_exhausted',
            reasonText: `All ${category.sessionCount} sessions used today`,
            nextAvailable: getTomorrowMidnight(),
            sessionsUsed: completedSessions,
            sessionsTotal: category.sessionCount,
            category
        };
    }

    // Access allowed - calculate remaining time
    const dailyRemaining = category.dailyLimit
        ? category.dailyLimit - usage.totalTime
        : null;

    let sessionRemaining = null;
    if (category.sessionDuration && activeState.inSession) {
        // Use effective time spent in session, not wall-clock time
        const sessionEffectiveTime = activeState.sessionEffectiveTime || 0;
        sessionRemaining = Math.max(0, category.sessionDuration - sessionEffectiveTime);
    } else if (category.sessionDuration) {
        sessionRemaining = category.sessionDuration;
    }

    const sessionsRemaining = category.sessionCount
        ? category.sessionCount - totalSessionsUsed
        : null;

    return {
        allowed: true,
        hasLimits: true,
        inSession: activeState.inSession,
        sessionRemaining,
        sessionRemainingFormatted: sessionRemaining ? formatTime(sessionRemaining) : null,
        dailyRemaining,
        dailyRemainingFormatted: dailyRemaining ? formatTime(dailyRemaining) : null,
        sessionsRemaining,
        totalTime: usage.totalTime,
        isWarning: sessionRemaining !== null && sessionRemaining <= 60, // 1 min warning
        category
    };
}

/**
 * Start a session for a category
 */
export async function startSession(categoryKey) {
    const access = await canAccessCategory(categoryKey);

    if (!access.allowed) {
        return { success: false, ...access };
    }

    const activeState = await getCategoryActiveState(categoryKey);

    // Already in session
    if (activeState.inSession) {
        return { success: true, alreadyActive: true };
    }

    // Start new session
    await startCategorySession(categoryKey);
    await updateCategoryActiveState(categoryKey, {
        inSession: true,
        sessionStart: Date.now(),
        sessionEffectiveTime: 0,  // Track effective time spent in this session
        inRest: false,
        restEnd: null
    });

    return { success: true, sessionStart: Date.now() };
}

/**
 * End a session and optionally start rest period
 */
export async function endSession(categoryKey, triggerRest = false) {
    const categories = await getCategories();
    const category = categories[categoryKey];

    await endCategorySession(categoryKey);

    const updates = {
        inSession: false,
        sessionStart: null
    };

    if (triggerRest && category?.restDuration) {
        updates.inRest = true;
        updates.restEnd = Date.now() + (category.restDuration * 1000);
    }

    await updateCategoryActiveState(categoryKey, updates);

    return {
        success: true,
        restStarted: triggerRest && !!category?.restDuration,
        restEnd: updates.restEnd
    };
}

/**
 * Add effective time to a category and check limits.
 * Caps the add at the daily limit so we never exceed it (avoids e.g. 1h 33m when limit is 1h 30m).
 */
export async function addEffectiveTime(categoryKey, seconds) {
    const categories = await getCategories();
    const category = categories[categoryKey];

    if (!category || !category.enabled) {
        return { allowed: true };
    }

    // Get current usage BEFORE adding so we can cap and never exceed the daily limit
    const currentUsage = await getCategoryUsage(categoryKey);
    let secondsToAdd = seconds;
    if (category.dailyLimit != null && category.dailyLimit > 0) {
        const headroom = Math.max(0, category.dailyLimit - currentUsage.totalTime);
        if (seconds > headroom) {
            secondsToAdd = headroom;
        }
    }

    // Add only the capped time to daily total
    const usage = await addCategoryTime(categoryKey, secondsToAdd);
    let activeState = await getCategoryActiveState(categoryKey);

    // Also track effective time within the current session (use capped value so session time stays accurate)
    if (activeState.inSession) {
        const newSessionTime = (activeState.sessionEffectiveTime || 0) + secondsToAdd;
        await updateCategoryActiveState(categoryKey, {
            sessionEffectiveTime: newSessionTime
        });
        activeState.sessionEffectiveTime = newSessionTime;
    }

    // Check if session duration exceeded (using EFFECTIVE time, not wall-clock)
    if (category.sessionDuration && activeState.inSession) {
        const sessionEffectiveTime = activeState.sessionEffectiveTime || 0;

        if (sessionEffectiveTime >= category.sessionDuration) {
            // Session limit reached, trigger rest
            await endSession(categoryKey, true);

            return {
                allowed: false,
                reason: 'session_limit_reached',
                reasonText: 'Session time limit reached. Take a break!',
                sessionEnded: true,
                restStarted: true,
                restDuration: category.restDuration,
                sessionEffectiveTime
            };
        }
    }

    // Check if daily limit exceeded (we cap adds so this is exactly at limit when we capped)
    if (category.dailyLimit && usage.totalTime >= category.dailyLimit) {
        await endSession(categoryKey, false);

        return {
            allowed: false,
            reason: 'daily_limit_reached',
            reasonText: 'Daily time limit reached',
            sessionEnded: true,
            totalTime: usage.totalTime,
            dailyLimit: category.dailyLimit
        };
    }

    // Still within limits
    const access = await canAccessCategory(categoryKey);
    return {
        allowed: true,
        ...access,
        timeAdded: secondsToAdd,
        newTotal: usage.totalTime,
        sessionEffectiveTime: activeState.sessionEffectiveTime || 0
    };
}

/**
 * Get comprehensive status for a category (for UI display)
 */
export async function getCategoryStatus(categoryKey) {
    const categories = await getCategories();
    const category = categories[categoryKey];

    if (!category) {
        return { exists: false };
    }

    const usage = await getCategoryUsage(categoryKey);
    const activeState = await getCategoryActiveState(categoryKey);
    const access = await canAccessCategory(categoryKey);

    const completedSessions = usage.sessions.filter(s => s.end).length;

    return {
        exists: true,
        category,
        usage: {
            totalTime: usage.totalTime,
            totalTimeFormatted: formatTime(usage.totalTime),
            sessionsCompleted: completedSessions,
            sessionsTotal: category.sessionCount
        },
        state: activeState,
        access,
        limits: {
            dailyLimit: category.dailyLimit,
            dailyLimitFormatted: formatTime(category.dailyLimit),
            sessionDuration: category.sessionDuration,
            sessionDurationFormatted: formatTime(category.sessionDuration),
            restDuration: category.restDuration,
            restDurationFormatted: formatTime(category.restDuration)
        }
    };
}

/**
 * Check if rest period has ended for all categories
 * Called periodically by background to update states
 */
export async function checkRestPeriods() {
    const categories = await getCategories();
    const now = Date.now();
    const endedRests = [];

    for (const categoryKey of Object.keys(categories)) {
        const activeState = await getCategoryActiveState(categoryKey);

        if (activeState.inRest && activeState.restEnd && now >= activeState.restEnd) {
            await updateCategoryActiveState(categoryKey, {
                inRest: false,
                restEnd: null
            });
            endedRests.push(categoryKey);
        }
    }

    return endedRests;
}
