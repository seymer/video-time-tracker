/**
 * Content Script - Main tracking and overlay logic
 * Detects category, tracks effective time, and displays blocking overlays
 */

// =====================
// State
// =====================

let currentCategory = null;
let currentCategoryKey = null;
let currentDomain = null;  // Current domain being tracked
let detector = null;
let isBlocked = false;
let overlayElement = null;
let isActiveTab = false;  // Track if this tab is the active one for the category
let countdownInterval = null;
let contextInvalidated = false;  // Track if extension context is invalidated

/**
 * Handle extension context invalidation (happens when extension is reloaded)
 */
function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    console.log('[TimeTracker] Extension context invalidated, stopping tracking');

    // Stop all tracking
    stopTracking();
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }

    // Remove message listener
    try {
        chrome.runtime.onMessage.removeListener(handleBackgroundMessage);
    } catch (e) { }
}

// =====================
// Initialization
// =====================

async function initialize() {
    // Reset context invalidation flag on fresh initialize
    contextInvalidated = false;

    // Clean up any previous state
    cleanup();

    const domain = extractDomain(window.location.href);
    if (!domain) return;

    // Get category for this domain
    const category = await sendMessage({ type: 'GET_CATEGORY_FOR_DOMAIN', domain });

    if (!category) {
        console.log('[TimeTracker] No tracking category for this domain:', domain);
        return;
    }

    currentCategory = category;
    currentCategoryKey = category.key;
    currentDomain = domain;  // Store current domain for time tracking

    // Register this tab with the background
    const registration = await sendMessage({ type: 'REGISTER_TAB', categoryKey: currentCategoryKey });
    isActiveTab = registration?.isActive ?? true;
    console.log(`[TimeTracker] Tab registered for ${currentCategoryKey}, isActive: ${isActiveTab}`);

    // Check domain-specific limit first (takes priority)
    const domainCheck = await sendMessage({ type: 'CHECK_DOMAIN_LIMIT', domain: currentDomain });
    if (domainCheck && !domainCheck.allowed) {
        showBlockedOverlay({
            allowed: false,
            reason: 'domain_limit',
            reasonText: `Daily limit for ${currentDomain} reached`,
            domain: currentDomain,
            limit: domainCheck.limit,
            used: domainCheck.used
        });
        return;
    }

    // Check if we can access this category
    const access = await sendMessage({ type: 'CAN_ACCESS', categoryKey: currentCategoryKey });

    if (!access) {
        console.log('[TimeTracker] Failed to check access for category:', currentCategoryKey);
        return;
    }

    if (!access.allowed) {
        showBlockedOverlay(access);
        return;
    }

    // Start session and detector
    await startTracking();

    // Listen for messages from background
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);

    // Handle SPA navigation using more efficient method
    setupNavigationObserver();
}

/**
 * Clean up resources when re-initializing or leaving
 */
function cleanup() {
    stopTracking();
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    // Unregister from previous category if any
    if (currentCategoryKey) {
        sendMessage({ type: 'UNREGISTER_TAB', categoryKey: currentCategoryKey });
    }
}

// =====================
// Tracking
// =====================

async function startTracking() {
    // Start session in background
    const sessionResult = await sendMessage({ type: 'START_SESSION', categoryKey: currentCategoryKey });
    console.log('[TimeTracker] Session started:', sessionResult);

    // Create the appropriate detector
    detector = createDetector(currentCategory.type, handleTimeUpdate, {
        idleTimeout: currentCategory.idleTimeout || 30
    });

    detector.start();
    console.log(`[TimeTracker] Started ${currentCategory.type} detector for ${currentCategoryKey}`);
}

function stopTracking() {
    if (detector) {
        detector.stop();
        detector = null;
    }
}

async function handleTimeUpdate(seconds) {
    if (isBlocked) return;

    // Report activity to potentially become the active tab
    const activityResult = await sendMessage({
        type: 'REPORT_ACTIVITY',
        categoryKey: currentCategoryKey,
        isActive: true
    });

    // Update our active status
    if (activityResult) {
        isActiveTab = activityResult.isActive;
    }

    const result = await sendMessage({
        type: 'ADD_TIME',
        categoryKey: currentCategoryKey,
        domain: currentDomain,  // Include domain for per-site tracking
        seconds
    });

    // Check for null result (message failed) or blocked
    if (result && !result.allowed && !result.skipped) {
        handleLimitReached(result);
    }
}

// =====================
// Limit Handling
// =====================

function handleLimitReached(result) {
    isBlocked = true;
    stopTracking();

    // Pause any media
    pauseAllMedia();

    // Show overlay
    showBlockedOverlay(result);
}

function pauseAllMedia() {
    // Pause videos
    document.querySelectorAll('video').forEach(v => {
        try { v.pause(); } catch (e) { }
    });

    // Pause audio
    document.querySelectorAll('audio').forEach(a => {
        try { a.pause(); } catch (e) { }
    });
}

// =====================
// Overlay Management
// =====================

function showBlockedOverlay(access) {
    if (overlayElement) return; // Already showing

    isBlocked = true;

    overlayElement = document.createElement('div');
    overlayElement.id = 'time-tracker-overlay';
    overlayElement.className = 'time-tracker-overlay';

    let title = 'Access Blocked';
    let message = access.reasonText || 'Time limit reached';
    let countdown = '';

    if (access.reason === 'forbidden_period') {
        title = '🚫 Blocked Time Period';
        message = 'This site is blocked during this time.';
        if (access.nextAvailable) {
            const nextTime = new Date(access.nextAvailable);
            countdown = `Available at ${nextTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        }
    } else if (access.reason === 'rest_period') {
        title = '☕ Take a Break';
        message = 'Mandatory rest period is active.';
        if (access.restRemaining) {
            countdown = `<span class="countdown" data-end="${Date.now() + access.restRemaining * 1000}">${access.restRemainingFormatted} remaining</span>`;
        }
    } else if (access.reason === 'session_limit_reached') {
        title = '⏰ Session Complete';
        message = 'Your session time limit has been reached.';
        const categories = currentCategory;
        if (categories?.restDuration) {
            countdown = `Take a ${formatSeconds(categories.restDuration)} break`;
        }
    } else if (access.reason === 'daily_limit') {
        title = '📅 Daily Limit Reached';
        message = 'You\'ve used all your time for today.';
        countdown = 'Resets at midnight';
    } else if (access.reason === 'sessions_exhausted') {
        title = '🎯 All Sessions Used';
        message = `You've used all ${access.sessionsTotal} sessions today.`;
        countdown = 'Resets at midnight';
    } else if (access.reason === 'domain_limit') {
        title = '🌐 Website Limit Reached';
        message = access.reasonText || `Daily limit for ${access.domain || 'this site'} reached`;
        countdown = 'Resets at midnight';
    }

    overlayElement.innerHTML = `
        <div class="overlay-content">
            <div class="overlay-icon">${getIconForReason(access.reason)}</div>
            <h1 class="overlay-title">${title}</h1>
            <p class="overlay-message">${message}</p>
            ${countdown ? `<p class="overlay-countdown">${countdown}</p>` : ''}
            <div class="overlay-stats">
                ${(access.totalTime || access.used) ? `<span>Today: ${formatSeconds(access.totalTime || access.used)}</span>` : ''}
                ${(access.dailyLimit || access.limit) ? `<span>Limit: ${formatSeconds(access.dailyLimit || access.limit)}</span>` : ''}
            </div>
        </div>
    `;

    document.body.appendChild(overlayElement);

    // Start countdown timer if applicable
    if (access.restRemaining) {
        startCountdownTimer(access.restRemaining);
    }
}

function hideBlockedOverlay() {
    if (overlayElement) {
        overlayElement.remove();
        overlayElement = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    isBlocked = false;
}

function getIconForReason(reason) {
    const icons = {
        'forbidden_period': '🚫',
        'rest_period': '☕',
        'session_limit_reached': '⏰',
        'daily_limit': '📅',
        'sessions_exhausted': '🎯',
        'domain_limit': '🌐'
    };
    return icons[reason] || '⏳';
}

function startCountdownTimer(seconds) {
    const countdownEl = overlayElement?.querySelector('.countdown');
    if (!countdownEl) return;

    let remaining = seconds;

    // Clear any existing interval
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    countdownInterval = setInterval(() => {
        remaining--;

        if (remaining <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            hideBlockedOverlay();
            // Re-initialize to check if we can now access
            initialize();
            return;
        }

        countdownEl.textContent = `${formatSeconds(remaining)} remaining`;
    }, 1000);
}

// =====================
// Message Handling
// =====================

function handleBackgroundMessage(message) {
    switch (message.type) {
        case 'LIMIT_REACHED':
            if (message.category === currentCategoryKey) {
                handleLimitReached(message);
            }
            break;

        case 'FORBIDDEN_PERIOD_ACTIVE':
            if (message.category === currentCategoryKey) {
                handleLimitReached(message);
            }
            break;

        case 'REST_PERIODS_ENDED':
            if (message.categories.includes(currentCategoryKey)) {
                hideBlockedOverlay();
                initialize();
            }
            break;

        case 'DAILY_RESET':
            hideBlockedOverlay();
            initialize();
            break;

        case 'TAB_ACTIVATED':
            // User switched to this tab - try to become the active tab
            handleTabActivated();
            break;
    }
}

async function handleTabActivated() {
    if (!currentCategoryKey || isBlocked) return;

    // Report activity to try to become active
    const result = await sendMessage({
        type: 'REPORT_ACTIVITY',
        categoryKey: currentCategoryKey,
        isActive: true
    });

    if (result) {
        isActiveTab = result.isActive;
        console.log(`[TimeTracker] Tab activated, isActive: ${isActiveTab}`);
    }
}

async function sendMessage(message) {
    if (contextInvalidated) return null;

    try {
        return await chrome.runtime.sendMessage(message);
    } catch (e) {
        // Check if extension context was invalidated (extension reloaded)
        if (e.message?.includes('Extension context invalidated') ||
            e.message?.includes('Receiving end does not exist')) {
            handleContextInvalidated();
        } else {
            console.error('[TimeTracker] Failed to send message:', e);
        }
        return null;
    }
}

// =====================
// Navigation Handling (Optimized)
// =====================

function setupNavigationObserver() {
    let lastUrl = window.location.href;

    // Method 1: Intercept history API (more efficient than MutationObserver)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        originalPushState.apply(this, args);
        handleUrlChange();
    };

    history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        handleUrlChange();
    };

    // Method 2: Listen for popstate (back/forward navigation)
    window.addEventListener('popstate', handleUrlChange);

    // Method 3: Fallback - periodic check (less frequent than MutationObserver)
    // This catches any edge cases the above methods might miss
    const checkInterval = setInterval(() => {
        if (window.location.href !== lastUrl) {
            handleUrlChange();
        }
    }, 2000);

    function handleUrlChange() {
        const newUrl = window.location.href;
        if (newUrl === lastUrl) return;

        lastUrl = newUrl;
        console.log('[TimeTracker] URL changed:', newUrl);

        // Debounce rapid URL changes
        clearTimeout(handleUrlChange.timeout);
        handleUrlChange.timeout = setTimeout(() => {
            handleNavigation();
        }, 100);
    }

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        clearInterval(checkInterval);
        cleanup();
    });
}

async function handleNavigation() {
    // Stop current tracking
    stopTracking();

    // Re-initialize for new page
    const domain = extractDomain(window.location.href);
    if (!domain) return;

    const category = await sendMessage({ type: 'GET_CATEGORY_FOR_DOMAIN', domain });

    if (!category) {
        console.log('[TimeTracker] No tracking category for this domain');
        // Unregister from current category if we're leaving a tracked site
        if (currentCategoryKey) {
            await sendMessage({ type: 'UNREGISTER_TAB', categoryKey: currentCategoryKey });
            currentCategory = null;
            currentCategoryKey = null;
            currentDomain = null;
        }
        return;
    }

    // Update current domain
    currentDomain = domain;

    // Check if category changed
    if (category.key !== currentCategoryKey) {
        // Unregister from old category
        if (currentCategoryKey) {
            await sendMessage({ type: 'UNREGISTER_TAB', categoryKey: currentCategoryKey });
        }
        currentCategory = category;
        currentCategoryKey = category.key;

        // Register for new category
        const registration = await sendMessage({ type: 'REGISTER_TAB', categoryKey: currentCategoryKey });
        isActiveTab = registration?.isActive ?? true;
    }

    // Check domain-specific limit first (takes priority)
    const domainCheck = await sendMessage({ type: 'CHECK_DOMAIN_LIMIT', domain: currentDomain });
    if (domainCheck && !domainCheck.allowed) {
        showBlockedOverlay({
            allowed: false,
            reason: 'domain_limit',
            reasonText: `Daily limit for ${currentDomain} reached`,
            domain: currentDomain,
            limit: domainCheck.limit,
            used: domainCheck.used
        });
        return;
    }

    // Check access
    const access = await sendMessage({ type: 'CAN_ACCESS', categoryKey: currentCategoryKey });

    if (!access.allowed) {
        showBlockedOverlay(access);
    } else if (!isBlocked) {
        await startTracking();
    }
}

// =====================
// Utilities
// =====================

function extractDomain(url) {
    try {
        const urlObj = new URL(url);
        if (!['http:', 'https:'].includes(urlObj.protocol)) return null;
        return urlObj.hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

function formatSeconds(seconds) {
    if (seconds < 0) seconds = 0;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

// =====================
// Detector Classes
// =====================

class VideoDetector {
    constructor(onTimeUpdate) {
        this.onTimeUpdate = onTimeUpdate;
        this.video = null;
        this.lastCurrentTime = 0;
        this.lastUpdateTimestamp = 0;
        this.observer = null;
        this.accumulatedTime = 0;
        this.lastReportTime = Date.now();
        this.boundHandlers = {};
        this.reportInterval = null;
    }

    start() {
        this.findVideo();
        this.setupObserver();
        // Note: attachVideoListeners is called within findVideo() when video is found
        // Periodic report even if timeupdate fires infrequently
        this.reportInterval = setInterval(() => this.reportAccumulatedTime(), 5000);
    }

    stop() {
        this.detachVideoListeners();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
            this.reportInterval = null;
        }
        this.reportAccumulatedTime();
    }

    findVideo() {
        // Try standard video first
        this.video = document.querySelector('video');

        // YouTube specific selectors
        if (!this.video) {
            const ytPlayer = document.querySelector('ytd-player, #movie_player, #player');
            if (ytPlayer) {
                this.video = ytPlayer.querySelector('video');
            }
        }

        // Netflix specific
        if (!this.video) {
            const netflixPlayer = document.querySelector('.watch-video video');
            if (netflixPlayer) {
                this.video = netflixPlayer;
            }
        }

        if (this.video) {
            this.lastCurrentTime = this.video.currentTime;
            this.lastUpdateTimestamp = Date.now();
            console.log('[TimeTracker] Video found, currentTime:', this.lastCurrentTime);
            this.attachVideoListeners();
        }
    }

    setupObserver() {
        // Only observe for video element changes, not all DOM mutations
        this.observer = new MutationObserver((mutations) => {
            // Check if we need to find a new video
            if (!this.video || !document.contains(this.video)) {
                this.detachVideoListeners();
                this.findVideo();
            }
        });

        // Use a more targeted observation - just watch for added/removed nodes
        this.observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });
    }

    attachVideoListeners() {
        if (!this.video) return;

        // Remove any existing listeners first
        this.detachVideoListeners();

        // Use timeupdate event - fires ~4 times per second during playback
        this.boundHandlers.timeupdate = (e) => this.handleTimeUpdate(e);
        this.boundHandlers.play = () => this.handlePlay();
        this.boundHandlers.pause = () => this.handlePause();

        this.video.addEventListener('timeupdate', this.boundHandlers.timeupdate);
        this.video.addEventListener('play', this.boundHandlers.play);
        this.video.addEventListener('pause', this.boundHandlers.pause);
    }

    detachVideoListeners() {
        if (!this.video) return;

        if (this.boundHandlers.timeupdate) {
            this.video.removeEventListener('timeupdate', this.boundHandlers.timeupdate);
        }
        if (this.boundHandlers.play) {
            this.video.removeEventListener('play', this.boundHandlers.play);
        }
        if (this.boundHandlers.pause) {
            this.video.removeEventListener('pause', this.boundHandlers.pause);
        }
    }

    handleTimeUpdate(e) {
        const video = e.target;
        if (!video || video.paused) return;

        const currentTime = video.currentTime;
        const now = Date.now();

        // Calculate time delta in video
        const videoTimeDelta = currentTime - this.lastCurrentTime;

        // Calculate real elapsed time since last update
        const realTimeDelta = (now - this.lastUpdateTimestamp) / 1000;

        // Video is playing if:
        // 1. currentTime advanced by at least 0.1s
        // 2. But not skipped ahead (seeking) - video delta should be close to real delta
        // 3. Video is not paused
        if (videoTimeDelta >= 0.1 && videoTimeDelta < realTimeDelta + 1) {
            // Add the actual video time that elapsed (more accurate than fixed increment)
            const timeToAdd = Math.min(videoTimeDelta, realTimeDelta + 0.5);
            this.accumulatedTime += timeToAdd;
        }

        this.lastCurrentTime = currentTime;
        this.lastUpdateTimestamp = now;

        // Report every 5 seconds
        if (now - this.lastReportTime >= 5000) {
            this.reportAccumulatedTime();
        }
    }

    handlePlay() {
        if (this.video) {
            this.lastCurrentTime = this.video.currentTime;
            this.lastUpdateTimestamp = Date.now();
        }
    }

    handlePause() {
        // Report any accumulated time when paused
        this.reportAccumulatedTime();
    }

    reportAccumulatedTime() {
        if (this.accumulatedTime > 0) {
            this.onTimeUpdate(this.accumulatedTime);
            this.accumulatedTime = 0;
            this.lastReportTime = Date.now();
        }
    }
}

class ReadingDetector {
    constructor(onTimeUpdate, idleTimeout = 30) {
        this.onTimeUpdate = onTimeUpdate;
        this.idleTimeout = idleTimeout * 1000;
        this.lastInteraction = Date.now();
        this.isVisible = !document.hidden;
        this.pollInterval = null;
        this.accumulatedTime = 0;
        this.lastReportTime = Date.now();
        this.boundHandlers = {};
    }

    start() {
        this.setupEventListeners();
        this.startPolling();
    }

    stop() {
        this.removeEventListeners();
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.reportAccumulatedTime();
    }

    setupEventListeners() {
        this.boundHandlers.interaction = () => { this.lastInteraction = Date.now(); };
        this.boundHandlers.visibility = () => { this.isVisible = !document.hidden; };

        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(e => {
            document.addEventListener(e, this.boundHandlers.interaction, { passive: true });
        });
        document.addEventListener('visibilitychange', this.boundHandlers.visibility);
    }

    removeEventListeners() {
        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(e => {
            document.removeEventListener(e, this.boundHandlers.interaction);
        });
        document.removeEventListener('visibilitychange', this.boundHandlers.visibility);
    }

    startPolling() {
        this.pollInterval = setInterval(() => this.checkActivity(), 1000);
    }

    checkActivity() {
        const now = Date.now();
        const isActive = this.isVisible && (now - this.lastInteraction) < this.idleTimeout;

        if (isActive) {
            this.accumulatedTime += 1;
            if (now - this.lastReportTime >= 5000) {
                this.reportAccumulatedTime();
            }
        }
    }

    reportAccumulatedTime() {
        if (this.accumulatedTime > 0) {
            this.onTimeUpdate(this.accumulatedTime);
            this.accumulatedTime = 0;
            this.lastReportTime = Date.now();
        }
    }
}

class SocialDetector extends ReadingDetector {
    // Same as ReadingDetector for now, but can be customized later
    constructor(onTimeUpdate, idleTimeout = 30) {
        super(onTimeUpdate, idleTimeout);
    }
}

function createDetector(type, onTimeUpdate, options = {}) {
    switch (type) {
        case 'video': return new VideoDetector(onTimeUpdate);
        case 'reading': return new ReadingDetector(onTimeUpdate, options.idleTimeout);
        case 'social': return new SocialDetector(onTimeUpdate, options.idleTimeout);
        default: return new ReadingDetector(onTimeUpdate, options.idleTimeout);
    }
}

// =====================
// Start
// =====================

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
} else {
    initialize();
}
