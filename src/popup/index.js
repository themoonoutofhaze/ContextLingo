// Popup script for ContextLingo v2.1
    const bodyEl = document.body;
    const toggleBtn = document.getElementById('toggleBtn');
    const toggleTitle = document.getElementById('toggleTitle');
    const toggleSubtitle = document.getElementById('toggleSubtitle');
    const excludeSiteBtn = document.getElementById('excludeSiteBtn');
    const excludeTitle = document.getElementById('excludeTitle');
    const excludeSubtitle = document.getElementById('excludeSubtitle');
    const darkModeBtn = document.getElementById('darkModeBtn');
    const darkModeTitle = document.getElementById('darkModeTitle');
    const darkModeSubtitle = document.getElementById('darkModeSubtitle');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    let currentHostname = '';
    let extensionGloballyEnabled = true;
    let darkModeEnabled = false;

    function normalizeHostname(rawUrl) {
        try {
            const host = new URL(rawUrl).hostname.toLowerCase();
            return host.startsWith('www.') ? host.slice(4) : host;
        } catch {
            return '';
        }
    }

    // Open settings page
    openSettingsBtn.addEventListener('click', function () {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/options/index.html') });
    });

    function updateGlobalToggleUI(enabled) {
        toggleBtn.classList.toggle('active', enabled);
        toggleBtn.setAttribute('aria-pressed', String(enabled));
        toggleTitle.textContent = enabled ? 'Extension Enabled' : 'Extension Disabled';
    }

    function updateDarkModeUI(enabled) {
        darkModeEnabled = enabled;
        bodyEl.classList.toggle('popup-dark', enabled);
        darkModeBtn.classList.toggle('active', enabled);
        darkModeBtn.setAttribute('aria-pressed', String(enabled));
        darkModeTitle.textContent = enabled ? 'Dark Mode On' : 'Dark Mode Off';
        darkModeSubtitle.textContent = enabled ? 'Use dark visual theme' : 'Use light visual theme';
    }

    function setExcludeButtonState(disabled, title, subtitle) {
        excludeSiteBtn.disabled = disabled;
        excludeTitle.textContent = title;
        excludeSubtitle.textContent = subtitle;
    }

    function broadcastGlobalEnabled(enabled) {
        chrome.tabs.query({}, function (tabs) {
            tabs.forEach((tab) => {
                if (!tab.id) return;
                chrome.tabs.sendMessage(tab.id, { action: 'setEnabled', enabled }, () => {
                    // Ignore errors for tabs where content script is not available.
                    void chrome.runtime.lastError;
                });
            });
        });
    }

    function broadcastDarkMode(enabled) {
        chrome.tabs.query({}, function (tabs) {
            tabs.forEach((tab) => {
                if (!tab.id) return;
                chrome.tabs.sendMessage(tab.id, { action: 'updateDarkMode', enabled }, () => {
                    void chrome.runtime.lastError;
                });
            });
        });
    }

    function updateControlSubtitle(isExcluded, isInternalPage) {
        if (!extensionGloballyEnabled) {
            toggleSubtitle.textContent = 'Off on all websites';
            return;
        }

        if (isInternalPage) {
            toggleSubtitle.textContent = 'On globally (this page is restricted)';
            return;
        }

        if (isExcluded && currentHostname) {
            toggleSubtitle.textContent = `Excluded on ${currentHostname}`;
            return;
        }

        toggleSubtitle.textContent = 'On for all allowed websites';
    }

    // Add current website to exclusion list
    excludeSiteBtn.addEventListener('click', function () {
        if (!currentHostname || excludeSiteBtn.disabled) return;

        chrome.storage.sync.get(['disabledSites'], function (result) {
            const existing = (result.disabledSites || '')
                .split(',')
                .map(site => site.trim().toLowerCase())
                .filter(Boolean);

            if (!existing.includes(currentHostname)) {
                existing.push(currentHostname);
            }

            const disabledSitesValue = existing.join(', ');
            chrome.storage.sync.set({ disabledSites: disabledSitesValue }, function () {
                setExcludeButtonState(true, 'Website Excluded', 'Saved to settings exclude list');
                updateControlSubtitle(true, false);
            });
        });
    });

    // Global enable/disable toggle
    toggleBtn.addEventListener('click', function () {
        if (toggleBtn.disabled) return;

        extensionGloballyEnabled = !extensionGloballyEnabled;
        chrome.storage.sync.set({ enabled: extensionGloballyEnabled, autoEnable: extensionGloballyEnabled }, function () {
            updateGlobalToggleUI(extensionGloballyEnabled);
            chrome.storage.sync.get(['disabledSites'], function (result) {
                const isExcluded = (result.disabledSites || '')
                    .split(',')
                    .map(site => site.trim().toLowerCase())
                    .filter(Boolean)
                    .includes(currentHostname);
                updateControlSubtitle(isExcluded, false);
            });
            broadcastGlobalEnabled(extensionGloballyEnabled);
        });
    });

    // Dark mode toggle
    darkModeBtn.addEventListener('click', function () {
        darkModeEnabled = !darkModeEnabled;
        chrome.storage.sync.set({ darkMode: darkModeEnabled }, function () {
            updateDarkModeUI(darkModeEnabled);
            broadcastDarkMode(darkModeEnabled);
        });
    });

    // Check tab availability and get current status
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        const url = tabs[0]?.url || '';
        currentHostname = normalizeHostname(url);
        const isBrowserInternalPage = /^(chrome|edge|about|brave|opera|chrome-extension):/i.test(url);

        if (isBrowserInternalPage) {
            setExcludeButtonState(true, 'Cannot Exclude', 'Browser internal page');
            chrome.storage.sync.get(['enabled', 'darkMode'], function (result) {
                extensionGloballyEnabled = typeof result.enabled === 'boolean' ? result.enabled : true;
                updateDarkModeUI(Boolean(result.darkMode));
                updateGlobalToggleUI(extensionGloballyEnabled);
                updateControlSubtitle(false, true);
            });
            return;
        }

        chrome.storage.sync.get(['disabledSites', 'enabled', 'darkMode'], function (result) {
            extensionGloballyEnabled = typeof result.enabled === 'boolean' ? result.enabled : true;
            updateDarkModeUI(Boolean(result.darkMode));
            updateGlobalToggleUI(extensionGloballyEnabled);

            const existing = (result.disabledSites || '')
                .split(',')
                .map(site => site.trim().toLowerCase())
                .filter(Boolean);

            const isExcluded = currentHostname && existing.includes(currentHostname);
            if (isExcluded) {
                setExcludeButtonState(true, 'Website Excluded', 'Saved to settings exclude list');
            } else {
                setExcludeButtonState(false, 'Exclude Website', 'Add current site to blocked list');
            }

            updateControlSubtitle(isExcluded, false);
        });
    });