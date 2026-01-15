/**
 * Content Script - Main tracking and overlay logic
 * Detects category, tracks effective time, and displays blocking overlays
 */

// =====================
// State
// =====================

let currentCategory = null;
let currentCategoryKey = null;
let detector = null;
let isBlocked = false;
let overlayElement = null;

// =====================
// Initialization
// =====================

async function initialize() {
    const domain = extractDomain(window.location.href);
    if (!domain) return;

    // Get category for this domain
    const category = await sendMessage({ type: 'GET_CATEGORY_FOR_DOMAIN', domain });

    if (!category) {
        console.log('No tracking category for this domain:', domain);
        return;
    }

    currentCategory = category;
    currentCategoryKey = category.key;

    // Check if we can access this category
    const access = await sendMessage({ type: 'CAN_ACCESS', categoryKey: currentCategoryKey });

    if (!access) {
        console.log('Failed to check access for category:', currentCategoryKey);
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

    // Handle SPA navigation
    setupNavigationObserver();
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

    const result = await sendMessage({
        type: 'ADD_TIME',
        categoryKey: currentCategoryKey,
        seconds
    });

    // Check for null result (message failed) or blocked
    if (result && !result.allowed) {
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
    }

    overlayElement.innerHTML = `
        <div class="overlay-content">
            <div class="overlay-icon">${getIconForReason(access.reason)}</div>
            <h1 class="overlay-title">${title}</h1>
            <p class="overlay-message">${message}</p>
            ${countdown ? `<p class="overlay-countdown">${countdown}</p>` : ''}
            <div class="overlay-stats">
                ${access.totalTime ? `<span>Today: ${formatSeconds(access.totalTime)}</span>` : ''}
                ${access.dailyLimit ? `<span>Limit: ${formatSeconds(access.dailyLimit)}</span>` : ''}
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
    isBlocked = false;
}

function getIconForReason(reason) {
    const icons = {
        'forbidden_period': '🚫',
        'rest_period': '☕',
        'session_limit_reached': '⏰',
        'daily_limit': '📅',
        'sessions_exhausted': '🎯'
    };
    return icons[reason] || '⏳';
}

function startCountdownTimer(seconds) {
    const countdownEl = overlayElement?.querySelector('.countdown');
    if (!countdownEl) return;

    let remaining = seconds;

    const interval = setInterval(() => {
        remaining--;

        if (remaining <= 0) {
            clearInterval(interval);
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
    }
}

async function sendMessage(message) {
    try {
        return await chrome.runtime.sendMessage(message);
    } catch (e) {
        console.error('Failed to send message:', e);
        return null;
    }
}

// =====================
// Navigation Handling
// =====================

function setupNavigationObserver() {
    // Handle YouTube-style SPA navigation
    let lastUrl = window.location.href;

    const observer = new MutationObserver(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            handleNavigation();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Also listen for popstate
    window.addEventListener('popstate', handleNavigation);
}

async function handleNavigation() {
    // Stop current tracking
    stopTracking();

    // Re-initialize for new page
    const domain = extractDomain(window.location.href);
    if (!domain) return;

    const category = await sendMessage({ type: 'GET_CATEGORY_FOR_DOMAIN', domain });

    if (!category) {
        console.log('No tracking category for this domain');
        return;
    }

    // Check if category changed
    if (category.key !== currentCategoryKey) {
        currentCategory = category;
        currentCategoryKey = category.key;
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
// Detector Classes (Inline for content script)
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
        this.attachVideoListeners();
        // Periodic report even if timeupdate fires infrequently
        this.reportInterval = setInterval(() => this.reportAccumulatedTime(), 5000);
    }

    stop() {
        this.detachVideoListeners();
        if (this.observer) this.observer.disconnect();
        if (this.reportInterval) clearInterval(this.reportInterval);
        this.reportAccumulatedTime();
    }

    findVideo() {
        // Try standard video first
        this.video = document.querySelector('video');
        console.log('[TimeTracker] Looking for video, found:', !!this.video);

        // YouTube specific selectors
        if (!this.video) {
            const ytPlayer = document.querySelector('ytd-player, #movie_player, #player');
            if (ytPlayer) {
                this.video = ytPlayer.querySelector('video');
                console.log('[TimeTracker] Found YouTube video:', !!this.video);
            }
        }

        // Netflix specific
        if (!this.video) {
            const netflixPlayer = document.querySelector('.watch-video video');
            if (netflixPlayer) {
                this.video = netflixPlayer;
                console.log('[TimeTracker] Found Netflix video');
            }
        }

        if (this.video) {
            this.lastCurrentTime = this.video.currentTime;
            this.lastUpdateTimestamp = Date.now();
            console.log('[TimeTracker] Video found, currentTime:', this.lastCurrentTime);
            this.attachVideoListeners();
        } else {
            console.log('[TimeTracker] No video element found on page');
        }
    }

    setupObserver() {
        this.observer = new MutationObserver(() => {
            if (!this.video || !document.contains(this.video)) {
                this.detachVideoListeners();
                this.findVideo();
            }
        });
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    attachVideoListeners() {
        if (!this.video) return;
        console.log('[TimeTracker] Attaching video event listeners');

        // Use timeupdate event - fires ~4 times per second during playback
        // Crucially, this works even when tab is in background!
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
            // Log every ~5 seconds of accumulated time
            if (this.accumulatedTime >= 5 && this.accumulatedTime < 5.5) {
                console.log('[TimeTracker] Accumulated 5+ seconds of video time');
            }
        }

        this.lastCurrentTime = currentTime;
        this.lastUpdateTimestamp = now;

        // Report every 5 seconds
        if (now - this.lastReportTime >= 5000) {
            this.reportAccumulatedTime();
        }
    }

    handlePlay() {
        console.log('[TimeTracker] Video play event');
        if (this.video) {
            this.lastCurrentTime = this.video.currentTime;
            this.lastUpdateTimestamp = Date.now();
        }
    }

    handlePause() {
        console.log('[TimeTracker] Video pause event');
        // Report any accumulated time when paused
        this.reportAccumulatedTime();
    }

    reportAccumulatedTime() {
        if (this.accumulatedTime > 0) {
            console.log('[TimeTracker] Reporting accumulated time:', this.accumulatedTime.toFixed(1), 'seconds');
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
    }

    start() {
        this.setupEventListeners();
        this.startPolling();
    }

    stop() {
        this.removeEventListeners();
        if (this.pollInterval) clearInterval(this.pollInterval);
        this.reportAccumulatedTime();
    }

    setupEventListeners() {
        this.handleInteraction = () => { this.lastInteraction = Date.now(); };
        this.handleVisibility = () => { this.isVisible = !document.hidden; };

        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(e => {
            document.addEventListener(e, this.handleInteraction, { passive: true });
        });
        document.addEventListener('visibilitychange', this.handleVisibility);
    }

    removeEventListeners() {
        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(e => {
            document.removeEventListener(e, this.handleInteraction);
        });
        document.removeEventListener('visibilitychange', this.handleVisibility);
    }

    startPolling() {
        this.pollInterval = setInterval(() => this.checkActivity(), 1000);
    }

    checkActivity() {
        const now = Date.now();
        const isActive = this.isVisible && (now - this.lastInteraction) < this.idleTimeout;

        if (isActive) {
            this.accumulatedTime += 1;
            if (now - this.lastReportTime >= 5000) this.reportAccumulatedTime();
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
    // Same as ReadingDetector for now
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
