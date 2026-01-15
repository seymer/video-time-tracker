/**
 * Options Page JavaScript
 * Handles category configuration, usage display, and data management
 */

// =====================
// State
// =====================

let categories = {};
let editingCategory = null;

// =====================
// Initialization
// =====================

document.addEventListener('DOMContentLoaded', async () => {
    await loadData();
    setupEventListeners();
});

async function loadData() {
    try {
        const data = await chrome.storage.local.get(['categories', 'usage', 'activeState']);
        categories = data.categories || {};

        renderUsageSummary(data.usage || {}, data.activeState || {});
        renderCategories();
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// =====================
// Rendering
// =====================

function renderUsageSummary(usage, activeState) {
    const container = document.getElementById('usageSummary');
    const today = getTodayKey();
    const todayUsage = usage[today] || {};

    if (Object.keys(categories).length === 0) {
        container.innerHTML = '<p style="color: rgba(255,255,255,0.5)">No categories configured.</p>';
        return;
    }

    container.innerHTML = Object.entries(categories).map(([key, category]) => {
        const categoryUsage = todayUsage[key] || { totalTime: 0, sessions: [] };
        const state = activeState[key] || {};
        const percentage = category.dailyLimit
            ? Math.min(100, (categoryUsage.totalTime / category.dailyLimit) * 100)
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
                <div class="time-used">${formatTime(categoryUsage.totalTime)}</div>
                <div class="time-limit">of ${formatTime(category.dailyLimit)}</div>
                <div class="progress-bar">
                    <div class="progress-fill ${progressClass}" style="width: ${percentage}%"></div>
                </div>
                ${category.sessionCount ? `
                    <div class="sessions-info">
                        ${sessionsUsed}/${category.sessionCount} sessions
                        ${state.inRest ? ' (resting)' : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function renderCategories() {
    const container = document.getElementById('categoriesContainer');

    if (Object.keys(categories).length === 0) {
        container.innerHTML = '<p style="color: rgba(255,255,255,0.5); text-align: center; padding: 20px;">No categories configured. Click "Add Category" to get started.</p>';
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

// =====================
// Event Handlers
// =====================

function setupEventListeners() {
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

        document.getElementById('modalTitle').textContent = 'Edit Category';
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
        document.getElementById('modalTitle').textContent = 'Add Category';
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
                settings: {}
            });

            await loadData();
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
    if (!seconds || seconds <= 0) return '0m';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${secs}s`;
}
