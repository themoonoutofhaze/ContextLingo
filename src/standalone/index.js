function showStandaloneError(word, context, errorMessage) {
  const safeWord = String(word || '').trim();
  const safeContext = String(context || '').trim();
  const details = errorMessage ? String(errorMessage) : 'Unknown error';

  document.body.style.backgroundColor = 'var(--lookup-bg, #0f1115)';
  document.body.style.color = '#f3f4f6';
  document.body.style.margin = '0';
  document.body.style.fontFamily = '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif';

  document.body.innerHTML = `
    <div style="padding:20px; max-width:680px; margin:0 auto; line-height:1.45;">
      <h2 style="margin:0 0 10px 0; font-size:18px;">Lookup window could not initialize</h2>
      <p style="margin:0 0 14px 0; color:#d1d5db;">This can happen on some Edge PDF/file contexts. The window opened correctly, but the lookup UI failed to mount.</p>
      <div style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:12px; margin-bottom:12px;">
        <div style="font-size:12px; color:#9ca3af; margin-bottom:4px;">Selected text</div>
        <div style="font-size:14px;">${safeWord || '(empty)'}</div>
      </div>
      <div style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:12px; margin-bottom:12px;">
        <div style="font-size:12px; color:#9ca3af; margin-bottom:4px;">Context</div>
        <div style="font-size:14px;">${safeContext || '(empty)'}</div>
      </div>
      <details style="font-size:12px; color:#9ca3af;">
        <summary style="cursor:pointer;">Technical details</summary>
        <pre style="white-space:pre-wrap; margin-top:8px; color:#e5e7eb;">${details}</pre>
      </details>
    </div>
  `;
}

function getContentScriptModuleUrl() {
  try {
    const manifest = chrome.runtime.getManifest();
    const scripts = manifest?.content_scripts || [];
    for (const entry of scripts) {
      const jsFiles = entry?.js || [];
      if (Array.isArray(jsFiles) && jsFiles.length > 0) {
        return chrome.runtime.getURL(jsFiles[0]);
      }
    }
  } catch {
    // Fall through to default path below.
  }

  // Dev/source fallback.
  return chrome.runtime.getURL('src/content/index.js');
}

async function init() {
  let word = '', context = '';

  const params = new URLSearchParams(location.search);
  const queryWord = params.get('word') || '';
  const queryContext = params.get('context') || queryWord;

  if (queryWord) {
    word = queryWord;
    context = queryContext;
  }

  try {
    if (!word) {
      const stored = await new Promise(res => chrome.storage.session.get('translateLookup', res));
      const lookup = stored && stored.translateLookup;
      if (lookup && lookup.word && (Date.now() - (lookup.ts || 0) < 15000)) {
        word = lookup.word;
        context = lookup.context || lookup.word;
      }
    }

    // Best-effort cleanup to avoid stale handoff data in later windows.
    chrome.storage.session.remove('translateLookup');
  } catch {
    // Ignore session cleanup errors in standalone fallback mode.
  }

  if (word) {
    // Modify body to look nice behind the modal
    document.body.style.backgroundColor = 'var(--lookup-bg, #0f1115)';
    document.body.style.margin = '0';
    document.body.style.minHeight = '100vh';
    document.body.style.overflow = 'hidden';

    document.body.innerHTML = '<div style="color:#f3f4f6; padding:20px; text-align:center;">Opening lookup...</div>';

    try {
      // Resolve the real built path from manifest (hashed in production builds).
      const contentModuleUrl = getContentScriptModuleUrl();
      await import(contentModuleUrl);
    } catch (error) {
      showStandaloneError(word, context, error?.stack || error?.message || String(error));
      return;
    }

    const checkAndShow = () => {
      // Wait for content script to mount the global window.interactiveSubtitles
      if (window.interactiveSubtitles) {
        // Force the display mode to overlay since it's inside a dedicated window
        window.interactiveSubtitles.displayMode = 'overlay';

        window.interactiveSubtitles.showDefinitionModal(word, context, null);

        // Hide the close button since the user will just close the system window, 
        // OR override its behavior to close the window.
        const closeBtn = document.querySelector('.close-btn');
        if (closeBtn) {
            closeBtn.onclick = () => window.close();
            // Optional: You could hide it entirely with `closeBtn.style.display = 'none';` 
            // but closing the window is more intuitive.
        }

        // Check if the modal gets removed (e.g. by pressing Escape or clicking backdrop)
        // If it gets removed, close the window.
        const observer = new MutationObserver(() => {
            if (!document.getElementById('definition-modal')) {
                window.close();
            }
        });
        observer.observe(document.body, { childList: true });

      } else {
        setTimeout(checkAndShow, 100);
      }
    };
    checkAndShow();
  } else {
    document.body.innerHTML = '<div style="color:white; padding:20px; text-align:center;">No word provided (Edge PDF may not expose selected text to the extension)</div>';
  }
}

init();
