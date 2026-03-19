// Side Panel script for Interactive Subtitle Dictionary

const lookupHistory = [];

// Default Anki settings
let ankiNoteType = 'Cloze';
let ankiDeck = 'English';
let ankiDeckItalian = 'Italian';
let languageMappings = [];
let currentAiResponseRaw = '';

// Load settings
chrome.storage.sync.get(['ankiNoteType', 'ankiDeck', 'ankiDeckItalian', 'languageMappings'], (res) => {
    if (res.ankiNoteType) ankiNoteType = res.ankiNoteType;
    if (res.ankiDeck) ankiDeck = res.ankiDeck;
    if (res.ankiDeckItalian) ankiDeckItalian = res.ankiDeckItalian;
    if (res.languageMappings) languageMappings = res.languageMappings;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateSidePanel') {
        displayWord(request.word, request.context, request.definition);
        sendResponse({ success: true });
    }
    // Handle PDF translations — the background script sends this when the user
    // right-clicks a word in a PDF and the side panel is open/being opened.
    if (request.action === 'pdfTranslate') {
        displayWord(request.word, request.context || request.word, null);
        sendResponse && sendResponse({ success: true });
    }
});

// On load: check if there's a pending PDF translation stored in session
document.addEventListener('DOMContentLoaded', () => {
    if (chrome.storage && chrome.storage.session) {
        chrome.storage.session.get('pendingPdfTranslate', (result) => {
            const pending = result && result.pendingPdfTranslate;
            if (pending && pending.word && (Date.now() - pending.timestamp < 10000)) {
                console.log('[SidePanel] Found pending PDF translate:', pending.word);
                displayWord(pending.word, pending.context || pending.word, null);
                // Clear the pending item
                chrome.storage.session.remove('pendingPdfTranslate');
            }
        });
    }
});

// Update history display
    updateHistory();


const style = document.createElement('style');
style.textContent = `
  .interactive-word {
    cursor: text;
    border-radius: 4px;
    padding: 2px 4px;
    transition: all 0.2s;
    display: inline-block;
  }
  .interactive-word:hover {
    background: rgba(96, 165, 250, 0.1);
    color: #60a5fa;
  }
  .interactive-word.active-lookup {
    background: #1a73e8;
    color: #fff;
    box-shadow: 0 0 0 1px #60a5fa;
  }
  .info-msg {
    padding: 10px;
    background: rgba(59, 130, 246, 0.1);
    border-radius: 6px;
    color: #94a3b8;
    font-size: 12px;
    border-left: 3px solid #3b82f6;
    margin-top: 10px;
  }
`;
document.head.appendChild(style);

function renderInteractiveSentence(sentence, targetElement) {
    targetElement.innerHTML = '';
    const words = sentence.split(/(\s+)/);
    words.forEach(part => {
        if (/\w+/.test(part)) {
            const span = document.createElement('span');
            span.textContent = part;
            span.className = 'interactive-word';
            targetElement.appendChild(span);
        } else {
            targetElement.appendChild(document.createTextNode(part));
        }
    });

    targetElement.addEventListener('mouseup', () => {
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        if (selectedText.length > 0) {
            let range = selection.getRangeAt(0);
            let startNode = range.startContainer;
            let endNode = range.endContainer;

            if (startNode.nodeType === Node.TEXT_NODE) startNode = startNode.parentNode;
            if (endNode.nodeType === Node.TEXT_NODE) endNode = endNode.parentNode;

            if (!targetElement.contains(startNode) || !targetElement.contains(endNode)) return;

            const startWordEl = startNode.closest('.interactive-word');
            const endWordEl = endNode.closest('.interactive-word');

            let phrase = '';
            if (startWordEl && endWordEl) {
                const allWords = Array.from(targetElement.querySelectorAll('.interactive-word'));
                const startIndex = allWords.indexOf(startWordEl);
                const endIndex = allWords.indexOf(endWordEl);

                if (startIndex !== -1 && endIndex !== -1) {
                    const first = Math.min(startIndex, endIndex);
                    const last = Math.max(startIndex, endIndex);
                    const words = [];
                    for (let i = first; i <= last; i++) {
                        words.push(allWords[i].textContent);
                    }
                    phrase = words.join(' ');
                } else {
                    phrase = selectedText;
                }
            } else if (startWordEl) {
                phrase = startWordEl.textContent;
            } else if (endWordEl) {
                phrase = endWordEl.textContent;
            } else {
                phrase = selectedText;
            }

            phrase = phrase.trim();
            if (phrase.length > 0) {
                const word = phrase.replace(/[.,!?;:"'()[\]{}]/g, '');
                
                // Update active word in title attribute for AI button
                const wordSection = targetElement.closest('.word-section');
                const wordTitle = wordSection.querySelector('.word-title');
                wordTitle.setAttribute('data-active-word', word);
                
                // Show update in UI
                const aiBtn = document.getElementById('get-ai-btn');
                if (aiBtn) {
                    aiBtn.style.display = 'block';
                    aiBtn.disabled = false;
                    aiBtn.textContent = '🤖 Get AI Definition for "' + word + '"';
                }
                document.getElementById('ai-response-area').innerHTML = '<div class="info-msg">Click below to translate "' + word + '".</div>';
                
                if (selection && typeof selection.removeAllRanges === 'function') {
                    selection.removeAllRanges();
                }
            }
        }
    });
}

function isItalianLang(word, context) {
    if (ankiDeckItalian === 'Italian' && context) {
      const itWords = /\b(il|lo|la|i|gli|le|un|uno|una|di|a|da|in|con|su|per|tra|fra|e|ed|o|ma|se|che|non|sono|sei|è|siamo|siete|ho|hai|ha|abbiamo)\b/gi;
      const enWords = /\b(the|a|an|in|on|at|to|for|with|by|about|and|but|or|so|because|is|are|was|were|have|has|had|he|she|it|they|we|you|this|that)\b/gi;
      const itCount = (context.match(itWords) || []).length;
      const enCount = (context.match(enWords) || []).length;
      if (itCount > enCount) return true;
      if (enCount > itCount) return false;
    }
    if (/[òàùìéè]/i.test(word)) return true;
    return false;
}

function buildDictionaryLinksMarkup(word, isItalian, variant = 'modal') {
    if (isItalian) {
      if (variant === 'sidebar') {
        return `
          <a href="https://www.collinsdictionary.com/dictionary/italian-english/${encodeURIComponent(word.toLowerCase())}" target="_blank" class="sidebar-dict-card">
            <span class="sidebar-dict-icon">📘</span>
            <div><strong>Collins Italian-English</strong><br><small>Comprehensive translation and phrases</small></div>
          </a>
          <a href="https://www.wordreference.com/iten/${encodeURIComponent(word.toLowerCase())}" target="_blank" class="sidebar-dict-card">
            <span class="sidebar-dict-icon">🎓</span>
            <div><strong>WordReference IT-EN</strong><br><small>Forum discussions and examples</small></div>
          </a>
          <a href="https://context.reverso.net/translation/italian-english/${encodeURIComponent(word.toLowerCase())}" target="_blank" class="sidebar-dict-card">
            <span class="sidebar-dict-icon">📖</span>
            <div><strong>Reverso Context</strong><br><small>Translation in real contexts</small></div>
          </a>
        `;
      }
      return '';
    }

    if (variant === 'sidebar') {
      return `
        <a href="https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}" target="_blank" class="sidebar-dict-card">
          <span class="sidebar-dict-icon">📘</span>
          <div><strong>Cambridge Dictionary</strong><br><small>British English pronunciation and usage</small></div>
        </a>
        <a href="https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(word)}" target="_blank" class="sidebar-dict-card">
          <span class="sidebar-dict-icon">🎓</span>
          <div><strong>Oxford Learners</strong><br><small>Clear definitions for English learners</small></div>
        </a>
        <a href="https://www.ldoceonline.com/dictionary/${encodeURIComponent(word)}" target="_blank" class="sidebar-dict-card">
          <span class="sidebar-dict-icon">📖</span>
          <div><strong>Longman Dictionary</strong><br><small>Contemporary English with examples</small></div>
        </a>
      `;
    }
    return '';
}

function displayWord(word, context) {
    // Add to history
    lookupHistory.unshift({ word, context, time: new Date() });
    if (lookupHistory.length > 20) lookupHistory.pop();

    const wordCount = (word || '').trim().split(/\s+/).length;
    const isSentence = wordCount > 3;
    const displayWordTxt = isSentence ? "" : word;
    const headerTitle = isSentence ? "Select a word" : `Definition: "${displayWordTxt}"`;
    const targetWordBadgeTxt = isSentence ? "..." : displayWordTxt;
    const aiBtnText = isSentence ? "Select a word to get AI Definition" : `Get AI Definition for "${displayWordTxt}"`;

    const isItalian = isItalianLang(displayWordTxt, context);
    const websterTabName = isItalian ? 'Wiktionary IT' : 'Merriam-Webster';
    const merriamUrl = isItalian
      ? `https://en.wiktionary.org/wiki/${encodeURIComponent(displayWordTxt.toLowerCase())}#Italian`
      : `https://www.merriam-webster.com/dictionary/${encodeURIComponent(displayWordTxt)}`;
    const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(displayWordTxt)}`;

    const panelContent = document.getElementById('panel-content');    
    panelContent.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-word-header">
          <h3 class="word-title" data-active-word="${displayWordTxt}">${headerTitle}</h3>
          <button class="sidebar-theme-btn" title="Toggle Theme">☀️</button>
        </div>
        <div class="sidebar-controls">
          <button class="sidebar-text-minus-btn" title="Decrease Text Size">A-</button>
          <button class="sidebar-text-plus-btn" title="Increase Text Size">A+</button>
        </div>
      </div>
      
      <div class="sidebar-tabs">
        <button class="sidebar-tab-btn active" data-tab="ai">AI</button>
        <button class="sidebar-tab-btn" data-tab="dictionaries">Dictionaries</button>
        <button class="sidebar-tab-btn" data-tab="merriam" id="sidebar-merriam-tab-btn">${websterTabName}</button>
        <button class="sidebar-tab-btn" data-tab="wikipedia">Wikipedia</button>
      </div>
      
      <div class="sidebar-content">
        <div class="sidebar-panel active" data-tab="ai">
          <div class="sidebar-ai-section">
            <h4 style="margin: 0 0 10px 0; font-size: 14px; display: flex; align-items: center; justify-content: space-between;">
              <span>AI Analysis</span>
              <span id="sidebar-target-word-badge" style="background: rgba(96,165,250,0.2); color: #60a5fa; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500;">${targetWordBadgeTxt}</span>
            </h4>
            
            <div class="context-edit-container">
              <div class="context-display sentence-lookup-area context-view-mode" style="font-size:13px; margin-bottom: 12px; display:flex; justify-content:space-between;">
                <div><strong>Context: </strong> <span class="context-text">"${context || 'No context available'}"</span></div>
                <button class="edit-context-btn" title="Edit context" style="background:none; border:none; color:#3b82f6; cursor:pointer; font-size:12px; padding:0 4px;">✎</button>
              </div>
              <div class="context-edit-mode" style="display:none; margin-bottom:12px;">
                <textarea class="context-textarea" style="width:100%; min-height:60px; font-size:12px; padding:6px; border:1px solid #cbd5e1; border-radius:4px; font-family:inherit; margin-bottom:4px;">${context}</textarea>
                <div style="display:flex; gap:6px; justify-content:flex-end;">
                  <button class="cancel-context-btn" style="font-size:11px; padding:3px 8px; background:#f1f5f9; color:#475569; border:none; border-radius:3px; cursor:pointer;">Cancel</button>
                  <button class="save-context-btn" style="font-size:11px; padding:3px 8px; background:#3b82f6; color:white; border:none; border-radius:3px; cursor:pointer;">Save</button>
                </div>
              </div>
            </div>
            
            <button id="get-ai-btn" class="ai-btn" data-target-word="${displayWordTxt}" style="width:100%; margin-top: 10px;">${aiBtnText}</button>
            <div id="ai-response-area" class="ai-response" style="display:block; margin-top:12px;"><div class="info-msg">Select a word above to translate it.</div></div>
          </div>
        </div>

        <div class="sidebar-panel" data-tab="merriam" style="display:none;">
          <div class="sidebar-iframe-wrap">
            <iframe src="${merriamUrl}" sandbox="allow-same-origin allow-scripts allow-popups allow-forms" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
            <a href="${merriamUrl}" target="_blank" class="sidebar-external-link">Open in New Tab →</a>
          </div>
        </div>

        <div class="sidebar-panel" data-tab="wikipedia" style="display:none;">
          <div class="sidebar-iframe-wrap">
            <iframe src="${wikiUrl}" sandbox="allow-same-origin allow-scripts allow-popups allow-forms" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
            <a href="${wikiUrl}" target="_blank" class="sidebar-external-link">Open in New Tab →</a>
          </div>
        </div>

        <div class="sidebar-panel" data-tab="dictionaries" style="display:none;">
          <div class="sidebar-dict-links">
            ${buildDictionaryLinksMarkup(displayWordTxt, isItalian, 'sidebar')}
          </div>
        </div>
      </div>
      
      <div class="sidebar-anki-bar">
        <button id="anki-btn" class="anki-btn" style="flex:1;">⭐ Add to Anki</button>
        <span id="status-text" class="status-text" style="font-size:11px;color:#6c757d;"></span>
      </div>
    `;

    // ADD TAB LOGIC
    panelContent.querySelectorAll('.sidebar-tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        panelContent.querySelectorAll('.sidebar-tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        const tabName = e.target.getAttribute('data-tab');
        panelContent.querySelectorAll('.sidebar-panel').forEach(p => {
          p.classList.remove('active');
          p.style.display = 'none';
        });
        const activePanel = panelContent.querySelector(`.sidebar-panel[data-tab="${tabName}"]`);
        if (activePanel) {
          activePanel.classList.add('active');
          activePanel.style.display = 'block';
        }
      });
    });

    const themeBtn = panelContent.querySelector('.sidebar-theme-btn');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            document.getElementById('panel-content').classList.toggle('dark-mode');
            themeBtn.textContent = document.getElementById('panel-content').classList.contains('dark-mode') ? '☀️' : '🌙';
        });
    }

    // Resize logic
    const minusBtn = panelContent.querySelector('.sidebar-text-minus-btn');
    const plusBtn = panelContent.querySelector('.sidebar-text-plus-btn');
    let currentFontSize = 14;
    if (minusBtn && plusBtn) {
        minusBtn.addEventListener('click', () => {
            currentFontSize = Math.max(12, currentFontSize - 1);
            panelContent.style.fontSize = currentFontSize + 'px';
        });
        plusBtn.addEventListener('click', () => {
            currentFontSize = Math.min(20, currentFontSize + 1);
            panelContent.style.fontSize = currentFontSize + 'px';
        });
    }
    if (wordCount > 1 || (context && context.length > 0)) {
        const interactiveContainer = panelContent.querySelector('.context-text');
        // If word is a phrase, make it interactive. 
        // Also make context interactive if it exists.
        if (interactiveContainer) {
            renderInteractiveSentence(wordCount > 1 ? word : (context || word), interactiveContainer);
        }
    }
    const editBtn = panelContent.querySelector('.edit-context-btn');
    const saveBtn = panelContent.querySelector('.save-context-btn');
    const cancelBtn = panelContent.querySelector('.cancel-context-btn');
    const viewMode = panelContent.querySelector('.context-view-mode');
    const editMode = panelContent.querySelector('.context-edit-mode');
    const textarea = panelContent.querySelector('.context-textarea');
    const textSpan = panelContent.querySelector('.context-text');

    if (editBtn) {
        editBtn.addEventListener('click', () => {
            viewMode.style.display = 'none';
            editMode.style.display = 'block';
            textarea.focus();
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            viewMode.style.display = 'block';
            editMode.style.display = 'none';
            textarea.value = context;
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const newContext = textarea.value.trim();
            if (newContext) {
                context = newContext; // Update local variable
                textSpan.textContent = newContext;
                viewMode.style.display = 'block';
                editMode.style.display = 'none';
                
                // If we already have a definition button, maybe reset it to allow re-triggering with new context
                const aiBtn = document.getElementById('get-ai-btn');
                if (aiBtn) {
                    aiBtn.style.display = 'block';
                    aiBtn.disabled = false;
                    aiBtn.textContent = '🤖 Get AI Definition';
                    document.getElementById('ai-response-area').innerHTML = '';
                    console.log('[SidePanel] Context updated manually, resetting AI button');
                }
            }
        });
    }

// Helper to escape HTML
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeAiHtml(unsafeHtml) {
    const template = document.createElement('template');
    template.innerHTML = String(unsafeHtml || '');

    const allowedTags = new Set([
        'STRONG', 'B', 'EM', 'I', 'BR', 'P', 'UL', 'OL', 'LI',
        'DIV', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'PRE', 'CODE'
    ]);

    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT, null);
    const toProcess = [];
    while (walker.nextNode()) {
        toProcess.push(walker.currentNode);
    }

    toProcess.forEach((el) => {
        const tag = el.tagName;

        if (!allowedTags.has(tag)) {
            const parent = el.parentNode;
            if (!parent) return;
            while (el.firstChild) {
                parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            return;
        }

        Array.from(el.attributes).forEach((attr) => {
            if (tag === 'A' && (attr.name === 'href' || attr.name === 'target' || attr.name === 'rel')) {
                return;
            }
            if (attr.name === 'class') {
                return;
            }
            el.removeAttribute(attr.name);
        });
    });

    return template.innerHTML;
}

function renderAiDefinition(target, definition) {
    const text = String(definition || '').trim();
    if (!text) {
        target.textContent = 'No AI definition returned.';
        return;
    }

    const structured = extractStructuredAiData(text);
    if (structured) {
        target.innerHTML = renderStructuredAiDefinition(structured);
        return;
    }

    const containsHtml = /<[^>]+>/.test(text);
    if (containsHtml) {
        target.innerHTML = sanitizeAiHtml(text);
        return;
    }

    target.innerHTML = `<div style="line-height:1.6; white-space:pre-wrap;">${escHtml(text)}</div>`;
}

function extractStructuredAiData(aiResponseText) {
    if (!aiResponseText) return null;

    const raw = String(aiResponseText).trim();
    const candidates = [];
    const markerMatch = raw.match(/<CTXLINGO_JSON_START>\s*([\s\S]*?)\s*<CTXLINGO_JSON_END>/i);
    if (markerMatch && markerMatch[1]) candidates.push(markerMatch[1].trim());

    const fencedMatch = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/i);
    if (fencedMatch && fencedMatch[1]) candidates.push(fencedMatch[1].trim());

    if (raw.startsWith('{') && raw.endsWith('}')) candidates.push(raw);

    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        candidates.push(raw.slice(firstBrace, lastBrace + 1).trim());
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && (parsed.meaningInContext || parsed.detectedLanguage || parsed.partOfSpeech)) {
                return parsed;
            }
        } catch {
            // Try next candidate.
        }
    }

    return null;
}

function normalizeAiList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(v => String(v || '').trim()).filter(Boolean);
    }
    return String(value)
        .split(/\n|;/)
        .map(v => v.replace(/^[-*•]\s*/, '').trim())
        .filter(Boolean);
}

function renderStructuredAiDefinition(data) {
    const detectedLanguage = data.detectedLanguage || 'Unknown';
    const partOfSpeech = data.partOfSpeech || 'unknown';
    const phonetics = data.phonetics || '';
    const meaning = data.meaningInContext || '';
    const alternatives = normalizeAiList(data.alternativeMeanings);
    const examples = normalizeAiList(data.exampleSentences);
    const nuances = data.culturalNuances || '';
    const visual = typeof data.isVisual === 'boolean' ? (data.isVisual ? 'Yes' : 'No') : '';
    const visualQuery = data.visualQuery || '';

    let conjugationHtml = '';
    if (data.verbConjugation && Array.isArray(data.verbConjugation.rows) && data.verbConjugation.rows.length > 0) {
        const headers = Array.isArray(data.verbConjugation.headers) ? data.verbConjugation.headers : [];
        const rows = data.verbConjugation.rows;
        conjugationHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;">'
            + (headers.length > 0 ? '<thead><tr>' + headers.map(h => `<th style="border:1px solid #2f4558;padding:4px 6px;">${escHtml(String(h))}</th>`).join('') + '</tr></thead>' : '')
            + '<tbody>'
            + rows.map(row => `<tr>${(Array.isArray(row) ? row : [row]).map(cell => `<td style="border:1px solid #2f4558;padding:4px 6px;">${escHtml(String(cell))}</td>`).join('')}</tr>`).join('')
            + '</tbody></table>';
    }

    let html = '';
    html += `<div class="definition-section"><h6>Language Detection</h6></div><p class="definition-content">${escHtml(String(detectedLanguage))}</p>`;
    html += `<div class="definition-section"><h6>Part of Speech</h6></div><p class="definition-content">${escHtml(String(partOfSpeech))}</p>`;
    if (phonetics) html += `<div class="definition-section"><h6>Phonetics & Stress</h6></div><p class="definition-content">${escHtml(String(phonetics))}</p>`;
    if (meaning) html += `<div class="definition-section"><h6>Meaning in Context</h6></div><p class="definition-content">${escHtml(String(meaning))}</p>`;
    if (alternatives.length > 0) {
        html += `<div class="definition-section"><h6>Alternative Meanings</h6></div>${alternatives.map(v => `<div class="definition-point">• ${escHtml(v)}</div>`).join('')}`;
    }
    if (examples.length > 0) {
        html += `<div class="definition-section"><h6>Example Sentences</h6></div>${examples.map(v => `<div class="definition-point">• ${escHtml(v)}</div>`).join('')}`;
    }
    if (nuances) html += `<div class="definition-section"><h6>Cultural & Linguistic Nuances</h6></div><p class="definition-content">${escHtml(String(nuances))}</p>`;
    if (visual || visualQuery) html += `<div class="definition-section"><h6>Visual</h6></div><p class="definition-content">${escHtml(visual)}${visual && visualQuery ? ' - ' : ''}${escHtml(String(visualQuery))}</p>`;
    if (conjugationHtml) html += `<div class="definition-section"><h6>Verb Conjugation Table</h6></div>${conjugationHtml}`;

    return html;
}

// Extraction helpers
function detectPartOfSpeech(word, aiResponseText) {
    const structured = extractStructuredAiData(aiResponseText);
    if (structured?.partOfSpeech) {
        const posRaw = String(structured.partOfSpeech).toLowerCase().trim();
        const mapped = {
            noun: 'noun',
            verb: 'verb',
            adjective: 'adjective',
            adverb: 'adverb',
            pronoun: 'pronoun',
            preposition: 'preposition',
            conjunction: 'conjunction',
            interjection: 'interjection',
            expression: 'expression'
        };
        const pos = mapped[posRaw] || 'unknown';
        const hasConjugationRows = Array.isArray(structured?.verbConjugation?.rows) && structured.verbConjugation.rows.length > 0;
        return { pos, isItalianVerb: pos === 'verb' && hasConjugationRows };
    }

    const lowerWord = word.toLowerCase();
    const explicitPosMatch = aiResponseText.match(/(?:Part of Speech|Grammatical Category|POS)[^:]*:\s*(?:\[)?([a-zA-Z\s]+)(?:\])?/i);
    if (explicitPosMatch && explicitPosMatch[1]) {
        const rawPos = explicitPosMatch[1].toLowerCase().trim();
        if (rawPos.includes('expression') || rawPos.includes('phrase') || rawPos.includes('idiom')) return { pos: 'expression', isItalianVerb: false };
        if (rawPos.includes('noun') || rawPos.includes('sostantivo')) return { pos: 'noun', isItalianVerb: false };
        if (rawPos.includes('verb') || rawPos.includes('verbo')) {
            const isIt = aiResponseText.includes('Conjugation Table') && aiResponseText.includes('io');
            return { pos: 'verb', isItalianVerb: isIt };
        }
        if (rawPos.includes('adjective') || rawPos.includes('aggettivo')) return { pos: 'adjective', isItalianVerb: false };
        if (rawPos.includes('adverb') || rawPos.includes('avverbio')) return { pos: 'adverb', isItalianVerb: false };
    }
    const hasConjugation = /\b(presente|passato prossimo|imperfetto|futuro)\b/i.test(aiResponseText) && /\b(io|tu|lui\/lei|noi|voi|loro)\b/i.test(aiResponseText);
    if (hasConjugation) return { pos: 'verb', isItalianVerb: true };
    const posPatterns = [{ pattern: /\b(verb|verbo)\b/i, pos: 'verb' }, { pattern: /\b(noun|sostantivo|nome)\b/i, pos: 'noun' }, { pattern: /\b(adjective|aggettivo)\b/i, pos: 'adjective' }, { pattern: /\b(adverb|avverbio)\b/i, pos: 'adverb' }];
    for (const { pattern, pos } of posPatterns) { if (pattern.test(aiResponseText)) return { pos, isItalianVerb: false }; }
    if (/(?:tion|sion|ment|ness|ity|ance|ence|er|or|ist|ism|dom)$/i.test(lowerWord)) return { pos: 'noun', isItalianVerb: false };
    if (/(?:ful|ous|ive|able|ible|al|ial|ent|ant|ic|ical|less)$/i.test(lowerWord)) return { pos: 'adjective', isItalianVerb: false };
    if (/(?:ly)$/i.test(lowerWord)) return { pos: 'adverb', isItalianVerb: false };
    if (/(?:ize|ise|ify|ate|en|ing|ed)$/i.test(lowerWord)) return { pos: 'verb', isItalianVerb: false };
    if (/(?:are|ere|ire|ato|uto|ito)$/i.test(lowerWord)) return { pos: 'verb', isItalianVerb: /(?:are|ere|ire)$/i.test(lowerWord) };
    return { pos: 'unknown', isItalianVerb: false };
}

function detectLanguage(aiResponseText) {
    if (!aiResponseText) return 'unknown';
    const structured = extractStructuredAiData(aiResponseText);
    if (structured?.detectedLanguage) {
        return String(structured.detectedLanguage).toLowerCase().trim();
    }
    const lowerAI = aiResponseText.toLowerCase();
    const langMatch = aiResponseText.match(/(?:1\.\s*\**Language Detection\**|Language)[^:]*:\s*([a-zA-Z\s]+)/i);
    if (langMatch && langMatch[1]) {
        return langMatch[1].toLowerCase().trim();
    }
    // Fallback logic
    if (/\b(italiano|italian|italiana)\b/i.test(lowerAI) && (lowerAI.includes('verbo') || lowerAI.includes('sostantivo') || lowerAI.includes('aggettivo'))) return 'italian';
    return 'english';
}

function extractPhoneticsFromAI(aiResponseText) {
    if (!aiResponseText) return '';
    const structured = extractStructuredAiData(aiResponseText);
    if (structured?.phonetics) {
        return String(structured.phonetics).trim();
    }
    const pattern = /(?:\*\*)?Phonetics(?: & Stress)?(?:\*\*)?[:\s]*(.+?)(?:\n|$)/i;
    const match = aiResponseText.match(pattern);
    return (match && match[1]) ? match[1].trim().replace(/\*\*/g, '').replace(/\*/g, '') : '';
}

function extractMeaningFromAI(aiResponseText) {
    if (!aiResponseText) return '';
    const structured = extractStructuredAiData(aiResponseText);
    if (structured?.meaningInContext) {
        return String(structured.meaningInContext).trim();
    }
    const patterns = [/(?:\*\*)?Meaning in Context(?:\*\*)?[:\s]*(.+?)(?:\n\n|\n(?:\d+\.|\*\*|#{2,}))/is, /(?:\*\*)?(?:The )?(?:specific )?meaning[^:]*(?:\*\*)?[:\s]*(.+?)(?:\n\n|\n(?:\d+\.|\*\*|#{2,}))/is, /(?:means?|refers? to|denotes?|signifies?)[:\s]+["']?([^"'\n.]+)/i];
    for (const pattern of patterns) {
        const match = aiResponseText.match(pattern);
        if (match && match[1]) return match[1].trim().replace(/\*\*/g, '').replace(/\*/g, '').replace(/^[-•]\s*/, '');
    }
    return '';
}

function extractConjugationFromAI(aiResponseText) {
    if (!aiResponseText) return null;

    const structured = extractStructuredAiData(aiResponseText);
    if (structured?.verbConjugation && Array.isArray(structured.verbConjugation.rows) && structured.verbConjugation.rows.length > 0) {
        const headers = Array.isArray(structured.verbConjugation.headers) ? structured.verbConjugation.headers : [];
        let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;">';
        if (headers.length > 0) {
            html += '<tr>';
            headers.forEach((header) => {
                html += `<th style="border:1px solid #808080;padding:3px 5px;font-weight:600;">${escHtml(String(header))}</th>`;
            });
            html += '</tr>';
        }
        structured.verbConjugation.rows.forEach((row) => {
            const cells = Array.isArray(row) ? row : [row];
            html += '<tr>';
            cells.forEach((cell) => {
                html += `<td style="border:1px solid #808080;padding:3px 5px;">${escHtml(String(cell))}</td>`;
            });
            html += '</tr>';
        });
        html += '</table>';
        return html;
    }

    const normalizedText = String(aiResponseText)
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<\/div\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\r/g, '');

    const tableMatches = normalizedText.match(/(?:^|\n)\|[^\n]*\|(?:\n\|[-:\s|]+\|)?(?:\n\|[^\n]*\|){1,12}/g) || [];

    // Prefer tables that look like conjugations while keeping a generic fallback for other languages.
    const prioritized = tableMatches.slice().sort((a, b) => {
        const score = (text) => {
            const lower = text.toLowerCase();
            let s = 0;
            if (/\b(tense|conjugation|presente|passato|imperfetto|futuro|past|present|future|indicativo|subjuntivo|subjonctif)\b/i.test(lower)) s += 3;
            if (/\b(io|tu|lui\/lei|noi|voi|loro|yo|t[uú]|[ée]l|nosotros|vosotros|ellos|je|tu|il\/elle|nous|vous|ils\/elles)\b/i.test(lower)) s += 2;
            const cols = (text.split('\n')[0].match(/\|/g) || []).length;
            if (cols >= 4) s += 1;
            return s;
        };
        return score(b) - score(a);
    });

    const topMatch = prioritized[0];
    const rows = topMatch ? topMatch.trim().split('\n').filter(r => r.trim().startsWith('|')) : [];
    if (rows.length >= 3) {
        let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;">';
        rows.forEach((row, idx) => {
            if (/^\|[\s-|]+\|$/.test(row.trim())) return;
            const cells = row.split('|').filter(c => c.trim() !== '');
            const tag = idx === 0 ? 'th' : 'td';
            const headerStyles = idx === 0 ? 'font-weight:600;' : '';
            html += '<tr>';
            cells.forEach(cell => { html += `<${tag} style="border:1px solid #808080;padding:3px 5px;${headerStyles}">${cell.trim()}</${tag}>`; });
            html += '</tr>';
        });
        return html + '</table>';
    }

    // Fallback for non-table conjugations: extract a compact conjugation block by keywords.
    const lines = normalizedText.split('\n').map(l => l.trim()).filter(Boolean);
    const startIdx = lines.findIndex(l => /\b(conjugation|verb forms?|forms?|presente|passato|imperfetto|futuro|past|present|future|indicativo|subjonctif|subjuntivo)\b/i.test(l));
    if (startIdx === -1) return null;

    const block = [];
    for (let i = startIdx; i < lines.length && block.length < 12; i += 1) {
        const line = lines[i];
        if (!line) break;
        if (block.length > 0 && /^\d+\./.test(line) && !/\b(io|tu|noi|voi|loro|yo|nosotros|vous|nous|je)\b/i.test(line)) break;
        if (/\b(visual query|cultural|alternative meanings|example sentences|language detection|part of speech)\b/i.test(line) && block.length > 1) break;
        if (/^[|\-: ]+$/.test(line)) continue;
        block.push(line.replace(/^[-*•]\s*/, ''));
    }

    if (block.length < 2) return null;
    return `<div style="font-size:0.92em;line-height:1.45;white-space:pre-line;">${escHtml(block.join('\n'))}</div>`;
}

function extractExampleSentences(aiResponseText, word, limit = 3) {
    if (!aiResponseText) return [];
    const structured = extractStructuredAiData(aiResponseText);
    if (structured?.exampleSentences) {
        return normalizeAiList(structured.exampleSentences).slice(0, limit);
    }
    const startPatterns = [
        /(?:6\.|Example Sentences|Esempi|Examples)\s*[:\s]*/i,
        /(?:\d+\.\s+)(?:Example|Esempio)\s*[:\s]*/i
    ];
    let sectionText = '';
    for (const pattern of startPatterns) {
        const match = aiResponseText.match(pattern);
        if (match) {
            const startIdx = match.index + match[0].length;
            const nextSectionMatch = aiResponseText.substring(startIdx).match(/\n(?:\d+\.|\*\*|#{1,3}|[A-V][a-z]+:)/);
            const endIdx = nextSectionMatch ? startIdx + nextSectionMatch.index : aiResponseText.length;
            sectionText = aiResponseText.substring(startIdx, endIdx);
            if (sectionText.trim().length > 10) break;
        }
    }
    const lines = (sectionText || aiResponseText).split('\n');
    const wordLower = word.toLowerCase();
    const examples = [];
    const seen = new Set();

    const pushExample = (value) => {
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        examples.push(normalized);
    };

    for (const line of lines) {
        let cleaned = line.trim().replace(/^[-•*+]\s*/, '').replace(/^\d+\.\s*/, '').replace(/^["']|["']$/g, '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
        cleaned = cleaned.replace(/^["']|["']$/g, '').trim();
        if (cleaned.length < 10 || cleaned.length > 500) continue;
        if (/^(Language|Part|Meaning|Context|Alternative|Nuance|Cultural|Visual|Note|Esempio|Example)/i.test(cleaned)) continue;
        if (cleaned.toLowerCase().includes(wordLower) || /[.!?]$/.test(cleaned)) {
            pushExample(cleaned);
        }
        if (examples.length >= limit) return examples;
    }

    if (sectionText && sectionText.trim().length > 10) {
        for (const line of lines) {
            const cleaned = line.trim().replace(/^[-•*+]\s*/, '').replace(/^["']|["']$/g, '').trim().replace(/^["']|["']$/g, '').trim();
            if (cleaned.length > 20 && cleaned.length < 500 && !/^(#|\|)/.test(cleaned)) {
                pushExample(cleaned);
            }
            if (examples.length >= limit) return examples;
        }
    }

    return examples.slice(0, limit);
}

function getPosAbbreviation(pos) {
    const map = { 'noun': 'n.', 'verb': 'v.', 'adjective': 'adj.', 'adverb': 'adv.', 'expression': 'expr.' };
    return map[pos] || '';
}

function maskWordInText(text, word) {
    if (!text || !word) return text;
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    return text.replace(regex, "the word");
}

function sanitizeFilename(name) {
    return String(name || 'word').replace(/[^a-z0-9._-]/gi, '_');
}

async function downsampleScreenshotDataUrl(dataUrl, scale = 0.5) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const targetW = Math.max(1, Math.floor((img.naturalWidth || img.width) * scale));
                const targetH = Math.max(1, Math.floor((img.naturalHeight || img.height) * scale));
                const canvas = document.createElement('canvas');
                canvas.width = targetW;
                canvas.height = targetH;
                const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
                if (!ctx) {
                    resolve(dataUrl);
                    return;
                }

                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'low';
                ctx.drawImage(img, 0, 0, targetW, targetH);
                resolve(canvas.toDataURL('image/jpeg', 0.82));
            } catch {
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

async function captureScreenshot() {
    // Prefer direct capture from side panel; fallback to background if needed.
    const directCapture = () => new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            const tab = tabs && tabs[0];
            const windowId = tab?.windowId;
            if (typeof windowId !== 'number') {
                reject(new Error('No active tab window found'));
                return;
            }

            chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }
                if (!dataUrl) {
                    reject(new Error('Screenshot capture returned empty data'));
                    return;
                }
                resolve(dataUrl);
            });
        });
    });

    const bgCapture = () => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response && response.success && response.dataUrl) {
                resolve(response.dataUrl);
                return;
            }
            reject(new Error(response?.error || 'Screenshot capture failed'));
        });
    });

    let dataUrl;
    try {
        dataUrl = await directCapture();
    } catch (directError) {
        dataUrl = await bgCapture().catch((bgError) => {
            const directMessage = directError?.message || 'Direct capture failed';
            const bgMessage = bgError?.message || 'Background capture failed';
            throw new Error(`${directMessage}; ${bgMessage}`);
        });
    }

    return downsampleScreenshotDataUrl(dataUrl, 0.5);
}

async function storeScreenshotInAnkiMedia(dataUrl, word) {
    if (!dataUrl) return '';

    const safeWord = sanitizeFilename(word);
    const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const filename = `sidepanel_${safeWord}_${Date.now()}.${extension}`;
    const base64Data = dataUrl.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

    const response = await fetch('http://localhost:8765', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'storeMediaFile',
            version: 6,
            params: {
                filename,
                data: base64Data
            }
        })
    });

    const result = await response.json();
    if (result.error) {
        throw new Error(result.error);
    }

    return filename;
}

function extractContextSentence(word, context) {
    if (!context || !word) return { original: '' };
    let cleaned = context.replace(/>>/g, ' ').replace(/\s+/g, ' ').trim();
    const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
    const wordLower = word.toLowerCase();
    let best = '';
    for (const s of sentences) { if (s.toLowerCase().includes(wordLower)) { best = s.trim(); break; } }
    if (!best) best = cleaned.length > 150 ? cleaned.substring(0, 150) + '...' : cleaned;
    return { original: best };
}

    // AI button handler
    const aiBtn = document.getElementById('get-ai-btn');
    if (aiBtn) {
        aiBtn.addEventListener('click', async () => {
            const responseArea = document.getElementById('ai-response-area');
            aiBtn.disabled = true;
            aiBtn.textContent = '⏳ Loading...';

            try {
                // Determine which word to lookup
                const wordTitle = document.querySelector('.word-title');
                const lookupWord = wordTitle.getAttribute('data-active-word') || word;
                const lookupContext = wordCount > 1 ? word : context;

                // Request AI definition from the active tab's content script
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                chrome.tabs.sendMessage(tab.id, {
                    action: 'getAIDefinition',
                    word: lookupWord,
                    context: lookupContext
                }, (response) => {
                    if (chrome.runtime.lastError || !response || !response.definition) {
                        // Tab has no content script (e.g. PDF viewer) — ask background directly
                        chrome.runtime.sendMessage({
                            action: 'getAIDefinitionDirect',
                            word: lookupWord,
                            context: lookupContext
                        }, (bgResponse) => {
                            if (bgResponse && bgResponse.definition) {
                                responseArea.style.display = 'block';
                                renderAiDefinition(responseArea, bgResponse.definition);
                                currentAiResponseRaw = bgResponse.rawText || '';
                                aiBtn.style.display = 'none';
                            } else {
                                responseArea.style.display = 'block';
                                responseArea.textContent = 'Could not get AI definition. Check your AI settings.';
                                aiBtn.disabled = false;
                                aiBtn.textContent = '🤖 Retry';
                            }
                        });
                    } else {
                        responseArea.style.display = 'block';
                        renderAiDefinition(responseArea, response.definition);
                        currentAiResponseRaw = response.rawText || '';
                        aiBtn.style.display = 'none';
                    }
                });
            } catch (error) {
                responseArea.style.display = 'block';
                responseArea.textContent = `Error: ${error.message}`;
                aiBtn.disabled = false;
                aiBtn.textContent = '🤖 Retry';
            }
        });
    }

    // Anki button handler
    const ankiBtn = document.getElementById('anki-btn');
    if (ankiBtn) {
        ankiBtn.addEventListener('click', async () => {
            const statusText = document.getElementById('status-text');
            ankiBtn.disabled = true;
            statusText.textContent = 'Sending to Anki...';
            statusText.style.color = '#9ca3af';

            try {
                const wordTitle = document.querySelector('.word-title');
                const word = wordTitle.getAttribute('data-active-word') || wordTitle.textContent;
                const responseArea = document.getElementById('ai-response-area');
                const fallbackAiText = responseArea ? responseArea.innerText : '';
                const rawAiText = (currentAiResponseRaw || fallbackAiText || '').trim();
                
    const language = detectLanguage(rawAiText);
    const posInfo = detectPartOfSpeech(word, rawAiText);
    const phonetics = extractPhoneticsFromAI(rawAiText);
    const meaning = extractMeaningFromAI(rawAiText, word);
    const conjugation = extractConjugationFromAI(rawAiText);
    const exampleSentences = extractExampleSentences(rawAiText, word, 3);
    const { original: contextSentence } = extractContextSentence(word, context);

    const posAbbr = getPosAbbreviation(posInfo.pos);
    const posTag = posAbbr ? ` <i style="opacity:0.75;">${posAbbr}</i>` : '';

    let targetDeck = ankiDeck;
    if (languageMappings && languageMappings.length > 0) {
        const matchedMapping = languageMappings.find(m => language.includes(m.language.toLowerCase()));
        if (matchedMapping && matchedMapping.deck) {
            targetDeck = matchedMapping.deck;
        }
    } else if (language === 'italian' && ankiDeckItalian) {
        // Fallback for older configs
        targetDeck = ankiDeckItalian;
    }

                const isCloze = ankiNoteType.toLowerCase().includes('cloze');
                let fields = {};
                const accentGreen = '#2f8f46';
                const mediaField = isCloze ? 'Extra' : 'Back';
                
                if (isCloze) {
                    const clozeSentence = contextSentence ? contextSentence.replace(
                        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
                        `{{c1::${word}}}`
                    ) : `{{c1::${word}}}`;
                    
                    let backExtra = '';
                    const phoneticsTag = phonetics ? ` <span style="font-family: Arial, sans-serif; font-weight: normal; color:${accentGreen}; margin-left: 8px;">${phonetics}</span>` : '';
                    backExtra += `<div style="font-size:1.2em;margin-bottom:8px;"><b style="color:${accentGreen};">${word}</b>${phoneticsTag}${posTag}</div>`;

                    if (meaning && meaning !== 'Definition not found.') {
                        backExtra += `<div style="margin-bottom:10px;"><b>Meaning:</b> ${meaning}</div>`;
                    }

                    if (exampleSentences.length > 0) {
                        const examplesHtml = exampleSentences
                            .map((sentence) => `<div style="margin-top:4px;">- ${sentence}</div>`)
                            .join('');
                        backExtra += `<div style="margin-bottom:8px; font-style: italic; opacity:0.85;"><b>Examples:</b>${examplesHtml}</div>`;
                    }

                    if (conjugation) {
                        backExtra += `<div style="margin-top:10px; border-top: 1px solid #808080; padding-top:8px;"><b>Conjugation</b>${conjugation}</div>`;
                    }

                    fields = {
                        Text: `<div style="font-size:1.15em; line-height:1.4;">${clozeSentence}</div>`,
                        Extra: backExtra
                    };
                } else {
                    const blankedWord = '_______';
                    let manualBlankedSentence = contextSentence ? contextSentence.replace(
                      new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
                      blankedWord
                    ) : blankedWord;

                    let front = `<div style="font-size:1.1em;line-height:1.5;margin-bottom:10px;">${manualBlankedSentence}</div>`;
                    if (posAbbr || meaning) {
                                            front += `<div style="font-size:0.85em;margin-top:10px;opacity:0.75;"><b>${posTag}</b> ${maskWordInText(meaning, word) || ''}</div>`;
                    }

                    const phoneticsText = phonetics ? ` <span style="color:${accentGreen};">${phonetics}</span>` : '';
                                        let backSide = `<div style="font-size:1.3em;margin-bottom:12px;"><b style="color:${accentGreen};">${word}</b>${phoneticsText}</div>`;
                    if (meaning) backSide += `<div style="margin-bottom:12px;">${meaning}</div>`;
                    if (exampleSentences.length > 0) {
                        const examplesHtml = exampleSentences
                            .map((sentence) => `<div style="margin-top:4px;">- ${sentence}</div>`)
                            .join('');
                        backSide += `<div style="margin-bottom:12px; font-style: italic; opacity:0.85;"><b>Examples:</b>${examplesHtml}</div>`;
                    }
                                        if (contextSentence) backSide += `<div style="font-size:0.9em;opacity:0.8;"><i>${contextSentence}</i></div>`;
                                        if (conjugation) backSide += `<div style="margin-top:10px; border-top: 1px solid #808080; padding-top:8px;"><b>Conjugation</b>${conjugation}</div>`;

                    fields = {
                        Front: front,
                        Back: backSide
                    };
                }

                // Try to attach screenshot; if capture fails, proceed with note creation.
                let screenshotFilename = '';
                try {
                    statusText.textContent = 'Capturing screenshot...';
                    const screenshot = await captureScreenshot();
                    if (screenshot) {
                        statusText.textContent = 'Uploading screenshot...';
                        screenshotFilename = await storeScreenshotInAnkiMedia(screenshot, word);
                    }
                } catch (captureError) {
                    console.warn('[SidePanel] Screenshot capture failed, continuing without screenshot:', captureError?.message || captureError);
                }

                if (screenshotFilename) {
                    const imageTag = `<div style="margin-top:10px;"><img src="${screenshotFilename}" style="max-width:100%;height:auto;border-radius:6px;" /></div>`;
                    if (typeof fields[mediaField] === 'string') {
                        fields[mediaField] += imageTag;
                    } else if (typeof fields.Back === 'string') {
                        fields.Back += imageTag;
                    } else if (typeof fields.Extra === 'string') {
                        fields.Extra += imageTag;
                    } else {
                        const firstFieldKey = Object.keys(fields)[0];
                        if (firstFieldKey && typeof fields[firstFieldKey] === 'string') {
                            fields[firstFieldKey] += imageTag;
                        }
                    }
                }

                statusText.textContent = 'Sending to Anki...';

                const response = await fetch('http://localhost:8765', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'addNote',
                        version: 6,
                        params: {
                            note: {
                                deckName: targetDeck,
                                modelName: ankiNoteType,
                                fields: fields,
                                options: { allowDuplicate: false, duplicateScope: 'deck' },
                                tags: ['interactive-subtitles', 'pdf']
                            }
                        }
                    })
                });

                const result = await response.json();
                if (result.error) throw new Error(result.error);

                statusText.textContent = '✅ Added to Anki!';
                statusText.style.color = '#34d399';
                ankiBtn.textContent = '✅ Added!';
                ankiBtn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
            } catch (error) {
                const errorMsg = error.message.includes('Extension context invalidated')
                    ? 'Extension was reloaded. Refresh the page, reopen the side panel, then try again.'
                    : error.message.includes('Failed to fetch')
                    ? 'Anki not running or AnkiConnect not installed'
                    : error.message;
                statusText.textContent = `❌ ${errorMsg}`;
                statusText.style.color = '#f87171';
                ankiBtn.disabled = false;
            }
        });
    }

    // Update history display
    updateHistory();
}

function updateHistory() {
    const historySection = document.getElementById('history-section');
    const historyList = document.getElementById('history-list');

    if (lookupHistory.length > 1) {
        historySection.style.display = 'block';
        historyList.innerHTML = lookupHistory.slice(1, 6).map(item => `
      <div class="history-item" data-word="${item.word}">
        <span class="word">${item.word}</span>
        <span class="time">${item.time.toLocaleTimeString()}</span>
      </div>
    `).join('');
    }
}
