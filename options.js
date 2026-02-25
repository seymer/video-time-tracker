/**
 * Options Page JavaScript
 * Handles category configuration, usage display, statistics, and data management
 */

// =====================
// i18n
// =====================

function i18n(key, ...subs) {
    return chrome.i18n.getMessage(key, subs) || key;
}

/** Replace all __MSG_key__ in the document with chrome.i18n messages (Chrome doesn't do this for extension HTML) */
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
        const attrs = ['title', 'placeholder'];
        for (const attr of attrs) {
            const val = node.getAttribute(attr);
            if (val && val.includes('__MSG_')) {
                node.setAttribute(attr, replaceInText(val));
            }
        }
        for (const child of node.childNodes) walk(child);
    }
    walk(document.body);
    if (document.title && document.title.includes('__MSG_')) {
        document.title = replaceInText(document.title);
    }
}

// =====================
// State
// =====================

let categories = {};
let editingCategory = null;
let currentPeriod = 'day';
let currentStats = null;
let domainLimits = {};

// =====================
// Initialization
// =====================

document.addEventListener('DOMContentLoaded', async () => {
    // Replace __MSG_xxx__ in HTML with locale strings (Chrome doesn't do this for extension pages)
    applyI18nToDocument();

    // Restore tab and period from URL hash FIRST (sync, before any await)
    const { tab, period } = parseHash();
    switchToTab(tab);
    switchToPeriod(period);
    currentPeriod = period;

    // Show content now that correct tab is set
    document.body.classList.add('ready');

    // i18n: footer version and placeholders
    const manifest = chrome.runtime.getManifest();
    const footerEl = document.getElementById('footerVersion');
    if (footerEl) footerEl.textContent = i18n('footerVersion', manifest.version);
    const domainsPlaceholder = document.getElementById('categoryDomains');
    if (domainsPlaceholder) domainsPlaceholder.placeholder = i18n('placeholderDomains');

    await loadData();
    setupEventListeners();
    await loadStats(currentPeriod);
});

// Handle browser back/forward navigation
window.addEventListener('hashchange', () => {
    const { tab, period } = parseHash();
    switchToTab(tab);
    if (period !== currentPeriod) {
        switchToPeriod(period);
        loadStats(period);
    }
});

/**
 * Parse URL hash into tab and period
 * Format: #stats, #settings, #stats/week, #stats/month
 */
function parseHash() {
    const hash = window.location.hash.slice(1);
    const [tab, period] = hash.split('/');
    return {
        tab: (tab === 'settings') ? 'settings' : 'stats',
        period: ['day', 'week', 'month'].includes(period) ? period : 'day'
    };
}

/**
 * Update URL hash
 */
function updateHash(tab, period) {
    const newHash = period === 'day' ? tab : `${tab}/${period}`;
    window.history.replaceState(null, '', `#${newHash}`);
}

/**
 * Switch to a specific tab
 */
function switchToTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    const tabBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    const tabContent = document.getElementById(`${tabId}-tab`);

    if (tabBtn && tabContent) {
        tabBtn.classList.add('active');
        tabContent.classList.add('active');
    }
}

/**
 * Switch to a specific period
 */
function switchToPeriod(period) {
    currentPeriod = period;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.period-btn[data-period="${period}"]`)?.classList.add('active');
}

async function loadData() {
    try {
        const data = await chrome.storage.local.get(['categories', 'usage', 'activeState', 'domainLimits']);
        categories = data.categories || {};
        domainLimits = data.domainLimits || {};

        // Get pending time updates from background to ensure accurate display
        let pendingTime = {};
        try {
            pendingTime = await chrome.runtime.sendMessage({ type: 'GET_PENDING_TIME' }) || {};
        } catch (e) {
            console.warn('Could not get pending time:', e);
        }

        renderUsageSummary(data.usage || {}, data.activeState || {}, pendingTime);
        renderCategories();
        renderDomainLimits();
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

async function loadStats(period) {
    currentPeriod = period;

    try {
        let stats;
        switch (period) {
            case 'day':
                stats = await chrome.runtime.sendMessage({ type: 'GET_TODAY_STATS' });
                break;
            case 'week':
                stats = await chrome.runtime.sendMessage({ type: 'GET_WEEK_STATS' });
                break;
            case 'month':
                stats = await chrome.runtime.sendMessage({ type: 'GET_MONTH_STATS' });
                break;
        }

        currentStats = stats;
        renderStats(stats, period);
    } catch (error) {
        console.error('Error loading stats:', error);
    }
}

// =====================
// Statistics Rendering
// =====================

function renderStats(stats, period) {
    if (!stats) return;

    // Summary cards
    document.getElementById('totalTime').textContent = formatTime(stats.totalTime);
    document.getElementById('sitesVisited').textContent = Object.keys(stats.byDomain || {}).length;

    // Calculate daily average
    const daysCount = Object.keys(stats.byDate || {}).length || 1;
    const avgDaily = stats.totalTime / daysCount;
    document.getElementById('avgDaily').textContent = formatTime(avgDaily);

    // Render chart
    renderChart(stats, period);

    // Render domain breakdown
    renderDomainBreakdown(stats);

    // Render category breakdown
    renderCategoryBreakdown(stats);
}

function renderChart(stats, period) {
    const chartContainer = document.getElementById('barChart');
    const labelsContainer = document.getElementById('chartLabels');

    const byDate = stats.byDate || {};
    const dates = Object.keys(byDate).sort();

    if (dates.length === 0) {
        chartContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📊</div>
                <p>${i18n('emptyNoData')}</p>
            </div>
        `;
        labelsContainer.innerHTML = '';
        return;
    }

    // Find max value for scaling
    const maxTime = Math.max(...dates.map(d => byDate[d].totalTime)) || 1;

    // Generate bars
    chartContainer.innerHTML = dates.map(date => {
        const dayData = byDate[date];
        const height = Math.max(5, (dayData.totalTime / maxTime) * 100);
        const formattedTime = formatTime(dayData.totalTime);

        return `
            <div class="bar-wrapper">
                <div class="bar" style="height: ${height}%">
                    <div class="bar-tooltip">${formattedTime}</div>
                </div>
            </div>
        `;
    }).join('');

    // Generate labels
    labelsContainer.innerHTML = dates.map(date => {
        const d = new Date(date);
        let label;

        if (period === 'day') {
            label = i18n('periodToday');
        } else if (period === 'week') {
            label = d.toLocaleDateString('en-US', { weekday: 'short' });
        } else {
            label = d.getDate();
        }

        return `<div class="chart-label">${label}</div>`;
    }).join('');
}

function renderDomainBreakdown(stats) {
    const container = document.getElementById('domainBreakdown');
    const byDomain = stats.byDomain || {};

    const sortedDomains = Object.entries(byDomain)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    if (sortedDomains.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🌐</div>
                <p>${i18n('emptyNoWebsites')}</p>
            </div>
        `;
        return;
    }

    const maxTime = sortedDomains[0][1] || 1;

    container.innerHTML = sortedDomains.map(([domain, time]) => {
        const percentage = (time / maxTime) * 100;
        const icon = domain.charAt(0).toUpperCase();

        return `
            <div class="domain-item">
                <div class="domain-info">
                    <div class="domain-icon">${icon}</div>
                    <span class="domain-name">${domain}</span>
                </div>
                <div class="domain-bar">
                    <div class="domain-bar-fill" style="width: ${percentage}%"></div>
                </div>
                <span class="domain-time">${formatTime(time)}</span>
            </div>
        `;
    }).join('');
}

function renderCategoryBreakdown(stats) {
    const container = document.getElementById('categoryBreakdown');
    const byCategory = stats.byCategory || {};

    const sortedCategories = Object.entries(byCategory)
        .sort((a, b) => b[1] - a[1]);

    if (sortedCategories.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📁</div>
                <p>${i18n('emptyNoCategories')}</p>
            </div>
        `;
        return;
    }

    const maxTime = sortedCategories[0][1] || 1;

    container.innerHTML = sortedCategories.map(([key, time]) => {
        const category = categories[key] || { name: key };
        const percentage = (time / maxTime) * 100;
        const limitText = category.dailyLimit ? ` ${i18n('statsCategoryLimit', formatTime(category.dailyLimit))}` : '';

        return `
            <div class="domain-item">
                <div class="domain-info">
                    <div class="domain-icon">📁</div>
                    <span class="domain-name">${category.name}</span>
                </div>
                <div class="domain-bar">
                    <div class="domain-bar-fill" style="width: ${percentage}%"></div>
                </div>
                <span class="domain-time">${formatTime(time)}${limitText}</span>
            </div>
        `;
    }).join('');
}

// =====================
// Settings Rendering
// =====================

function renderUsageSummary(usage, activeState, pendingTime = {}) {
    const container = document.getElementById('usageSummary');
    const today = getTodayKey();
    const todayUsage = usage[today] || {};

    if (Object.keys(categories).length === 0) {
        container.innerHTML = `<p style="color: rgba(255,255,255,0.5)">${i18n('emptyNoCategoriesConfigured')}</p>`;
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
        const inSession = state.inSession;
        const sessionsUsed = completedSessions + (inSession ? 1 : 0);

        let progressClass = '';
        if (percentage >= 100) progressClass = 'danger';
        else if (percentage >= 75) progressClass = 'warning';

        return `
            <div class="usage-item">
                <div class="category-name">${category.name}</div>
                <div class="time-used">${formatTime(totalTimeWithPending)}</div>
                <div class="time-limit">${i18n('ofLimit', formatTime(category.dailyLimit))}</div>
                <div class="progress-bar">
                    <div class="progress-fill ${progressClass}" style="width: ${percentage}%"></div>
                </div>
                ${category.sessionCount ? `
                    <div class="sessions-info">
                        ${i18n('sessionsUsed', String(sessionsUsed), String(category.sessionCount))}
                        ${state.inRest ? ` ${i18n('resting')}` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function renderCategories() {
    const container = document.getElementById('categoriesContainer');

    if (Object.keys(categories).length === 0) {
        container.innerHTML = `<p style="color: rgba(255,255,255,0.5); text-align: center; padding: 20px;">${i18n('emptyNoCategoriesHint')}</p>`;
        return;
    }

    container.innerHTML = Object.entries(categories).map(([key, category]) => `
        <div class="category-card" data-key="${key}">
            <div class="info">
                <div class="name">${category.name}</div>
                <div class="details">
                    ${category.domains.slice(0, 3).join(', ')}${category.domains.length > 3 ? ` +${category.domains.length - 3} more` : ''}
                </div>
            </div>
            <div class="status">
                <span class="type-badge">${category.type}</span>
                <button class="edit-btn" title="Edit">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
            </div>
        </div>
    `).join('');
}

function renderDomainLimits() {
    const container = document.getElementById('domainLimitsContainer');

    if (Object.keys(domainLimits).length === 0) {
        container.innerHTML = '<p style="color: rgba(255,255,255,0.4); font-size: 13px;">No website-specific limits set.</p>';
        return;
    }

    container.innerHTML = Object.entries(domainLimits).map(([domain, config]) => `
        <div class="domain-limit-item" data-domain="${domain}">
            <div class="limit-info">
                <span class="limit-domain">${domain}</span>
                <span class="limit-value">${formatTime(config.dailyLimit)}/day</span>
            </div>
            <button class="remove-limit" title="Remove limit">×</button>
        </div>
    `).join('');
}

// =====================
// Event Handlers
// =====================

function setupEventListeners() {
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;
            switchToTab(tabId);
            updateHash(tabId, currentPeriod);
        });
    });

    // Period switching
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const period = btn.dataset.period;
            switchToPeriod(period);
            updateHash('stats', period);
            loadStats(period);
        });
    });

    // Category cards
    document.getElementById('categoriesContainer').addEventListener('click', (e) => {
        const card = e.target.closest('.category-card');
        if (card) {
            openModal(card.dataset.key);
        }
    });

    // Add category button
    document.getElementById('addCategoryBtn').addEventListener('click', () => {
        openModal(null);
    });

    // Modal controls
    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('cancelModal').addEventListener('click', closeModal);
    document.querySelector('.modal-backdrop').addEventListener('click', closeModal);

    // Form submission
    document.getElementById('categoryForm').addEventListener('submit', saveCategory);

    // Delete button
    document.getElementById('deleteCategory').addEventListener('click', deleteCategory);

    // Add period button
    document.getElementById('addPeriodBtn').addEventListener('click', () => {
        addPeriodRow('22:00', '08:00');
    });

    // Data management buttons
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('resetTodayBtn').addEventListener('click', resetToday);
    document.getElementById('clearAllBtn').addEventListener('click', clearAllData);

    // Domain limits
    document.getElementById('addDomainLimitBtn').addEventListener('click', addDomainLimit);
    document.getElementById('domainLimitsContainer').addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-limit')) {
            const item = e.target.closest('.domain-limit-item');
            if (item) {
                removeDomainLimit(item.dataset.domain);
            }
        }
    });
}

// =====================
// Domain Limits Management
// =====================

async function addDomainLimit() {
    const domainInput = document.getElementById('newDomainInput');
    const limitInput = document.getElementById('newDomainLimit');

    const domain = domainInput.value.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '');
    const hours = parseFloat(limitInput.value);

    if (!domain) {
        alert('Please enter a domain');
        return;
    }

    if (!hours || hours <= 0) {
        alert('Please enter a valid limit in hours');
        return;
    }

    const dailyLimit = hours * 3600; // Convert to seconds

    try {
        await chrome.runtime.sendMessage({
            type: 'SET_DOMAIN_LIMIT',
            domain,
            dailyLimit
        });

        domainLimits[domain] = { dailyLimit };
        renderDomainLimits();

        domainInput.value = '';
        limitInput.value = '1';
    } catch (error) {
        console.error('Error setting domain limit:', error);
        alert('Failed to set domain limit');
    }
}

async function removeDomainLimit(domain) {
    if (!confirm(`Remove time limit for ${domain}?`)) return;

    try {
        await chrome.runtime.sendMessage({
            type: 'SET_DOMAIN_LIMIT',
            domain,
            dailyLimit: null
        });

        delete domainLimits[domain];
        renderDomainLimits();
    } catch (error) {
        console.error('Error removing domain limit:', error);
        alert('Failed to remove domain limit');
    }
}

// =====================
// Modal Management
// =====================

function openModal(categoryKey) {
    editingCategory = categoryKey;
    const modal = document.getElementById('categoryModal');
    const form = document.getElementById('categoryForm');
    const deleteBtn = document.getElementById('deleteCategory');
    const periodsContainer = document.getElementById('forbiddenPeriods');

    form.reset();
    periodsContainer.innerHTML = '';

    if (categoryKey && categories[categoryKey]) {
        const category = categories[categoryKey];

        document.getElementById('modalTitle').textContent = i18n('editCategory');
        deleteBtn.classList.remove('hidden');

        document.getElementById('categoryName').value = category.name;
        document.getElementById('categoryType').value = category.type;
        document.getElementById('categoryDomains').value = category.domains.join('\n');
        document.getElementById('dailyLimit').value = category.dailyLimit / 3600;
        document.getElementById('sessionDuration').value = category.sessionDuration / 60;
        document.getElementById('sessionCount').value = category.sessionCount || '';
        document.getElementById('restDuration').value = (category.restDuration || 0) / 60;
        document.getElementById('idleTimeout').value = category.idleTimeout || 30;
        document.getElementById('categoryEnabled').checked = category.enabled !== false;

        if (category.forbiddenPeriods) {
            category.forbiddenPeriods.forEach(period => {
                addPeriodRow(period.start, period.end);
            });
        }
    } else {
        document.getElementById('modalTitle').textContent = i18n('addNewCategory');
        deleteBtn.classList.add('hidden');

        // Set defaults
        document.getElementById('dailyLimit').value = 2;
        document.getElementById('sessionDuration').value = 30;
        document.getElementById('sessionCount').value = 4;
        document.getElementById('restDuration').value = 10;
        document.getElementById('idleTimeout').value = 30;
    }

    modal.classList.remove('hidden');
}

function closeModal() {
    document.getElementById('categoryModal').classList.add('hidden');
    editingCategory = null;
}

function addPeriodRow(start = '22:00', end = '08:00') {
    const container = document.getElementById('forbiddenPeriods');
    const row = document.createElement('div');
    row.className = 'period-item';
    row.innerHTML = `
        <input type="time" class="period-start" value="${start}">
        <span>to</span>
        <input type="time" class="period-end" value="${end}">
        <button type="button" class="remove-period" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(row);
}

// =====================
// CRUD Operations
// =====================

async function saveCategory(e) {
    e.preventDefault();

    const name = document.getElementById('categoryName').value.trim();
    const type = document.getElementById('categoryType').value;
    const domainsText = document.getElementById('categoryDomains').value;
    const domains = domainsText.split('\n')
        .map(d => d.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, ''))
        .filter(d => d.length > 0);

    if (!name || domains.length === 0) {
        alert('Please enter a name and at least one domain');
        return;
    }

    const key = editingCategory || name.toLowerCase().replace(/\s+/g, '_');

    // Get forbidden periods
    const forbiddenPeriods = [];
    document.querySelectorAll('.period-item').forEach(row => {
        const start = row.querySelector('.period-start').value;
        const end = row.querySelector('.period-end').value;
        if (start && end) {
            forbiddenPeriods.push({ start, end });
        }
    });

    categories[key] = {
        name,
        type,
        domains,
        dailyLimit: parseFloat(document.getElementById('dailyLimit').value) * 3600,
        sessionDuration: parseInt(document.getElementById('sessionDuration').value) * 60,
        sessionCount: parseInt(document.getElementById('sessionCount').value) || null,
        restDuration: parseInt(document.getElementById('restDuration').value) * 60,
        idleTimeout: parseInt(document.getElementById('idleTimeout').value) || 30,
        forbiddenPeriods,
        enabled: document.getElementById('categoryEnabled').checked
    };

    await chrome.storage.local.set({ categories });

    closeModal();
    renderCategories();
    await loadData(); // Refresh usage display
}

async function deleteCategory() {
    if (!editingCategory) return;

    if (confirm(`Are you sure you want to delete "${categories[editingCategory].name}"?`)) {
        delete categories[editingCategory];
        await chrome.storage.local.set({ categories });

        closeModal();
        renderCategories();
        await loadData();
    }
}

// =====================
// Data Management
// =====================

async function exportData() {
    try {
        const data = await chrome.storage.local.get(null);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `time-tracker-backup-${getTodayKey()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (error) {
        alert('Failed to export data');
        console.error(error);
    }
}

async function resetToday() {
    if (confirm('Reset all of today\'s usage data? This cannot be undone.')) {
        const data = await chrome.storage.local.get(['usage', 'activeState']);
        const usage = data.usage || {};
        const today = getTodayKey();

        delete usage[today];

        await chrome.storage.local.set({
            usage,
            activeState: {}
        });

        await loadData();
        await loadStats(currentPeriod);
        alert('Today\'s usage has been reset');
    }
}

async function clearAllData() {
    if (confirm('Delete ALL data including categories and history? This cannot be undone.')) {
        if (confirm('Are you REALLY sure?')) {
            await chrome.storage.local.clear();

            // Reinitialize with defaults
            await chrome.storage.local.set({
                categories: {},
                usage: {},
                activeState: {},
                settings: {},
                domainLimits: {}
            });

            await loadData();
            await loadStats(currentPeriod);
            alert('All data has been cleared');
        }
    }
}

// =====================
// Utilities
// =====================

function getTodayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function formatTime(seconds) {
    if (seconds == null || seconds < 0) return '0m 0s';
    seconds = Math.floor(seconds);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}
