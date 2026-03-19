import { handleAnkiRequest, handleTestAnkiConnection } from './anki.js';
import { fetchDictionaryData, handleGetAIDefinitionDirect } from './api.js';
import { createContextMenu, handleContextMenuClick } from './contextMenu.js';

// Safely re-create the context menu every time the service worker activates.
// removeAll() first prevents the "already exists" error on extension reload.
const safeCreateContextMenu = () => {
    chrome.contextMenus.removeAll(() => {
        createContextMenu();
    });
};

chrome.runtime.onInstalled.addListener(() => {
    console.log('Interactive Subtitles extension installed (Vite Build)');
    safeCreateContextMenu();

    chrome.storage.sync.set({
        aiProvider: 'mistral',
        enabled: true,
        displayMode: 'overlay',
        ankiDeck: 'English',
        ankiNoteType: 'Basic',
        disabledSites: ''
    });
});

// Re-create the context menu when the browser starts (extension already installed).
chrome.runtime.onStartup.addListener(() => {
    console.log('Browser started – re-registering context menu');
    safeCreateContextMenu();
});

chrome.action.onClicked.addListener((tab) => {
    const supportedSites = ['youtube.com', 'netflix.com', 'amazon.com', 'primevideo.com'];
    const isSupported = supportedSites.some(site => tab.url.includes(site));

    if (!isSupported) {
        return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'toggle' }, () => {
        if (chrome.runtime.lastError) {
            chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['src/content/index.js'] // Vite will inject the bundled output path
            }, () => {
                if (chrome.runtime.lastError) {
                    console.error('Failed to inject content script:', chrome.runtime.lastError);
                    return;
                }
                setTimeout(() => {
                    chrome.tabs.sendMessage(tab.id, { action: 'toggle' });
                }, 500);
            });
        }
    });
});

chrome.contextMenus.onClicked.addListener(handleContextMenuClick);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'log') {
        console.log('Content script:', request.message);
    }

    if (request.action === 'error') {
        console.error('Content script error:', request.error);
    }

    if (request.action === 'fetchDictionary') {
        fetchDictionaryData(request.word, request.source)
            .then(result => {
                sendResponse({ success: true, data: result });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    if (request.action === 'getAIDefinitionDirect') {
        handleGetAIDefinitionDirect(request, sendResponse);
        return true;
    }

    if (request.action === 'captureScreenshot') {
        const resolveTarget = (cb) => {
            if (sender.tab?.id) {
                cb({ tabId: sender.tab.id, windowId: sender.tab.windowId || chrome.windows.WINDOW_ID_CURRENT });
                return;
            }

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (chrome.runtime.lastError) {
                    sendResponse({ success: false, error: chrome.runtime.lastError.message });
                    return;
                }

                const activeTab = tabs && tabs[0];
                if (!activeTab?.id) {
                    sendResponse({ success: false, error: 'No active tab found for screenshot capture' });
                    return;
                }

                cb({
                    tabId: activeTab.id,
                    windowId: activeTab.windowId || chrome.windows.WINDOW_ID_CURRENT
                });
            });
        };

        const hideUiInTab = (tabId, cb) => {
            chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const selectors = [
                        '#definition-modal',
                        '.definition-modal',
                        '#interactive-subtitle-container',
                        '#interactive-sidebar',
                        '.interactive-subtitle-sidebar'
                    ];

                    const nodes = document.querySelectorAll(selectors.join(','));
                    nodes.forEach((el) => {
                        if (el.getAttribute('data-contextlingo-hidden') === '1') return;

                        el.setAttribute('data-contextlingo-prev-opacity', el.style.opacity || '');
                        el.setAttribute('data-contextlingo-prev-visibility', el.style.visibility || '');
                        el.setAttribute('data-contextlingo-prev-pointer-events', el.style.pointerEvents || '');

                        el.style.opacity = '0';
                        el.style.visibility = 'hidden';
                        el.style.pointerEvents = 'none';
                        el.setAttribute('data-contextlingo-hidden', '1');
                    });
                }
            }, () => cb());
        };

        const restoreUiInTab = (tabId, cb) => {
            chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const nodes = document.querySelectorAll('[data-contextlingo-hidden="1"]');
                    nodes.forEach((el) => {
                        const prevOpacity = el.getAttribute('data-contextlingo-prev-opacity') || '';
                        const prevVisibility = el.getAttribute('data-contextlingo-prev-visibility') || '';
                        const prevPointerEvents = el.getAttribute('data-contextlingo-prev-pointer-events') || '';

                        el.style.opacity = prevOpacity;
                        el.style.visibility = prevVisibility;
                        el.style.pointerEvents = prevPointerEvents;

                        el.removeAttribute('data-contextlingo-hidden');
                        el.removeAttribute('data-contextlingo-prev-opacity');
                        el.removeAttribute('data-contextlingo-prev-visibility');
                        el.removeAttribute('data-contextlingo-prev-pointer-events');
                    });
                }
            }, () => cb());
        };

        resolveTarget(({ tabId, windowId }) => {
            hideUiInTab(tabId, () => {
                // Let the browser repaint hidden elements before taking the screenshot.
                setTimeout(() => {
                    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
                        const runtimeError = chrome.runtime.lastError;
                        restoreUiInTab(tabId, () => {
                            if (runtimeError) {
                                sendResponse({ success: false, error: runtimeError.message });
                            } else {
                                sendResponse({ success: true, dataUrl: dataUrl });
                            }
                        });
                    });
                }, 90);
            });
        });
        return true; 
    }

    if (request.action === 'ankiRequest') {
        handleAnkiRequest(request, sendResponse);
        return true;
    }

    if (request.action === 'testAnkiConnection') {
        handleTestAnkiConnection(sendResponse);
        return true;
    }

});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        const supportedSites = ['youtube.com', 'netflix.com', 'amazon.com', 'primevideo.com'];
        const isSupported = supportedSites.some(site => tab.url.includes(site));

        if (isSupported) {
            setTimeout(() => {
                chrome.tabs.sendMessage(tabId, { action: 'pageUpdated' }, () => {});
            }, 1000);
        }
    }
});
