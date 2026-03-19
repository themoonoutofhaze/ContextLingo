export const handleAnkiRequest = async (request, sendResponse) => {
    try {
        const response = await fetch('http://localhost:8765', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.payload)
        });
        const data = await response.json();
        if (data.error) {
            sendResponse({ success: false, error: data.error });
        } else {
            sendResponse({ success: true, result: data.result });
        }
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
};

export const handleTestAnkiConnection = async (sendResponse) => {
    try {
        const response = await fetch('http://localhost:8765', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'version', version: 6 })
        });
        const data = await response.json();
        if (data.result) {
            sendResponse({ success: true, version: data.result });
        } else {
            sendResponse({ success: false, error: data.error || 'Unknown error' });
        }
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
};
