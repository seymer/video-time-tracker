/**
 * Category Detectors - Detect effective time for different site types
 * Each detector is responsible for accurately tracking "real" usage time
 */

/**
 * Video Detector - Tracks actual video playback time
 * Uses currentTime progression to detect real playback
 */
export class VideoDetector {
    constructor(onTimeUpdate) {
        this.onTimeUpdate = onTimeUpdate;
        this.video = null;
        this.lastCurrentTime = 0;
        this.pollInterval = null;
        this.observer = null;
        this.accumulatedTime = 0;
        this.lastReportTime = Date.now();
    }

    start() {
        this.findVideo();
        this.setupObserver();
        this.startPolling();
    }

    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.reportAccumulatedTime();
    }

    findVideo() {
        // Try to find video element, including in Shadow DOM
        this.video = document.querySelector('video');

        if (!this.video) {
            // YouTube uses Shadow DOM sometimes
            const ytPlayer = document.querySelector('ytd-player, #movie_player');
            if (ytPlayer) {
                this.video = ytPlayer.querySelector('video');
            }
        }

        if (this.video) {
            this.lastCurrentTime = this.video.currentTime;
        }
    }

    setupObserver() {
        // Watch for dynamically added videos
        this.observer = new MutationObserver(() => {
            if (!this.video || !document.contains(this.video)) {
                this.findVideo();
            }
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    startPolling() {
        // Poll every 500ms for accurate tracking
        this.pollInterval = setInterval(() => {
            this.checkPlayback();
        }, 500);
    }

    checkPlayback() {
        if (!this.video) {
            this.findVideo();
            return;
        }

        // Check if video is actually playing (currentTime advancing)
        const currentTime = this.video.currentTime;
        const timeDelta = currentTime - this.lastCurrentTime;

        // Video is playing if:
        // 1. currentTime has advanced by at least 0.3s (tolerance for buffering)
        // 2. But not more than 2s (to filter out seeks)
        // 3. Video is not paused
        if (timeDelta >= 0.3 && timeDelta < 2 && !this.video.paused) {
            // Add effective time (0.5s since we poll every 500ms)
            this.accumulatedTime += 0.5;

            // Report every 5 seconds to reduce message overhead
            if (Date.now() - this.lastReportTime >= 5000) {
                this.reportAccumulatedTime();
            }
        }

        this.lastCurrentTime = currentTime;
    }

    reportAccumulatedTime() {
        if (this.accumulatedTime > 0) {
            this.onTimeUpdate(this.accumulatedTime);
            this.accumulatedTime = 0;
            this.lastReportTime = Date.now();
        }
    }

    pause() {
        if (this.video) {
            this.video.pause();
        }
    }
}

/**
 * Reading Detector - Tracks time on text-heavy pages
 * Uses visibility + interaction to detect active reading
 */
export class ReadingDetector {
    constructor(onTimeUpdate, idleTimeout = 30) {
        this.onTimeUpdate = onTimeUpdate;
        this.idleTimeout = idleTimeout * 1000; // Convert to ms
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
        // Track user interactions
        this.boundHandlers.interaction = () => {
            this.lastInteraction = Date.now();
        };

        this.boundHandlers.visibility = () => {
            this.isVisible = !document.hidden;
        };

        // Mouse, keyboard, scroll, touch events indicate active reading
        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
            document.addEventListener(event, this.boundHandlers.interaction, { passive: true });
        });

        document.addEventListener('visibilitychange', this.boundHandlers.visibility);
    }

    removeEventListeners() {
        ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
            document.removeEventListener(event, this.boundHandlers.interaction);
        });
        document.removeEventListener('visibilitychange', this.boundHandlers.visibility);
    }

    startPolling() {
        // Check every 1 second
        this.pollInterval = setInterval(() => {
            this.checkActivity();
        }, 1000);
    }

    checkActivity() {
        const now = Date.now();
        const timeSinceInteraction = now - this.lastInteraction;

        // Active if: visible AND had interaction within idle timeout
        const isActive = this.isVisible && timeSinceInteraction < this.idleTimeout;

        if (isActive) {
            this.accumulatedTime += 1; // 1 second

            // Report every 5 seconds
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

/**
 * Social Feed Detector - Tracks time on social media
 * Uses visibility + scroll activity to detect active browsing
 */
export class SocialDetector {
    constructor(onTimeUpdate, idleTimeout = 30) {
        this.onTimeUpdate = onTimeUpdate;
        this.idleTimeout = idleTimeout * 1000;
        this.lastScroll = Date.now();
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
        this.boundHandlers.scroll = () => {
            this.lastScroll = Date.now();
            this.lastInteraction = Date.now();
        };

        this.boundHandlers.interaction = () => {
            this.lastInteraction = Date.now();
        };

        this.boundHandlers.visibility = () => {
            this.isVisible = !document.hidden;
        };

        window.addEventListener('scroll', this.boundHandlers.scroll, { passive: true });
        ['mousemove', 'click', 'keydown', 'touchstart'].forEach(event => {
            document.addEventListener(event, this.boundHandlers.interaction, { passive: true });
        });
        document.addEventListener('visibilitychange', this.boundHandlers.visibility);
    }

    removeEventListeners() {
        window.removeEventListener('scroll', this.boundHandlers.scroll);
        ['mousemove', 'click', 'keydown', 'touchstart'].forEach(event => {
            document.removeEventListener(event, this.boundHandlers.interaction);
        });
        document.removeEventListener('visibilitychange', this.boundHandlers.visibility);
    }

    startPolling() {
        this.pollInterval = setInterval(() => {
            this.checkActivity();
        }, 1000);
    }

    checkActivity() {
        const now = Date.now();
        const timeSinceInteraction = now - this.lastInteraction;

        // Active if visible and had interaction within timeout
        const isActive = this.isVisible && timeSinceInteraction < this.idleTimeout;

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

/**
 * Audio Detector - Tracks actual audio playback time
 */
export class AudioDetector {
    constructor(onTimeUpdate) {
        this.onTimeUpdate = onTimeUpdate;
        this.audios = [];
        this.lastCurrentTimes = new Map();
        this.pollInterval = null;
        this.accumulatedTime = 0;
        this.lastReportTime = Date.now();
        this.observer = null;
    }

    start() {
        this.findAudios();
        this.setupObserver();
        this.startPolling();
    }

    stop() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.reportAccumulatedTime();
    }

    findAudios() {
        this.audios = Array.from(document.querySelectorAll('audio'));
        this.audios.forEach(audio => {
            if (!this.lastCurrentTimes.has(audio)) {
                this.lastCurrentTimes.set(audio, audio.currentTime);
            }
        });
    }

    setupObserver() {
        this.observer = new MutationObserver(() => {
            this.findAudios();
        });

        this.observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    startPolling() {
        this.pollInterval = setInterval(() => {
            this.checkPlayback();
        }, 500);
    }

    checkPlayback() {
        this.findAudios();

        let anyPlaying = false;

        for (const audio of this.audios) {
            const lastTime = this.lastCurrentTimes.get(audio) || 0;
            const currentTime = audio.currentTime;
            const timeDelta = currentTime - lastTime;

            if (timeDelta >= 0.3 && timeDelta < 2 && !audio.paused) {
                anyPlaying = true;
            }

            this.lastCurrentTimes.set(audio, currentTime);
        }

        if (anyPlaying) {
            this.accumulatedTime += 0.5;

            if (Date.now() - this.lastReportTime >= 5000) {
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

    pause() {
        this.audios.forEach(audio => audio.pause());
    }
}

/**
 * Factory function to create the right detector for a category type
 */
export function createDetector(categoryType, onTimeUpdate, options = {}) {
    switch (categoryType) {
        case 'video':
            return new VideoDetector(onTimeUpdate);
        case 'reading':
            return new ReadingDetector(onTimeUpdate, options.idleTimeout || 30);
        case 'social':
            return new SocialDetector(onTimeUpdate, options.idleTimeout || 30);
        case 'audio':
            return new AudioDetector(onTimeUpdate);
        default:
            // Default to reading-style detection
            return new ReadingDetector(onTimeUpdate, options.idleTimeout || 30);
    }
}
