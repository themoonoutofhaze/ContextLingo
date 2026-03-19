// Enhanced format free API data with clear source tracking
function formatFreeApiData(data, style) {
    console.log(`🤖 FREE API FORMATTER: Formatting data for style "${style}"`);

    const meanings = data.meanings || [];
    const phonetics = data.phonetics?.find(p => p.text) || {};

    const definitions = [];
    meanings.slice(0, 2).forEach((meaning) => {
        meaning.definitions.slice(0, 2).forEach((def) => {
            definitions.push({
                definition: def.definition,
                example: def.example,
                partOfSpeech: meaning.partOfSpeech,
                source: 'Free Dictionary API'
            });
        });
    });

    const result = {
        word: data.word,
        source: 'Cambridge Dictionary (Free API Fallback)',
        pronunciation: phonetics.text,
        audio: phonetics.audio,
        definitions: definitions,
        style: 'cambridge',
        method: 'Free Dictionary API',
        rawDataLength: JSON.stringify(data).length,
        apiData: data 
    };

    return result;
}

// Enhanced free API with clear method tracking
async function fetchFreeApiData(word, style = 'default') {
    try {
        const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);

        if (response.ok) {
            const data = await response.json();
            if (data && data.length > 0) {
                const result = formatFreeApiData(data[0], style);
                return result;
            }
        }
        throw new Error('Free API failed');
    } catch (error) {
        throw new Error(`All dictionary sources failed: ${error.message}`);
    }
}

// Fetch Cambridge Dictionary data with RAW HTML return
async function fetchCambridgeData(word) {
    try {
        const directUrl = `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}`;

        const response = await fetch(directUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            }
        });

        if (response.ok) {
            const html = await response.text();
            return {
                word: word,
                source: 'Cambridge Dictionary (Direct)',
                method: 'Direct Website Scraping',
                rawHtml: html,
                rawDataLength: html.length,
                url: directUrl,
                status: response.status
            };
        } else {
            throw new Error(`Cambridge request failed: ${response.status}`);
        }
    } catch {
        try {
            const directUrl = `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}`;
            const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(directUrl)}`;
            const proxyResponse = await fetch(proxyUrl);

            if (proxyResponse.ok) {
                const data = await proxyResponse.json();
                if (data.contents) {
                    return {
                        word: word,
                        source: 'Cambridge Dictionary (Proxy)',
                        method: 'Proxy Service Scraping',
                        rawHtml: data.contents,
                        rawDataLength: data.contents.length,
                        url: proxyUrl,
                        originalUrl: directUrl
                    };
                }
            }
        } catch (proxyError) {
            console.log('Proxy error:', proxyError.message);
        }

        return await fetchFreeApiData(word, 'cambridge-style');
    }
}

// Function to fetch dictionary data
export const fetchDictionaryData = async (word, source) => {
    if (source === 'cambridge') {
        return await fetchCambridgeData(word);
    } else {
        throw new Error('Only Cambridge dictionary is supported');
    }
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function parseErrorPayload(response) {
    const text = await response.text();
    if (!text) {
        return { message: `HTTP ${response.status}`, requestId: '' };
    }

    try {
        const parsed = JSON.parse(text);
        return {
            message: parsed?.message || `HTTP ${response.status}`,
            requestId: parsed?.request_id || parsed?.requestId || ''
        };
    } catch {
        return { message: text, requestId: '' };
    }
}

async function postJsonWithRetry(url, options, maxAttempts = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch(url, options);

            if (response.ok) {
                return await response.json();
            }

            const { message, requestId } = await parseErrorPayload(response);
            const isRetryable = RETRYABLE_STATUS.has(response.status);
            const details = requestId
                ? `${message} (request_id: ${requestId})`
                : message;

            if (isRetryable && attempt < maxAttempts) {
                const backoffMs = 400 * Math.pow(2, attempt - 1);
                console.warn(`[AI] Upstream ${response.status}; retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`);
                await sleep(backoffMs);
                continue;
            }

            throw new Error(`${response.status} - ${details}`);
        } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
                const backoffMs = 400 * Math.pow(2, attempt - 1);
                console.warn(`[AI] Request failed; retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`, error?.message || error);
                await sleep(backoffMs);
                continue;
            }
        }
    }

    throw lastError || new Error('Unknown upstream error');
}

export const handleGetAIDefinitionDirect = (request, sendResponse) => {
    const { word, context } = request;

    chrome.storage.sync.get(['aiProvider', 'customLlmUrl', 'customLlmApiKey', 'customLlmModel', 'mistralApiKey', 'languageMappings', 'aiResponseLanguage'], (settings) => {
        const provider = settings.aiProvider || 'mistral';
        let apiUrl, apiKey, model;

        if (provider === 'custom') {
            apiUrl = settings.customLlmUrl;
            apiKey = settings.customLlmApiKey;
            model = settings.customLlmModel;
        } else if (provider === 'openai') {
            // New Supported Provider
            apiUrl = 'https://api.openai.com/v1/chat/completions';
            apiKey = settings.customLlmApiKey; // We'll map this in UI later or add an openai key
            model = settings.customLlmModel || 'gpt-4o-mini';
        } else if (provider === 'ollama') {
            // New Supported Provider (Local)
            apiUrl = settings.customLlmUrl || 'http://localhost:11434/api/generate';
            apiKey = ''; // No API key typically
            model = settings.customLlmModel || 'llama3';
        } else {
            // Mistral Default
            apiUrl = 'https://api.mistral.ai/v1/chat/completions';
            apiKey = settings.mistralApiKey;
            model = 'mistral-small-latest';
        }

        // Format configured languages for AI instruction
        let configuredLanguagesStr = 'Any language';
        if (settings.languageMappings && settings.languageMappings.length > 0) {
            configuredLanguagesStr = settings.languageMappings.map(m => m.language).join(', ');
        }
                const responseLanguage = (settings.aiResponseLanguage || 'English').trim() || 'English';

        const prompt = `I'm reading a PDF or document and need help understanding a word in context.

Word to analyze: "${word}"

Extended context: "${context || word}"

Return ONLY valid JSON wrapped between these markers:
<CTXLINGO_JSON_START>
{...}
<CTXLINGO_JSON_END>

JSON schema:
{
    "analysisLanguage": "${responseLanguage}",
    "detectedLanguage": "language name",
    "partOfSpeech": "noun|verb|adjective|adverb|pronoun|preposition|conjunction|interjection|expression",
    "phonetics": "IPA or empty string",
    "meaningInContext": "string",
    "alternativeMeanings": ["string", "..."],
    "exampleSentences": ["string", "string", "string"],
    "culturalNuances": "string",
    "isVisual": true,
    "visualQuery": "2-3 English keywords",
    "verbConjugation": {
        "headers": ["Tense", "io", "tu", "lui/lei", "noi", "voi", "loro"],
        "rows": [["Presente", "...", "...", "...", "...", "...", "..."]]
    }
}

Rules:
- Write "meaningInContext", "alternativeMeanings", and "culturalNuances" in ${responseLanguage}.
- Keep "detectedLanguage" and "partOfSpeech" in English.
- Write "exampleSentences" in the detectedLanguage (language of the analyzed word), not in ${responseLanguage}.
- If language is one of [${configuredLanguagesStr}], set "detectedLanguage" exactly to that configured name.
- If not an Italian verb, set "verbConjugation" to null.
- Output no markdown and no extra text outside the markers.`;

        const requestBody = provider === 'ollama' ? {
            model,
            prompt,
            stream: false
        } : {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 600
        };

        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        if (!apiUrl) {
            sendResponse({ definition: 'AI error: API URL is not configured.', rawText: '' });
            return;
        }

        postJsonWithRetry(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        })
            .then(data => {
                let text = '';
                if (provider === 'ollama') {
                    text = data.response || '';
                } else {
                    text = data.choices?.[0]?.message?.content || '';
                }

                if (!text) {
                    throw new Error('Empty response from AI provider. Check model/provider settings.');
                }

                sendResponse({
                    definition: text,
                    rawText: text
                });
            })
            .catch(err => {
                console.error('[BG] getAIDefinitionDirect error:', err);
                sendResponse({ definition: `AI error: ${err.message}`, rawText: '' });
            });
    });
};
