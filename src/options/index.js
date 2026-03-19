// Settings page script for Interactive Subtitle Dictionary
    const displayMode = document.getElementById('displayMode');
    const aiProvider = document.getElementById('aiProvider');
    const disabledSites = document.getElementById('disabledSites');
    const autoEnable = document.getElementById('autoEnable');
    const ankiDeck = document.getElementById('ankiDeck');
    const ankiNoteType = document.getElementById('ankiNoteType');
    const saveBtn = document.getElementById('saveBtn');
    const resetBtn = document.getElementById('resetBtn');
    const saveStatus = document.getElementById('saveStatus');
    const testAnkiBtn = document.getElementById('testAnkiBtn');
    const ankiTestResult = document.getElementById('ankiTestResult');
    const mistralApiKey = document.getElementById('mistralApiKey');
    const mistralFields = document.getElementById('mistralFields');
    const aiResponseLanguage = document.getElementById('aiResponseLanguage');
    
    // Dynamic Language Mappings
    const languageMappingsContainer = document.getElementById('languageMappingsContainer');
    const addLanguageBtn = document.getElementById('addLanguageBtn');
    let languageMappings = [
        { language: 'Italian', deck: 'Italian' } // Default start state
    ];

    // Custom LLM fields
    const customLlmFields = document.getElementById('customLlmFields');
    const customLlmUrl = document.getElementById('customLlmUrl');
    const customLlmApiKey = document.getElementById('customLlmApiKey');
    const customLlmModel = document.getElementById('customLlmModel');

    // Google Search fields (temporarily disabled)
    // const googleApiKey = document.getElementById('googleApiKey');
    // const googleSearchEngineId = document.getElementById('googleSearchEngineId');

    // Show/hide custom LLM fields based on provider selection
    function toggleCustomFields() {
        if (['custom', 'openai', 'ollama'].includes(aiProvider.value)) {
            customLlmFields.style.display = 'block';
            mistralFields.style.display = 'none';
        } else {
            customLlmFields.style.display = 'none';
            mistralFields.style.display = 'block';
        }
    }

    aiProvider.addEventListener('change', toggleCustomFields);

    // Render dynamic language mappings
    function renderLanguageMappings() {
        languageMappingsContainer.innerHTML = '';
        if (languageMappings.length === 0) {
            languageMappingsContainer.innerHTML = '<div style="font-size:12px; color:#9ca3af; font-style:italic;">No custom language mappings configured. All words will go to the Default Deck.</div>';
            return;
        }

        languageMappings.forEach((mapping, index) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:8px; align-items:center;';
            row.innerHTML = `
                <input type="text" class="lang-input" placeholder="Language (e.g. French)" value="${mapping.language}" data-index="${index}" style="flex:1;">
                <span style="color:#64748b; font-size:12px;">→</span>
                <input type="text" class="deck-input" placeholder="Deck Name" value="${mapping.deck}" data-index="${index}" style="flex:1;">
                <button class="remove-lang-btn" data-index="${index}" style="background:none; border:none; cursor:pointer; font-size:14px; color:#ef4444; padding:4px;">✖</button>
            `;
            languageMappingsContainer.appendChild(row);
        });

        // Add event listeners to new elements
        document.querySelectorAll('.lang-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                languageMappings[idx].language = e.target.value.trim();
            });
        });
        document.querySelectorAll('.deck-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                languageMappings[idx].deck = e.target.value.trim();
            });
        });
        document.querySelectorAll('.remove-lang-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.currentTarget.getAttribute('data-index'));
                languageMappings.splice(idx, 1);
                renderLanguageMappings();
            });
        });
    }

    addLanguageBtn.addEventListener('click', (e) => {
        e.preventDefault();
        languageMappings.push({ language: '', deck: '' });
        renderLanguageMappings();
    });

    // Load saved settings
    chrome.storage.sync.get(
        [
            'displayMode',
            'aiProvider',
            'disabledSites',
            'autoEnable',
            'ankiDeck',
            'languageMappings',
            'ankiNoteType',
            'customLlmUrl',
            'customLlmApiKey',
            'customLlmModel',
            'aiResponseLanguage',
            // 'googleApiKey',
            // 'googleSearchEngineId',
            'mistralApiKey'
        ],
        (result) => {
            if (result.displayMode) displayMode.value = result.displayMode;
            if (result.aiProvider) aiProvider.value = result.aiProvider;
            if (result.disabledSites) disabledSites.value = result.disabledSites;
            if (typeof result.autoEnable !== 'undefined') autoEnable.checked = result.autoEnable;
            if (result.ankiDeck) {
                ankiDeck.value = result.ankiDeck === 'Default' ? 'English' : result.ankiDeck;
            }
            if (result.languageMappings && Array.isArray(result.languageMappings)) {
                languageMappings = result.languageMappings;
            } else if (result.ankiDeckItalian) {
                // Migrate the old italian deck field explicitly
                languageMappings = [{ language: 'Italian', deck: result.ankiDeckItalian }];
            }
            if (result.ankiNoteType) ankiNoteType.value = result.ankiNoteType;
            if (result.customLlmUrl) customLlmUrl.value = result.customLlmUrl;
            if (result.customLlmApiKey) customLlmApiKey.value = result.customLlmApiKey;
            if (result.customLlmModel) customLlmModel.value = result.customLlmModel;
            if (result.aiResponseLanguage) aiResponseLanguage.value = result.aiResponseLanguage;
            // Google image API settings temporarily disabled.
            // if (result.googleApiKey) googleApiKey.value = result.googleApiKey;
            // if (result.googleSearchEngineId) googleSearchEngineId.value = result.googleSearchEngineId;
            if (result.mistralApiKey) mistralApiKey.value = result.mistralApiKey;
            
            toggleCustomFields();
            renderLanguageMappings();
        }
    );

    // Save settings
    saveBtn.addEventListener('click', () => {
        // Clean up empty language mappings before saving
        const cleanedLanguageMappings = languageMappings.filter(m => m.language.trim() && m.deck.trim());
        
        const settings = {
            displayMode: displayMode.value,
            aiProvider: aiProvider.value,
            disabledSites: disabledSites.value,
            autoEnable: autoEnable.checked,
            ankiDeck: ankiDeck.value,
            languageMappings: cleanedLanguageMappings,
            ankiNoteType: ankiNoteType.value,
            customLlmUrl: customLlmUrl.value,
            customLlmApiKey: customLlmApiKey.value,
            customLlmModel: customLlmModel.value,
            aiResponseLanguage: aiResponseLanguage.value.trim() || 'English',
            // Google image API settings temporarily disabled.
            // googleApiKey: googleApiKey.value,
            // googleSearchEngineId: googleSearchEngineId.value,
            mistralApiKey: mistralApiKey.value,
            enabled: autoEnable.checked
        };
        
        // Update un-saved local state cache just in case
        languageMappings = cleanedLanguageMappings;
        renderLanguageMappings();

        chrome.storage.sync.set(settings, () => {
            saveStatus.textContent = '✅ Settings saved!';
            saveStatus.style.color = '#059669';
            setTimeout(() => {
                saveStatus.textContent = '';
            }, 3000);

            // Notify all active content script tabs
            chrome.tabs.query({}, (tabs) => {
                const supportedSites = ['youtube.com', 'netflix.com', 'amazon.com', 'primevideo.com'];
                tabs.forEach((tab) => {
                    if (tab.url && supportedSites.some(site => tab.url.includes(site))) {
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'updateDisplayMode',
                            mode: settings.displayMode
                        });
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'updateAnkiSettings',
                            deck: settings.ankiDeck,
                            languageMappings: settings.languageMappings,
                            noteType: settings.ankiNoteType
                        });
                        // Google image API update temporarily disabled.
                        // chrome.tabs.sendMessage(tab.id, {
                        //     action: 'updateImageSettings',
                        //     googleApiKey: settings.googleApiKey,
                        //     googleSearchEngineId: settings.googleSearchEngineId
                        // });
                    }
                });
            });
        });
    });

    // Reset to defaults
    resetBtn.addEventListener('click', () => {
        displayMode.value = 'overlay';
        aiProvider.value = 'mistral';
        disabledSites.value = '';
        autoEnable.checked = true;
        autoEnable.checked = true;
        ankiDeck.value = 'English';
        languageMappings = [{ language: 'Italian', deck: 'Italian' }];
        renderLanguageMappings();
        ankiNoteType.value = 'Cloze';
        customLlmUrl.value = '';
        customLlmApiKey.value = '';
        customLlmModel.value = '';
        aiResponseLanguage.value = 'English';
        // Google image API settings temporarily disabled.
        // googleApiKey.value = '';
        // googleSearchEngineId.value = '';
        mistralApiKey.value = '';
        toggleCustomFields();
        saveStatus.textContent = 'Defaults restored — click Save to apply.';
        saveStatus.style.color = '#d97706';
    });

    // Test Anki connection — routed through background script for reliable localhost access
    testAnkiBtn.addEventListener('click', async () => {
        console.log('[ANKI-TEST] 🔌 Test button clicked');
        testAnkiBtn.disabled = true;
        testAnkiBtn.textContent = '⏳ Testing...';
        ankiTestResult.style.display = 'none';

        console.log('[ANKI-TEST] Sending testAnkiConnection message to background script...');
        chrome.runtime.sendMessage({ action: 'testAnkiConnection' }, (response) => {
            console.log('[ANKI-TEST] Got response from background:', response);
            console.log('[ANKI-TEST] chrome.runtime.lastError:', chrome.runtime.lastError);
            testAnkiBtn.disabled = false;
            testAnkiBtn.textContent = '🔌 Test Anki Connection';

            if (chrome.runtime.lastError) {
                console.error('[ANKI-TEST] ❌ Runtime error:', chrome.runtime.lastError.message);
                ankiTestResult.className = 'test-result error';
                ankiTestResult.innerHTML = `❌ <strong>Extension error.</strong> ${chrome.runtime.lastError.message}`;
                ankiTestResult.style.display = 'block';
                return;
            }

            if (response && response.success) {
                console.log('[ANKI-TEST] ✅ Success! Version:', response.version);
                ankiTestResult.className = 'test-result success';
                ankiTestResult.textContent = `✅ Connected! AnkiConnect v${response.version} is running. You're ready to create flashcards.`;
                ankiTestResult.style.display = 'block';
            } else {
                const errMsg = response?.error || 'Unknown error';
                console.error('[ANKI-TEST] ❌ Failed:', errMsg, 'Full response:', response);
                ankiTestResult.className = 'test-result error';
                if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError') || errMsg.includes('fetch')) {
                    ankiTestResult.innerHTML = `❌ <strong>Cannot reach Anki.</strong> Make sure Anki is running on your computer and the AnkiConnect add-on (code: 2055492159) is installed. See the setup tutorial below.`;
                } else {
                    ankiTestResult.textContent = `❌ Error: ${errMsg}`;
                }
                ankiTestResult.style.display = 'block';
            }
        });
    });
