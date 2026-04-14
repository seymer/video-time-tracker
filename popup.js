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
        // Get all category status from background - this triggers date change check
        // Note: getCategoryStatus already includes pending time via getCategoryUsage
        const allStatus = await chrome.runtime.sendMessage({ type: 'GET_ALL_STATUS' });

        renderCategoriesFromStatus(allStatus);
    } catch (error) {
        console.error('Error loading status:', error);
        document.getElementById('categoryList').innerHTML = `<p class="empty-state">${i18n('popupErrorLoading')}</p>`;
    }
}

function renderCategoriesFromStatus(allStatus) {
    const container = document.getElementById('categoryList');

    if (!allStatus || Object.keys(allStatus).length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>${i18n('popupNoCategories')}</p>
                <button class="btn" onclick="chrome.runtime.openOptionsPage()">${i18n('popupConfigureCategories')}</button>
            </div>
        `;
        return;
    }

    container.innerHTML = Object.entries(allStatus).map(([categoryKey, status]) => {
        const category = status.category;
        const usage = status.usage;
        const state = status.state;

        if (!category) return '';

        // usage.totalTime already includes pending time (via getCategoryUsage)
        const totalTime = usage.totalTime;

        const percentage = category.dailyLimit
            ? Math.min(100, (totalTime / category.dailyLimit) * 100)
            : 0;

        const sessionsUsed = usage.sessionsCompleted + (state.inSession ? 1 : 0);

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
                <div class="time-display">${formatTime(totalTime)}</div>
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

function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '0m';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

// Auto-refresh every 30 seconds
setInterval(loadStatus, 30000);
