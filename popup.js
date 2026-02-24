/**
 * Popup Script - Quick status overview
 */

function i18n(key, ...subs) {
    return chrome.i18n.getMessage(key, subs) || key;
}

/** Replace all __MSG_key__ in the document with chrome.i18n messages */
function applyI18nToDocument() {
    const msgRe = /__MSG_([A-Za-z0-9_]+)__/g;
    function replaceInText(text) {
        if (!text || typeof text !== 'string') return text;
        return text.replace(msgRe, (_, key) => chrome.i18n.getMessage(key) || key);
    }
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = replaceInText(node.textContent);
            if (t !== node.textContent) node.textContent = t;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SCRIPT') return;
        for (const attr of ['title', 'placeholder']) {
            const val = node.getAttribute(attr);
            if (val && val.includes('__MSG_')) node.setAttribute(attr, replaceInText(val));
        }
        for (const child of node.childNodes) walk(child);
    }
    walk(document.body);
    if (document.title && document.title.includes('__MSG_')) document.title = replaceInText(document.title);
}

document.addEventListener('DOMContentLoaded', async () => {
    applyI18nToDocument();
    await loadStatus();

    document.getElementById('openSettings').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });
});

async function loadStatus() {
    try {
        const data = await chrome.storage.local.get(['categories', 'usage', 'activeState']);
        const categories = data.categories || {};
        const usage = data.usage || {};
        const activeState = data.activeState || {};
        const today = getTodayKey();
        const todayUsage = usage[today] || {};

        // Get pending time updates from background to ensure accurate display
        let pendingTime = {};
        try {
            pendingTime = await chrome.runtime.sendMessage({ type: 'GET_PENDING_TIME' }) || {};
        } catch (e) {
            console.warn('Could not get pending time:', e);
        }

        renderCategories(categories, todayUsage, activeState, pendingTime);
    } catch (error) {
        console.error('Error loading status:', error);
        document.getElementById('categoryList').innerHTML = `<p class="empty-state">${i18n('popupErrorLoading')}</p>`;
    }
}

function renderCategories(categories, todayUsage, activeState, pendingTime = {}) {
    const container = document.getElementById('categoryList');

    if (Object.keys(categories).length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>${i18n('popupNoCategories')}</p>
                <button class="btn" onclick="chrome.runtime.openOptionsPage()">${i18n('popupConfigureCategories')}</button>
            </div>
        `;
        return;
    }

    container.innerHTML = Object.entries(categories).map(([key, category]) => {
        const categoryUsage = todayUsage[key] || { totalTime: 0, sessions: [] };
        const state = activeState[key] || {};

        // Include pending time for accurate display
        const pending = pendingTime[key] || 0;
        const totalTimeWithPending = categoryUsage.totalTime + pending;

        const percentage = category.dailyLimit
            ? Math.min(100, (totalTimeWithPending / category.dailyLimit) * 100)
            : 0;

        const completedSessions = categoryUsage.sessions?.filter(s => s.end).length || 0;
        const sessionsUsed = completedSessions + (state.inSession ? 1 : 0);

        let progressClass = '';
        if (percentage >= 100) progressClass = 'danger';
        else if (percentage >= 75) progressClass = 'warning';

        let statusClass = '';
        let statusText = i18n('popupStatusActive');

        if (state.inRest) {
            statusClass = 'resting';
            statusText = i18n('popupStatusResting');
        } else if (percentage >= 100) {
            statusClass = 'blocked';
            statusText = i18n('popupStatusLimitReached');
        }

        return `
            <div class="category-item">
                <div class="category-header">
                    <span class="category-name">${category.name}</span>
                    <span class="category-status ${statusClass}">${statusText}</span>
                </div>
                <div class="time-display">${formatTime(totalTimeWithPending)}</div>
                <div class="time-limit">${i18n('ofLimit', formatTime(category.dailyLimit))} daily limit</div>
                <div class="progress-bar">
                    <div class="progress-fill ${progressClass}" style="width: ${percentage}%"></div>
                </div>
                ${category.sessionCount ? `
                    <div class="sessions-info">
                        ${i18n('popupSessionsUsed', String(sessionsUsed), String(category.sessionCount))}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '0m';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Auto-refresh every 30 seconds
setInterval(loadStatus, 30000);
