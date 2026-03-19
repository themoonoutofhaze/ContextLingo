export const createContextMenu = () => {
    chrome.contextMenus.create({
        id: "translate_selection",
        title: "Translate with ContextLingo",
        contexts: ["selection"]
    });
};

const openTranslatePage = (word, context) => {
    const safeWord    = word    || '';
    const safeContext = context || word || '';
    chrome.storage.session.set({ translateLookup: { word: safeWord, context: safeContext, ts: Date.now() } }, () => {
        // Also pass lookup data via query params so Edge PDF fallback does not rely
        // only on session storage handoff between extension pages.
        const params = new URLSearchParams({
            word: safeWord,
            context: safeContext
        });
        const url = `${chrome.runtime.getURL('src/standalone/index.html')}?${params.toString()}`;

        // Match a compact extension-popup style window and center it.
        const popupWidth = 900;
        const popupHeight = 700;

        chrome.windows.getLastFocused({ populate: false }, (win) => {
            const left = Math.max(0, Math.round(((win?.left ?? 0) + ((win?.width ?? popupWidth) - popupWidth) / 2)));
            const top = Math.max(0, Math.round(((win?.top ?? 0) + ((win?.height ?? popupHeight) - popupHeight) / 2)));

            chrome.windows.create({
                url,
                type: 'popup',
                width: popupWidth,
                height: popupHeight,
                left,
                top,
                focused: true
            });
        });
    });
};

const sendMessageWithTimeout = (tabId, payload, timeoutMs, callback) => {
    let done = false;

    const finish = (result) => {
        if (done) return;
        done = true;
        callback(result);
    };

    const timeoutId = setTimeout(() => {
        finish({ ok: false, timeout: true, error: 'Timed out waiting for content script response' });
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, payload, (response) => {
        const runtimeError = chrome.runtime.lastError;
        clearTimeout(timeoutId);

        if (runtimeError || !response) {
            finish({ ok: false, error: runtimeError?.message || 'No response from content script', response });
            return;
        }

        finish({ ok: true, response });
    });
};

const injectAndTranslate = (tabId, word, context) => {
    // The content script is already injected by the manifest for all_urls.
    // Just send the message directly; if it fails the tab truly has no content
    // script (e.g. chrome:// page or PDF) so fall back to the standalone popup.
    sendMessageWithTimeout(tabId, { action: 'contextMenuTranslate', word, context }, 650, (result) => {
        if (!result.ok) {
            console.log('[BG] Direct message failed, opening standalone popup:', result.error);
            openTranslatePage(word, context);
        }
    });
};

const captureSelectionAndContext = (tabId, frameId, hintedSelectionText, callback) => {
    const targets = [];
    const safeFrameId = Number.isInteger(frameId) ? frameId : 0;

    targets.push({ tabId, frameIds: [safeFrameId] });
    if (safeFrameId !== 0) {
        targets.push({ tabId, frameIds: [0] });
    }
    targets.push({ tabId, allFrames: true });

    let best = {
        selectedText: (hintedSelectionText || '').trim(),
        context: null
    };

    let completed = false;
    const finalize = () => {
        if (completed) return;
        completed = true;
        callback(best);
    };

    // Some PDF/article contexts may never resolve executeScript callbacks.
    // Global guard prevents right-click events from queuing indefinitely.
    const globalTimeout = setTimeout(() => {
        console.log('[BG] Context capture timed out, using best-effort selection/context');
        finalize();
    }, 1400);

    const mergeBest = (payload) => {
        if (!payload) return;

        const candidateWord = (payload.selectedText || '').trim();
        const candidateContext = (payload.context || '').trim();

        if (candidateWord && candidateWord.length > best.selectedText.length) {
            best.selectedText = candidateWord;
        }

        if (!best.context || candidateContext.length > best.context.length) {
            best.context = candidateContext || best.context;
        }
    };

    const runTarget = (index) => {
        if (completed) return;

        if (index >= targets.length) {
            clearTimeout(globalTimeout);
            finalize();
            return;
        }

        let advanced = false;
        const advance = () => {
            if (advanced || completed) return;
            advanced = true;
            runTarget(index + 1);
        };

        const stepTimeout = setTimeout(() => {
            console.log('[BG] executeScript step timed out, continuing to next target');
            advance();
        }, 450);

        chrome.scripting.executeScript({
            target: targets[index],
            func: (textHint) => {
                const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();

                const normalizeContextWindow = (fullText, focusText, maxLen = 500) => {
                    const cleanFull = normalize(fullText);
                    const cleanFocus = normalize(focusText);
                    if (!cleanFull) return '';
                    if (!cleanFocus) return cleanFull.slice(0, maxLen);

                    const lowerFull = cleanFull.toLowerCase();
                    const lowerFocus = cleanFocus.toLowerCase();
                    const idx = lowerFull.indexOf(lowerFocus);

                    if (idx === -1) return cleanFull.slice(0, maxLen);

                    const half = Math.floor(maxLen / 2);
                    const start = Math.max(0, idx - half);
                    const end = Math.min(cleanFull.length, idx + cleanFocus.length + half);
                    return cleanFull.slice(start, end).trim();
                };

                const getDeepSelectionText = () => {
                    let bestSel = normalize(window.getSelection ? window.getSelection().toString() : '');

                    const walk = (root, depth) => {
                        if (!root || depth > 6 || !root.querySelectorAll) return;
                        const nodes = root.querySelectorAll('*');
                        for (const node of nodes) {
                            if (!node.shadowRoot) continue;
                            const shadowSelection = node.shadowRoot.getSelection
                                ? normalize(node.shadowRoot.getSelection().toString())
                                : '';
                            if (shadowSelection && shadowSelection.length > bestSel.length) {
                                bestSel = shadowSelection;
                            }
                            walk(node.shadowRoot, depth + 1);
                        }
                    };

                    walk(document, 1);
                    return bestSel;
                };

                const findContextFromCurrentSelection = (needle) => {
                    const BLOCKS = new Set(['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT']);
                    const sel = window.getSelection ? window.getSelection() : null;
                    if (!sel || sel.rangeCount === 0) {
                        if (document.body && document.body.innerText && needle) {
                            return normalizeContextWindow(document.body.innerText, needle, 500);
                        }
                        return '';
                    }

                    const range = sel.getRangeAt(0);
                    let node = range.startContainer;
                    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
                    let el = node;

                    if (el) {
                        const immediateText = normalize(el.innerText || el.textContent || '');
                        if (immediateText.length >= 20 && (!needle || immediateText.toLowerCase().includes(needle.toLowerCase()))) {
                             return normalizeContextWindow(immediateText, needle, 500);
                        }
                    }

                    while (el && el !== document.body && el !== document.documentElement) {
                        if (el.tagName && BLOCKS.has(String(el.tagName).toUpperCase())) {
                            const text = normalize(el.innerText || el.textContent || '');
                            if (text.length >= 40 && (!needle || text.toLowerCase().includes(needle.toLowerCase()))) {
                                return text;
                            }
                        }
                        el = el.parentNode instanceof ShadowRoot ? el.parentNode.host : el.parentElement;
                    }

                    return '';
                };

                const findContextFromTextLayers = (needle) => {
                    if (!needle) return '';

                    const selectors = [
                        '.textLayer',
                        '.textLayer span',
                        '[class*="textLayer"]',
                        '[class*="textLayer"] span',
                        '.pdfViewer .page',
                        '.pdfViewer',
                        '.page',
                        '.viewer',
                        'article p',
                        'main p',
                        'p',
                        'li',
                        'blockquote',
                        'h1, h2, h3, h4, h5, h6',
                        'div'
                    ];

                    const lowerNeedle = needle.toLowerCase();
                    const words = lowerNeedle.split(/\s+/).filter(w => w.length > 2);

                    for (const selector of selectors) {
                        const nodes = document.querySelectorAll(selector);
                        let checked = 0;

                        for (const el of nodes) {
                            checked += 1;
                            if (checked > 1000) break;

                            const text = normalize(el.innerText || el.textContent || '');
                            if (text.length < 5) continue;
                            
                            const lowerText = text.toLowerCase();
                            
                            if (lowerText.includes(lowerNeedle) || (words.length > 0 && words.every(w => lowerText.includes(w)))) {
                                if (text.length >= 40) return normalizeContextWindow(text, needle, 500);
                                
                                const parent = el.parentElement;
                                if (parent && parent !== document.body) {
                                    const pText = normalize(parent.innerText || parent.textContent || '');
                                    if (pText.length >= 40 && pText.toLowerCase().includes(lowerNeedle)) {
                                        return normalizeContextWindow(pText, needle, 500);
                                    }
                                }
                            }
                        }
                    }

                    return '';
                };

                let selectedText = getDeepSelectionText();
                if (!selectedText) {
                    selectedText = normalize(textHint || '');
                }

                let context = findContextFromCurrentSelection(selectedText);

                if (!context) {
                    context = findContextFromTextLayers(selectedText);
                }

                if (!context && document.body) {
                    context = normalizeContextWindow(document.body.innerText || document.body.textContent || '', selectedText, 500);
                }

                return {
                    selectedText,
                    context: normalize(context)
                };
            },
            args: [hintedSelectionText || '']
        }, (results) => {
            clearTimeout(stepTimeout);

            if (!chrome.runtime.lastError && Array.isArray(results)) {
                for (const item of results) {
                    if (item && item.result) mergeBest(item.result);
                }
            }

            advance();
        });
    };

    runTarget(0);
};

export const handleContextMenuClick = (info, tab) => {
    if (info.menuItemId !== "translate_selection") return;
    if (!tab) return;

    const selectedText = String(info.selectionText || '').trim();
    console.log('[BG] Context menu triggered, tab URL:', tab.url, 'selectionText:', JSON.stringify(selectedText));

    const tabUrl = tab.url || '';
    const canInject = !tabUrl.startsWith('chrome://') &&
                      !tabUrl.startsWith('chrome-extension://') &&
                      !tabUrl.startsWith('devtools://') &&
                      !tabUrl.startsWith('edge://') &&
                      !tabUrl.startsWith('extension://') &&
                      !tabUrl.startsWith('about:');

    if (!canInject) {
        openTranslatePage(selectedText, selectedText);
        return;
    }

    captureSelectionAndContext(tab.id, info.frameId, selectedText, (capture) => {
        let resolvedWord = String((capture && capture.selectedText) || selectedText || '').trim();
        let resolvedContext = String((capture && capture.context) || resolvedWord || '').trim();

        if (!resolvedWord && resolvedContext) {
            const firstToken = resolvedContext.match(/[\p{L}\p{N}'-]+/u);
            resolvedWord = firstToken ? firstToken[0] : '';
        }

        if (!resolvedWord) {
            console.log('[BG] No selected word resolved from context menu click, aborting');
            return;
        }

        const wordCount = resolvedWord.split(/\s+/).filter(w => w.length > 0).length;
        if (wordCount > 1) {
            resolvedContext = resolvedWord;
        }

        sendMessageWithTimeout(tab.id, {
            action: 'contextMenuTranslate',
            word: resolvedWord,
            context: resolvedContext,
            isSentence: wordCount > 1
        }, 700, (result) => {
            if (result.ok) {
                return;
            }
            injectAndTranslate(tab.id, resolvedWord, resolvedContext);
        });
    });
};
