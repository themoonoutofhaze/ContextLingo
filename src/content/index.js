// Content script for Interactive Subtitle Dictionary - FIXED Amazon Prime Support
console.log('Interactive Subtitles content script loading...');

class InteractiveSubtitles {
  constructor() {
    this.enabled = true;
    this.darkMode = false;
    this.currentSubtitle = '';
    this.previousSubtitles = [];
    this.nextSubtitle = '';
    this.subtitleContainer = null;
    this.originalSubtitleElement = null;
    this.platform = this.detectPlatform();
    this.monitoringInterval = null;
    this.lastSubtitleCheck = '';
    this.subtitleHistory = [];
    this.lastSubtitleTimestamp = 0;
    this.recentSeekTimestamp = 0;
    this.subtitleClearTimeout = null;
    this.staticContentTracker = new Map();
    this.staticContentThreshold = 3000; // Increased threshold
    this.lastNonStaticSubtitle = '';
    this.bannedStaticContent = new Set();
    this.lastVideoTime = 0;
    this.isVideoPaused = false;
    this.staticContentPatterns = [
      /^[A-Z\s]+$/,
      /episode \d+/i,
      /season \d+/i,
      /stagione \d+/i,
      /ep\.\s*\d+/i,
      /chapter \d+/i,
      /part \d+/i,
      /^[\w\s]+\s*-\s*[\w\s]+$/,
      /^\d{4}$/,
      /^S\d+E\d+/i,
      /stagione.*ep\./i,
    ];
    this.aiResponseLanguage = 'English';

    // Load saved settings and then initialize
    this.loadSettings().then(() => {
      console.log('Settings loaded, enabled:', this.enabled);
      if (this.enabled) {
        this.init();
      } else {
        console.log('Extension disabled for this site, skipping initialization.');
      }
    });
  }

  init() {
    this.createInteractiveContainer();
    this.setupContextMenuListener();
    this.setupArticleSelectionMode();
    this.startSubtitleMonitoring();
    this.startPauseDetection();
    this.setupMessageListener();

    if (this.platform === 'amazon') {
      this.setupAmazonPrimeEnhancements();
      this.setupAmazonVideoStateMonitoring();
    }
  }

  detectPlatform() {
    const host = window.location.hostname;
    if (host.includes('youtube.com')) return 'youtube';
    if (host.includes('netflix.com')) return 'netflix';
    if (host.includes('amazon.') || host.includes('primevideo.')) return 'amazon';
    return 'unknown';
  }

  isPdfContext() {
    const href = (window.location.href || '').toLowerCase();
    const contentType = (document.contentType || '').toLowerCase();
    return contentType.includes('pdf')
      || href.includes('.pdf')
      || Boolean(document.querySelector('embed[type="application/pdf"], .pdfViewer, #viewer.pdfViewer'));
  }

  isVideoContext() {
    if (this.platform === 'youtube' || this.platform === 'netflix' || this.platform === 'amazon') {
      return true;
    }
    return Boolean(document.querySelector('video'));
  }

  getDefaultScreenshotEnabled() {
    if (this.isPdfContext()) return false;
    return this.isVideoContext();
  }

  setupContextMenuListener() {
    document.addEventListener('contextmenu', (e) => {
      const eventTarget = e.target instanceof window.Element ? e.target : e.target?.parentElement;
      if (!eventTarget) return;

      // Deep search for the real selection
      let deepestSel = window.getSelection();
      let maxDepth = 0;

      function findDeepSelection(root, depth) {
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let i = 0; i < nodes.length; i++) {
          let node = nodes[i];
          if (node.shadowRoot) {
            let sSel = node.shadowRoot.getSelection ? node.shadowRoot.getSelection() : null;
            if (sSel && sSel.rangeCount > 0 && sSel.toString().trim() !== '') {
              if (depth > maxDepth) {
                deepestSel = sSel;
                maxDepth = depth;
              }
            }
            findDeepSelection(node.shadowRoot, depth + 1);
          }
        }
      }
      findDeepSelection(document, 1);

      if (deepestSel && deepestSel.rangeCount > 0) {
        const text = deepestSel.toString().trim();
        if (text) {
          const BLOCK_TAGS = new Set(['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT']);
          let node = deepestSel.anchorNode;
          if (node && node.nodeType === Node.TEXT_NODE) {
            node = node.parentNode;
          }
          let candidate = node;
          let context = '';
          while (candidate && candidate !== document.body && candidate !== document.documentElement) {
            if (candidate.tagName && BLOCK_TAGS.has(candidate.tagName.toUpperCase())) {
              context = (candidate.innerText || candidate.textContent || '').trim();
              if (context.length >= 40) {
                break;
              }
            }
            if (candidate.parentNode instanceof ShadowRoot) {
              candidate = candidate.parentNode.host;
            } else {
              candidate = candidate.parentElement;
            }
          }
          if (!context && candidate && candidate !== document.documentElement) {
            context = (candidate.innerText || candidate.textContent || '').trim();
          }
          this.lastContextMenuContext = { word: text, context: context };
          console.log('[CONTEXT] Captured via right-click for word:', text);
        }
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ARTICLE / PDF TEXT-SELECTION LOOKUP
  // ─────────────────────────────────────────────────────────────────────────
  setupArticleSelectionMode() {
    // Flow:
    //  1. User selects ANY text on the page (sentence or phrase).
    //  2. Extension UI opens immediately, showing that text as the context sentence.
    //  3. User selects word(s) from within the UI's interactive sentence area.
    //  4. Lookup fires automatically across AI, Merriam-Webster, Wikipedia, etc.

    const extractContextFromSelection = (selection, selectedText) => {
      let context = '';
      try {
        const range = selection.getRangeAt(0);
        let node = range.startContainer;
        if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
        const BLOCK_TAGS = new Set(['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE',
          'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT', 'SPAN']);
        let el = node;
        while (el && el !== document.body) {
          if (el.tagName && BLOCK_TAGS.has(el.tagName.toUpperCase())) {
            const text = (el.innerText || el.textContent || '').trim();
            if (text.length >= 20) {
              context = text;
              break;
            }
          }
          el = el.parentElement;
        }
        if (!context) context = selectedText;
        if (context.length > 800) {
          const idx = context.toLowerCase().indexOf(selectedText.toLowerCase());
          if (idx !== -1) {
            const half = 400;
            const start = Math.max(0, idx - half);
            const end = Math.min(context.length, idx + selectedText.length + half);
            context = context.slice(start, end).trim();
          } else {
            context = context.slice(0, 800);
          }
        }
      } catch {
        context = selectedText;
      }
      return context;
    };

    // Prevent duplicate fires from rapid mouseup events
    let _lastOpenTs = 0;

    document.addEventListener('mouseup', (e) => {
      const eventTarget = e.target instanceof window.Element ? e.target : e.target?.parentElement;
      if (!eventTarget) return;

      // Ignore clicks inside our own UI
      if (
        eventTarget.closest('.definition-modal') ||
        eventTarget.closest('#interactive-subtitle-container') ||
        eventTarget.closest('.article-selection-hint')
      ) {
        return;
      }

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const selectedText = selection.toString().trim();
      // Need at least 2 chars to trigger (avoids accidental single-char taps)
      if (selectedText.length < 2) return;

      // Debounce: ignore if we just opened within 300 ms
      const now = Date.now();
      if (now - _lastOpenTs < 300) return;
      _lastOpenTs = now;

      // Store the context silently so the context menu handler can use it later if needed.
      // (The actual UI opening is now only triggered via the context menu).
      this._lastContext = extractContextFromSelection(selection, selectedText);
      console.log('[ArticleMode] Selection made, ready for right-click context menu:', this._lastContext.substring(0, 80));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('definition-modal');
        if (modal) modal.remove();
      }
    });

    console.log('[ArticleMode] Single-stage article/PDF selection mode initialised.');
  }

  loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['displayMode', 'ankiDeck', 'ankiNoteType', 'disabledSites', 'enabled', 'darkMode', 'aiProvider', 'customLlmUrl', 'customLlmApiKey', 'customLlmModel', 'mistralApiKey', 'languageMappings', 'ankiDeckItalian', 'aiResponseLanguage'], (result) => {
        if (result.displayMode) this.displayMode = result.displayMode;
        if (result.ankiDeck) {
          this.ankiDeck = result.ankiDeck === 'Default' ? 'English' : result.ankiDeck;
        }
        if (typeof result.enabled === 'boolean') this.enabled = result.enabled;
        if (typeof result.darkMode === 'boolean') this.darkMode = result.darkMode;
        
        if (result.languageMappings && Array.isArray(result.languageMappings)) {
            this.languageMappings = result.languageMappings;
        } else if (result.ankiDeckItalian) {
            this.languageMappings = [{ language: 'Italian', deck: result.ankiDeckItalian }];
        } else {
            this.languageMappings = [];
        }
        if (result.ankiNoteType) this.ankiNoteType = result.ankiNoteType;
        if (result.aiProvider) this.aiProvider = result.aiProvider;
        if (result.customLlmUrl) this.customLlmUrl = result.customLlmUrl;
        if (result.customLlmApiKey) this.customLlmApiKey = result.customLlmApiKey;
        if (result.customLlmModel) this.customLlmModel = result.customLlmModel;
        // Google image API settings temporarily disabled.
        // if (result.googleApiKey) this.googleApiKey = result.googleApiKey;
        // if (result.googleSearchEngineId) this.googleSearchEngineId = result.googleSearchEngineId;
        if (result.mistralApiKey) this.mistralApiKey = result.mistralApiKey;
        if (result.aiResponseLanguage) this.aiResponseLanguage = result.aiResponseLanguage;

        // Check if current site is disabled
        const currentHost = window.location.hostname.toLowerCase();
        
        // Default disabled sites (sensitive ones)
        const defaultDisabled = [
          'anagrafenazionale.interno.it',
          'servizi.torinofacile.it',
          'poste.it',
          'idp.spid.gov.it',
          'cieid.interno.gov.it'
        ];

        if (!this.enabled) {
          console.log('Extension globally disabled in settings.');
        } else if (defaultDisabled.some(site => currentHost.includes(site))) {
          this.enabled = false;
          console.log('Extension auto-disabled for sensitive site:', currentHost);
        } else if (result.disabledSites) {
          const disabledList = result.disabledSites.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
          if (disabledList.some(site => currentHost.includes(site))) {
            this.enabled = false;
            console.log('Extension disabled for this site by user:', currentHost);
          }
        }
        
        console.log('Settings loaded:', { displayMode: this.displayMode, enabled: this.enabled });
        resolve();
      });
    });
  }

  createInteractiveContainer() {
    const existingContainer = document.getElementById('interactive-subtitle-container');
    if (existingContainer) {
      existingContainer.remove();
    }

    this.subtitleContainer = document.createElement('div');
    this.subtitleContainer.id = 'interactive-subtitle-container';

    // Add key listeners for selection mode
    // Unified mouseup handler for both clicks and selections
    this.subtitleContainer.addEventListener('mouseup', (e) => {
      this.handleSubtitleMouseUp(e);
    });

    // Add key listeners for legacy selection mode (Control key) failure fallback
    // Remove previous listeners to prevent duplicates on re-init
    if (this._keydownHandler) document.removeEventListener('keydown', this._keydownHandler);
    if (this._keyupHandler) document.removeEventListener('keyup', this._keyupHandler);
    if (this._blurHandler) window.removeEventListener('blur', this._blurHandler);

    this._keydownHandler = (e) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        if (!this.isControlHeld) {
          console.log('Control/Meta key pressed');
          this.isControlHeld = true;
        }
      }
    };

    this._keyupHandler = (e) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        console.log('Control/Meta key released');
        this.isControlHeld = false;

        // Process selected words if any
        if (this.selectedWordElements && this.selectedWordElements.size > 0) {
          const sortedElements = Array.from(this.selectedWordElements).sort((a, b) => {
            return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
          });

          const phrase = sortedElements.map(el => el.textContent.trim()).join(' ');
          console.log('Submitting phrase from selection:', phrase);

          sortedElements.forEach(el => el.classList.remove('selected'));
          if (this.selectedWordElements && typeof this.selectedWordElements.clear === 'function') {
            this.selectedWordElements.clear();
          }

          if (phrase.length > 0) {
            this.handleWordClick(phrase, sortedElements[0]);
          }
        }
      }
    };

    this._blurHandler = () => {
      this.isControlHeld = false;
      if (this.selectedWordElements && typeof this.selectedWordElements.clear === 'function') {
        this.selectedWordElements.clear();
      }
      if (this.subtitleContainer) {
        this.subtitleContainer.querySelectorAll('.interactive-word.selected').forEach(el => el.classList.remove('selected'));
      }
    };

    document.addEventListener('keydown', this._keydownHandler);
    document.addEventListener('keyup', this._keyupHandler);
    window.addEventListener('blur', this._blurHandler);

    // Use position:fixed for all platforms so centering is always relative to the viewport.
    // This ensures YouTube theater mode and normal mode both center correctly.
    if (this.platform === 'amazon') {
      this.subtitleContainer.style.cssText = `
        position: fixed !important;
        bottom: 120px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        max-width: 85% !important;
        pointer-events: none !important;
        display: none !important;
        font-family: Arial, sans-serif !important;
        z-index: 999999 !important;
        box-sizing: border-box !important;
        transition: opacity 0.2s ease !important;
      `;
    } else {
      let bottomPx = 90;
      let zIdx = 9999;
      if (this.platform === 'netflix') { bottomPx = 80; zIdx = 99999; }

      this.subtitleContainer.style.cssText = `
        position: fixed;
        left: 50%;
        bottom: ${bottomPx}px;
        transform: translateX(-50%);
        max-width: 85%;
        pointer-events: none;
        display: none;
        font-family: Arial, sans-serif;
        z-index: ${zIdx};
        transition: opacity 0.2s ease;
        box-sizing: border-box;
      `;
    }

    // Always attach to body since we are using position:fixed
    document.body.appendChild(this.subtitleContainer);
    console.log(`Subtitle container added to body (fixed positioning) for ${this.platform}`);

    // --- DRAGGING LOGIC ---
    // Track if user manually repositioned the box
    this._subtitleDragged = false;
    this._subtitleDragState = { isDragging: false };

    // We attach drag to subtitle text element (not container, since container has pointer-events:none in CSS).
    // This is done in renderInteractiveSubtitle each time, using _subtitleDragState.

    // Global mousemove / mouseup handlers for drag
    document.addEventListener('mousemove', (e) => {
      const ds = this._subtitleDragState;
      if (ds.isDragging) {
        this._subtitleDragged = true;
        const dx = e.clientX - ds.startX;
        const dy = ds.startY - e.clientY;
        this.subtitleContainer.style.setProperty('left', (ds.initialLeft + dx) + 'px', 'important');
        this.subtitleContainer.style.setProperty('bottom', (ds.initialBottom + dy) + 'px', 'important');
        return;
      }

      if (ds.pendingDrag) {
        const dx = e.clientX - ds.pendingX;
        const dy = ds.pendingY - e.clientY;
        if (Math.sqrt(dx * dx + dy * dy) > 8) {
          // Threshold reached! Activate real drag.
          ds.isDragging = true;
          ds.dragActivated = true; // flag so mouseup handler can ignore this interaction
          ds.startX = ds.pendingX;
          ds.startY = ds.pendingY;
          ds.initialLeft = ds.pendingLeft;
          ds.initialBottom = ds.pendingBottom;
          
          // Clear any accidental text selection that may have started
          const sel = window.getSelection();
          if (sel) sel.removeAllRanges();

          // Clear transform so left/bottom positioning works exactly
          this.subtitleContainer.style.setProperty('transform', 'none', 'important');
          this.subtitleContainer.style.setProperty('transition', 'none', 'important');
          this.subtitleContainer.style.setProperty('left', ds.initialLeft + 'px', 'important');
          this.subtitleContainer.style.setProperty('bottom', ds.initialBottom + 'px', 'important');
          
          const subText = this.subtitleContainer.querySelector('.interactive-subtitle-text');
          if (subText) subText.style.cursor = 'grabbing';
          
          document.body.style.userSelect = 'none';
          document.body.style.webkitUserSelect = 'none';
        }
      }
    });

    document.addEventListener('mouseup', () => {
      const ds = this._subtitleDragState;
      // If a definition modal is open and the click originated from it, cancel any pending drag
      // without repositioning the subtitle (fixes: X button click causing subtitle jump).
      const modalOpen = !!document.querySelector('.definition-modal');
      if (modalOpen) {
        ds.isDragging = false;
        ds.pendingDrag = false;
        ds.dragActivated = false;
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
        return;
      }
      if (ds.isDragging) {
        ds.isDragging = false;
        this.subtitleContainer.style.transition = 'opacity 0.2s ease';
        const subText = this.subtitleContainer.querySelector('.interactive-subtitle-text');
        if (subText) subText.style.cursor = 'move';
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
      }
      ds.pendingDrag = false;
      // Reset dragActivated after a short delay so the subtitle mouseup fires first
      setTimeout(() => { ds.dragActivated = false; }, 0);
    });

    // Re-center when YouTube toggles theater mode / normal mode (layout change)
    if (this.platform === 'youtube') {
      const recenterToYTPlayer = () => {
        if (this._subtitleDragged) return;
        const ytPlayer = document.querySelector('#movie_player, .html5-video-player');
        if (ytPlayer) {
          const rect = ytPlayer.getBoundingClientRect();
          const playerCenterX = rect.left + rect.width / 2;
          // Center subtitle over the player's horizontal center
          this.subtitleContainer.style.transform = 'none';
          // First set to center roughly, then correct after getting actual width
          this.subtitleContainer.style.left = playerCenterX + 'px';
          const subWidth = this.subtitleContainer.getBoundingClientRect().width || 0;
          this.subtitleContainer.style.left = (playerCenterX - subWidth / 2) + 'px';
        } else {
          // Fallback: center on viewport
          this.subtitleContainer.style.left = '50%';
          this.subtitleContainer.style.transform = 'translateX(-50%)';
        }
      };
      this._recenterToYTPlayer = recenterToYTPlayer;

      const ytLayoutObserver = new MutationObserver(() => {
        if (!this._subtitleDragged) recenterToYTPlayer();
      });
      const ytPlayer = document.querySelector('#movie_player, .html5-video-player');
      if (ytPlayer) {
        ytLayoutObserver.observe(ytPlayer, { attributes: true, attributeFilter: ['class'] });
      }
      // Also trigger on window resize
      window.addEventListener('resize', () => { if (!this._subtitleDragged) recenterToYTPlayer(); });
    }
  }

  getVideoContainer() {
    switch (this.platform) {
      case 'youtube': {
        return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
      }
      case 'netflix': {
        return document.querySelector('.watch-video') || document.querySelector('.NFPlayer');
      }
      case 'amazon': {
        const amazonSelectors = [
          'div[data-testid="dv-player-fullscreen"]',
          '.dv-player-fullscreen',
          '.webPlayerContainer',
          '[data-testid="video-player"]',
          '.webPlayerUIContainer',
          '.webPlayerElement',
          '#dv-web-player',
          '.webPlayerSDKContainer',
          '.cascadesContainer',
          '.player-container',
          '.atvwebplayersdk-player-container'
        ];

        for (const selector of amazonSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            console.log(`Found Amazon container with selector: ${selector}`);
            return element;
          }
        }

        console.log('No specific Amazon container found, using body');
        return document.body;
      }
      default:
        return document.body;
    }
  }

  // FIXED: Better pause detection
  startPauseDetection() {
    if (this.pauseCheckInterval) {
      clearInterval(this.pauseCheckInterval);
    }

    this.pauseCheckInterval = setInterval(() => {
      const video = this.getVideoElement();
      if (video) {
        const wasPaused = this.isVideoPaused;
        this.isVideoPaused = video.paused;

        // If video was just paused, keep showing current subtitle
        if (!wasPaused && this.isVideoPaused && this.lastValidSubtitle) {
          console.log('Video paused, maintaining subtitle display');
          this.showSubtitleWhenPaused();
        }

        // If video was just unpaused, resume normal monitoring
        if (wasPaused && !this.isVideoPaused) {
          console.log('Video unpaused, resuming normal subtitle monitoring');
        }
      }
    }, 100);
  }

  // FIXED: Show subtitle when paused
  showSubtitleWhenPaused() {
    if (this.lastValidSubtitle && this.enabled && this.isVideoPaused) {
      this.renderInteractiveSubtitle(this.lastValidSubtitle);
      // Keep subtitle visible while paused
      if (this.subtitleClearTimeout) {
        clearTimeout(this.subtitleClearTimeout);
        this.subtitleClearTimeout = null;
      }
    }
  }

  // FIXED: Improved Amazon Prime subtitle detection
  getAllSubtitleElements() {
    let elements = [];

    switch (this.platform) {
      case 'youtube': {
        elements = Array.from(document.querySelectorAll('.ytp-caption-segment'));
        if (elements.length === 0) {
          elements = Array.from(document.querySelectorAll('.captions-text, .ytp-caption-window-container .caption-window'));
        }
        break;
      }

      case 'netflix': {
        elements = Array.from(document.querySelectorAll('.player-timedtext-text-container span, .player-timedtext'));
        break;
      }

      case 'amazon': {
        // More comprehensive Amazon subtitle detection
        const amazonSelectors = [
          'atvwebplayersdk-captions-text',
          '.atvwebplayersdk-captions-text',
          '[data-testid="subtitle-text"]',
          '[data-testid="captions-text"]',
          '.webPlayerContainer .f35bt6a',
          '.webPlayerContainer [class*="subtitle"]',
          '.webPlayerContainer [class*="caption"]',
          '.subtitles-container span',
          '.captions span',
          '[class*="subtitle-text"]',
          '[class*="caption-text"]',
          '.dv-player-captions span',
          '.player-captions span',
          'span[data-automation-id*="subtitle"]',
          'span[data-automation-id*="caption"]',
          '.atvwebplayersdk-captions-overlay span',
          '.webPlayerSDK-captions-text',
          'div[class*="captions"] span',
          'div[class*="subtitle"] span',
          // Additional selectors for edge cases
          '.webPlayerContainer span[style*="position"]',
          '[class*="webPlayer"] span[style*="bottom"]'
        ];

        for (const selector of amazonSelectors) {
          elements = Array.from(document.querySelectorAll(selector));
          if (elements.length > 0) {
            console.log(`Found ${elements.length} Amazon subtitles with selector: ${selector}`);
            break;
          }
        }

        // Fallback: intelligent span detection
        if (elements.length === 0) {
          elements = this.findAmazonSubtitlesByIntelligentSearch();
        }
        break;
      }
    }

    // Filter valid subtitle elements
    const filteredElements = elements.filter(el => {
      if (!el || !el.textContent) return false;
      const text = el.textContent.trim();
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return text.length > 0 &&
        text.length < 500 &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
    });

    console.log(`Found ${filteredElements.length} valid subtitle elements for ${this.platform}`);
    return filteredElements;
  }

  // FIXED: Intelligent Amazon subtitle detection
  findAmazonSubtitlesByIntelligentSearch() {
    const allSpans = Array.from(document.querySelectorAll('span'));
    const potentialSubtitles = [];

    allSpans.forEach(span => {
      const text = span.textContent?.trim();
      if (!text || text.length === 0 || text.length > 500) return;

      const rect = span.getBoundingClientRect();
      const style = window.getComputedStyle(span);
      const parent = span.parentElement;
      const grandParent = parent?.parentElement;

      // Check if positioned in subtitle area (bottom 30% of screen)
      const isInSubtitleArea = rect.bottom > window.innerHeight * 0.7;

      // Check for subtitle-like styling
      const hasSubtitleStyling = style.position === 'absolute' ||
        style.position === 'fixed' ||
        style.zIndex > 1000;

      // Check parent context
      const hasSubtitleParent = parent && (
        parent.className.toLowerCase().includes('caption') ||
        parent.className.toLowerCase().includes('subtitle') ||
        parent.getAttribute('data-testid')?.includes('caption') ||
        parent.getAttribute('data-testid')?.includes('subtitle') ||
        parent.className.includes('atvwebplayersdk')
      );

      const hasSubtitleGrandParent = grandParent && (
        grandParent.className.toLowerCase().includes('caption') ||
        grandParent.className.toLowerCase().includes('subtitle') ||
        grandParent.className.includes('webPlayer')
      );

      // Score the element
      let score = 0;
      if (isInSubtitleArea) score += 3;
      if (hasSubtitleStyling) score += 2;
      if (hasSubtitleParent) score += 3;
      if (hasSubtitleGrandParent) score += 1;
      if (text.length > 5 && text.length < 200) score += 1;

      if (score >= 3) {
        potentialSubtitles.push({ element: span, score, text });
      }
    });

    // Sort by score and return elements
    potentialSubtitles.sort((a, b) => b.score - a.score);
    const elements = potentialSubtitles.slice(0, 5).map(item => item.element);

    if (elements.length > 0) {
      console.log(`Found ${elements.length} Amazon subtitles with intelligent search`);
    }

    return elements;
  }

  // FIXED: Better subtitle text extraction
  getCompleteSubtitleText() {
    const elements = this.getAllSubtitleElements();
    if (elements.length === 0) {
      // When paused, try to maintain last valid subtitle
      if (this.isVideoPaused && this.lastValidSubtitle) {
        return this.lastValidSubtitle;
      }
      return '';
    }

    if (this.platform === 'amazon') {
      return this.getAmazonSubtitleText(elements);
    }

    let completeText = elements.map(el => el.textContent.trim()).filter(text => text).join(' ');
    completeText = this.collapseImmediateDuplicatePhrases(this.sanitizeContextText(completeText));

    return completeText;
  }

  // FIXED: Amazon subtitle text extraction with stability
  getAmazonSubtitleText(elements) {
    if (elements.length === 0) return '';

    // Get all visible elements
    const visibleElements = elements.filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
    });

    if (visibleElements.length === 0) return '';

    // Extract and deduplicate text
    const textParts = [];
    const seenTexts = new Set();

    visibleElements.forEach(el => {
      const text = el.textContent.trim();
      if (text && !seenTexts.has(text.toLowerCase())) {
        seenTexts.add(text.toLowerCase());
        textParts.push(text);
      }
    });

    let completeText = textParts.join(' ');

    // Clean Amazon artifacts
    completeText = completeText.replace(/^\s*-\s*/, '');
    completeText = completeText.replace(/\s*-\s*$/, '');
    completeText = this.collapseImmediateDuplicatePhrases(this.sanitizeContextText(completeText));

    // Add stability tracking for Amazon
    this.trackSubtitleStability(completeText);

    return completeText;
  }

  // FIXED: Subtitle stability tracking
  trackSubtitleStability(subtitle) {
    if (!subtitle) return;

    const now = Date.now();
    if (this.subtitleStabilityTracker.has(subtitle)) {
      const data = this.subtitleStabilityTracker.get(subtitle);
      data.lastSeen = now;
      data.count++;
    } else {
      this.subtitleStabilityTracker.set(subtitle, {
        firstSeen: now,
        lastSeen: now,
        count: 1
      });
    }

    // Clean old entries
    for (const [text, data] of this.subtitleStabilityTracker.entries()) {
      if (now - data.lastSeen > 10000) { // 10 seconds
        this.subtitleStabilityTracker.delete(text);
      }
    }
  }

  // FIXED: Video seek detection
  detectVideoSeek() {
    const video = this.getVideoElement();
    if (!video) return false;

    const currentTime = video.currentTime;
    const timeDiff = Math.abs(currentTime - (this.lastVideoTime || 0));

    if (timeDiff > 2 && !this.isVideoPaused) {
      console.log('Video seek detected:', this.lastVideoTime, '->', currentTime);
      this.lastVideoTime = currentTime;
      this.recentSeekTimestamp = Date.now();
      return true;
    }

    this.lastVideoTime = currentTime;
    return false;
  }

  getVideoElement() {
    switch (this.platform) {
      case 'youtube': {
        return document.querySelector('#movie_player video, .html5-video-player video');
      }
      case 'netflix': {
        return document.querySelector('.watch-video video, .NFPlayer video');
      }
      case 'amazon': {
        const amazonVideoSelectors = [
          '.webPlayerContainer video',
          'video[data-testid="video-player"]',
          '.dv-player-fullscreen video',
          '.atvwebplayersdk-player-container video',
          'video'
        ];

        for (const selector of amazonVideoSelectors) {
          const video = document.querySelector(selector);
          if (video) return video;
        }
        return document.querySelector('video');
      }
      default:
        return document.querySelector('video');
    }
  }

  // FIXED: Reset state after seek
  resetStateAfterSeek() {
    console.log('Resetting subtitle state after video seek');

    if (this.subtitleContainer) {
      this.subtitleContainer.style.display = 'none';
    }

    this.lastSubtitleCheck = '';
    this.lastSubtitleTimestamp = 0;
    this.currentSubtitle = '';
    this.staticContentTracker.clear();
    this.subtitleStabilityTracker.clear();

    if (this.subtitleClearTimeout) {
      clearTimeout(this.subtitleClearTimeout);
      this.subtitleClearTimeout = null;
    }

    if (this.subtitleDisplayTimeout) {
      clearTimeout(this.subtitleDisplayTimeout);
      this.subtitleDisplayTimeout = null;
    }

    this.subtitleHistory = this.subtitleHistory.slice(-5);
  }

  // FIXED: Start subtitle monitoring with less aggressive clearing
  startSubtitleMonitoring() {
    console.log('Starting enhanced subtitle monitoring for', this.platform);

    this.lastVideoTime = 0;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    // Faster monitoring for responsive subtitle display
    const monitoringFrequency = this.platform === 'amazon' ? 80 : 100;

    this.monitoringInterval = setInterval(() => {
      if (!this.enabled) return;

      // Check for video seek first
      if (this.detectVideoSeek()) {
        this.resetStateAfterSeek();
        return;
      }

      const subtitleText = this.getCompleteSubtitleText();
      const currentTimestamp = Date.now();

      // Handle empty subtitle text
      if (!subtitleText) {
        this.handleEmptySubtitle();
        return;
      }

      // Check if static content
      if (this.isStaticContent(subtitleText, currentTimestamp)) {
        console.log('Skipping static content:', subtitleText);
        return;
      }

      // Check if new subtitle
      if (this.isNewSubtitle(subtitleText, currentTimestamp)) {
        this.processNewSubtitle(subtitleText, currentTimestamp);
      }
    }, monitoringFrequency);
  }

  // FIXED: Handle empty subtitle more gracefully
  handleEmptySubtitle() {
    // If video is paused, don't clear subtitle immediately
    if (this.isVideoPaused && this.lastValidSubtitle) {
      this.showSubtitleWhenPaused();
      return;
    }

    // For playing video, clear after a short delay
    this.clearSubtitleAfterDelay(500);
    this.cleanupStaticTracker();
  }

  // FIXED: Process new subtitle
  processNewSubtitle(subtitleText, currentTimestamp) {
    this.lastSubtitleCheck = subtitleText;
    this.lastSubtitleTimestamp = currentTimestamp;
    this.lastNonStaticSubtitle = subtitleText;
    this.lastValidSubtitle = subtitleText;

    console.log('New subtitle detected:', subtitleText);
    this.updateSubtitleWithContext(subtitleText);

    // Clear any pending timeouts
    if (this.subtitleClearTimeout) {
      clearTimeout(this.subtitleClearTimeout);
      this.subtitleClearTimeout = null;
    }

    if (this.subtitleDisplayTimeout) {
      clearTimeout(this.subtitleDisplayTimeout);
      this.subtitleDisplayTimeout = null;
    }
  }

  // FIXED: Static content detection
  isStaticContent(subtitle, currentTimestamp) {
    if (!subtitle || subtitle.trim().length === 0) return false;

    const cleanText = subtitle.trim();
    const timeSinceSeek = Date.now() - this.recentSeekTimestamp;
    const isRecentSeek = timeSinceSeek < 5000;

    // Be lenient after seeks
    if (isRecentSeek) {
      const obviousStaticPatterns = [
        /^[A-Z\s]{15,}$/,
        /episode \d+.*season \d+/i,
        /stagione \d+.*ep\.\s*\d+/i,
      ];

      for (const pattern of obviousStaticPatterns) {
        if (pattern.test(cleanText)) {
          console.log('Detected obvious static pattern after seek:', cleanText);
          return true;
        }
      }
      return false;
    }

    // Check permanently banned content
    if (this.bannedStaticContent.has(cleanText)) {
      console.log('Skipping permanently banned static content:', cleanText);
      return true;
    }

    // Pattern matching
    for (const pattern of this.staticContentPatterns) {
      if (pattern.test(cleanText)) {
        console.log('Detected static pattern, permanently banning:', cleanText);
        this.bannedStaticContent.add(cleanText);
        return true;
      }
    }

    // Content analysis
    if (this.isLikelyStaticByContent(cleanText)) {
      console.log('Detected as static by content analysis, banning:', cleanText);
      this.bannedStaticContent.add(cleanText);
      return true;
    }

    // Duration tracking (increased threshold)
    if (this.staticContentTracker.has(cleanText)) {
      const firstSeen = this.staticContentTracker.get(cleanText);
      const duration = currentTimestamp - firstSeen;

      if (duration > this.staticContentThreshold) {
        console.log('Content detected as static (duration), permanently banning:', cleanText, duration + 'ms');
        this.bannedStaticContent.add(cleanText);
        this.staticContentTracker.delete(cleanText);
        return true;
      }
    } else {
      this.staticContentTracker.set(cleanText, currentTimestamp);
    }

    return false;
  }

  isLikelyStaticByContent(text) {
    const cleanText = text.toLowerCase().trim();

    if (cleanText.length < 3) return true;

    if (/stagione\s+\d+.*ep\.\s*\d+/i.test(text)) {
      console.log('Detected Italian episode format:', text);
      return true;
    }

    if (text === text.toUpperCase() && text.length < 50 && text.length > 10) {
      return true;
    }

    if (/\b(stagione|season|episode|ep\.?)\s*\d+/i.test(text)) {
      return true;
    }

    const staticKeywords = [
      'directed by', 'produced by', 'starring', 'created by',
      'executive producer', 'written by', 'music by',
      'netflix', 'amazon', 'prime video', 'hbo', 'disney',
      'continues in', 'to be continued', 'next episode',
      'previously on', 'coming up', 'recap', 'stagione'
    ];

    for (const keyword of staticKeywords) {
      if (cleanText.includes(keyword.toLowerCase())) {
        console.log('Detected static keyword:', keyword, 'in:', cleanText);
        return true;
      }
    }

    return false;
  }

  cleanupStaticTracker() {
    const currentTime = Date.now();
    const maxAge = 60000; // Increased to 60 seconds

    for (const [text, timestamp] of this.staticContentTracker.entries()) {
      if (currentTime - timestamp > maxAge) {
        this.staticContentTracker.delete(text);
      }
    }
  }

  // FIXED: New subtitle detection
  isNewSubtitle(subtitle, timestamp) {
    if (!subtitle) return false;

    const currentTimestamp = Date.now();
    const timeSinceSeek = currentTimestamp - this.recentSeekTimestamp;
    const isRecentSeek = timeSinceSeek < 3000;

    // Be very permissive after seeks
    if (isRecentSeek) {
      if (subtitle === this.lastSubtitleCheck && (timestamp - this.lastSubtitleTimestamp) < 50) {
        return false;
      }
      return true;
    }

    // Avoid exact duplicates
    if (subtitle === this.lastSubtitleCheck) {
      const timeSinceLastSubtitle = timestamp - this.lastSubtitleTimestamp;
      if (timeSinceLastSubtitle < 150) {
        return false;
      }
    }

    // Amazon-specific logic
    if (this.platform === 'amazon') {
      const timeDiff = timestamp - this.lastSubtitleTimestamp;

      if (timeDiff < 100 && this.lastSubtitleCheck && !isRecentSeek) {
        const cleanPrevious = this.lastSubtitleCheck.replace(/[^\w]/g, '').toLowerCase();
        const cleanCurrent = subtitle.replace(/[^\w]/g, '').toLowerCase();

        if (cleanPrevious === cleanCurrent) {
          return false;
        }
      }

      if (timeDiff < 250 && this.areSimilarSubtitles(subtitle, this.lastSubtitleCheck, 0.95) && !isRecentSeek) {
        return false;
      }
    } else {
      const timeDiff = timestamp - this.lastSubtitleTimestamp;
      if (timeDiff < 150 && this.areSimilarSubtitles(subtitle, this.lastSubtitleCheck, 0.9) && !isRecentSeek) {
        return false;
      }
    }

    return true;
  }

  areSimilarSubtitles(subtitle1, subtitle2, threshold = 0.8) {
    if (!subtitle1 || !subtitle2) return false;

    const clean1 = subtitle1.replace(/[^\w\s]/g, '').toLowerCase().trim();
    const clean2 = subtitle2.replace(/[^\w\s]/g, '').toLowerCase().trim();

    if (clean1 === clean2) return true;

    if (clean1.length > 5 && clean2.length > 5) {
      const shorter = clean1.length <= clean2.length ? clean1 : clean2;
      const longer = clean1.length > clean2.length ? clean1 : clean2;

      if (longer.includes(shorter)) {
        return true;
      }
    }

    const words1 = clean1.split(/\s+/).filter(w => w.length > 2);
    const words2 = clean2.split(/\s+/).filter(w => w.length > 2);

    if (words1.length === 0 || words2.length === 0) return false;

    const commonWords = words1.filter(word => words2.includes(word));
    const totalWords = Math.max(words1.length, words2.length);

    const similarity = commonWords.length / totalWords;
    return similarity >= threshold;
  }

  sanitizeContextText(text) {
    if (!text) return '';

    // Remove subtitle wrappers/artifacts such as >< and similar angle-bracket glyphs.
    return text
      .replace(/[<>«»‹›⟨⟩]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  getComparableWords(text) {
    if (!text) return [];
    return this.sanitizeContextText(text)
      .toLowerCase()
      .replace(/[.,!?;:"'()[\]{}]/g, '')
      .split(/\s+/)
      .filter(Boolean);
  }

  collapseImmediateDuplicatePhrases(text) {
    if (!text) return '';

    const words = this.sanitizeContextText(text).split(/\s+/).filter(Boolean);
    if (words.length < 4) return words.join(' ');

    const comparable = words.map(w => w.toLowerCase().replace(/[.,!?;:"'()[\]{}]/g, ''));

    for (let window = Math.min(12, Math.floor(words.length / 2)); window >= 2; window -= 1) {
      let i = 0;
      while (i + (2 * window) <= words.length) {
        const first = comparable.slice(i, i + window).join(' ');
        const second = comparable.slice(i + window, i + (2 * window)).join(' ');

        if (first && first === second) {
          words.splice(i + window, window);
          comparable.splice(i + window, window);
          continue;
        }

        i += 1;
      }
    }

    return words.join(' ').replace(/\s+/g, ' ').trim();
  }

  mergePartsWithOverlap(parts) {
    const merged = [];

    for (const rawPart of parts) {
      const part = this.collapseImmediateDuplicatePhrases(this.sanitizeContextText(rawPart));
      if (!part) continue;

      if (merged.length === 0) {
        merged.push(part);
        continue;
      }

      const last = merged[merged.length - 1];
      const lastWords = this.getComparableWords(last);
      const partWords = this.getComparableWords(part);

      if (partWords.length === 0) continue;

      const lastComparable = lastWords.join(' ');
      const partComparable = partWords.join(' ');

      if (!partComparable) continue;

      // Skip exact duplicates and short contained repeats.
      if (partComparable === lastComparable || lastComparable.includes(partComparable)) {
        continue;
      }

      let bestOverlap = 0;
      const maxOverlap = Math.min(lastWords.length, partWords.length, 18);
      for (let overlap = maxOverlap; overlap >= 2; overlap -= 1) {
        const suffix = lastWords.slice(lastWords.length - overlap).join(' ');
        const prefix = partWords.slice(0, overlap).join(' ');
        if (suffix === prefix) {
          bestOverlap = overlap;
          break;
        }
      }

      if (bestOverlap > 0) {
        const partRawWords = part.split(/\s+/).filter(Boolean);
        const toAppend = partRawWords.slice(bestOverlap).join(' ').trim();
        if (toAppend) {
          merged[merged.length - 1] = `${last} ${toAppend}`.replace(/\s+/g, ' ').trim();
        }
      } else {
        merged.push(part);
      }
    }

    return merged;
  }

  dedupeRepeatedSentences(text) {
    if (!text) return '';

    const parts = text.match(/[^.!?]+[.!?]*|[^.!?]+$/g) || [text];
    const seen = new Set();
    const unique = [];

    for (const part of parts) {
      const sentence = part.trim();
      if (!sentence) continue;

      const canonical = this.sanitizeContextText(sentence)
        .toLowerCase()
        .replace(/[.,!?;:"'()[\]{}]/g, '')
        .trim();

      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      unique.push(sentence);
    }

    return this.collapseImmediateDuplicatePhrases(unique.join(' '));
  }

  // FIXED: Clear subtitle with longer delays
  clearSubtitleAfterDelay(delay = 800) {
    if (this.subtitleClearTimeout) return;

    this.subtitleClearTimeout = setTimeout(() => {
      const currentText = this.getCompleteSubtitleText();

      // Don't clear if video is paused or if there's still text
      if (!currentText && !this.isVideoPaused && this.subtitleContainer) {
        this.subtitleContainer.style.display = 'none';
      }
      this.subtitleClearTimeout = null;
    }, delay);
  }

  updateSubtitleWithContext(subtitle) {
    const lastHistoryItem = this.subtitleHistory.length > 0 ?
      this.subtitleHistory[this.subtitleHistory.length - 1].text : '';

    if (subtitle !== lastHistoryItem) {
      this.subtitleHistory.push({
        text: subtitle,
        timestamp: Date.now()
      });

      if (this.subtitleHistory.length > 10) {
        this.subtitleHistory.shift();
      }
    }

    if (this.currentSubtitle && this.currentSubtitle !== subtitle) {
      this.previousSubtitles.push(this.currentSubtitle);
      if (this.previousSubtitles.length > 5) {
        this.previousSubtitles.shift();
      }
    }

    this.currentSubtitle = subtitle;
    this.renderInteractiveSubtitle(subtitle);
  }

  // FIXED: Render with smoother transitions
  renderInteractiveSubtitle(subtitle) {
    if (!subtitle || !subtitle.trim()) {
      this.subtitleContainer.style.display = 'none';
      return;
    }

    const words = subtitle.split(/(\s+)/).filter(word => word.length > 0);

    this.subtitleContainer.innerHTML = '';
    this.subtitleContainer.style.display = 'block';
    this.subtitleContainer.style.opacity = '1';

    const subtitleText = document.createElement('div');
    subtitleText.className = 'interactive-subtitle-text';
    subtitleText.style.cursor = 'move';
    subtitleText.title = 'Drag to reposition · Double-click to center';

    words.forEach(word => {
      const wordElement = document.createElement('span');
      wordElement.textContent = word;

      if (word.trim() && /\w{2,}/.test(word)) {
        // Mark as interactive-word for selection snapping logic,
        // but NO click handler — subtitle is selectable, not clickable.
        wordElement.className = 'interactive-word';
        wordElement.style.cursor = 'text';
      }

      subtitleText.appendChild(wordElement);
    });

    this.subtitleContainer.appendChild(subtitleText);

    // Attach drag to the subtitleText element (pointer-events: auto)
    // Double-click resets to center
    subtitleText.addEventListener('dblclick', () => {
      this._subtitleDragged = false;
      if (this.platform === 'youtube' && this._recenterToYTPlayer) {
        this._recenterToYTPlayer();
      } else {
        this.subtitleContainer.style.transform = 'translateX(-50%)';
        this.subtitleContainer.style.left = '50%';
      }
      const bottomPx = this.platform === 'netflix' ? 80 : 90;
      this.subtitleContainer.style.bottom = bottomPx + 'px';
    });

    // Show grab cursor at border, text cursor in interior so user knows where to drag from.
    subtitleText.addEventListener('mousemove', (e) => {
      if (this._subtitleDragState && this._subtitleDragState.isDragging) return;
      const rect = this.subtitleContainer.getBoundingClientRect();
      const onBorder = (e.clientX - rect.left <= 12) || (rect.right - e.clientX <= 12) ||
                       (e.clientY - rect.top <= 12)  || (rect.bottom - e.clientY <= 12);
      subtitleText.style.cursor = onBorder ? 'grab' : '';
    });

    // Drag only activates when mousedown is on the BORDER zone of the subtitle box (~12px from any edge).
    // This prevents text-selection clicks in the interior from triggering a drag.
    const DRAG_BORDER_PX = 12;
    subtitleText.addEventListener('mousedown', (e) => {
      // Don't start drag on right-click
      if (e.button !== 0) return;

      const rect = this.subtitleContainer.getBoundingClientRect();
      const inLeftBorder   = e.clientX - rect.left   <= DRAG_BORDER_PX;
      const inRightBorder  = rect.right  - e.clientX  <= DRAG_BORDER_PX;
      const inTopBorder    = e.clientY - rect.top    <= DRAG_BORDER_PX;
      const inBottomBorder = rect.bottom - e.clientY  <= DRAG_BORDER_PX;
      const onBorder = inLeftBorder || inRightBorder || inTopBorder || inBottomBorder;

      if (!onBorder) return; // Interior click — allow text selection, don't start drag

      const ds = this._subtitleDragState;
      ds.pendingDrag = true;
      ds.pendingX = e.clientX;
      ds.pendingY = e.clientY;

      const containerRect = this.subtitleContainer.getBoundingClientRect();
      ds.pendingLeft = containerRect.left;
      ds.pendingBottom = window.innerHeight - containerRect.bottom;

      // Prevent text selection when dragging from border
      e.preventDefault();
    });

    // After render, update centering for YouTube
    if (this.platform === 'youtube' && this._recenterToYTPlayer && !this._subtitleDragged) {
      requestAnimationFrame(() => this._recenterToYTPlayer());
    }
  }

  handleSubtitleMouseUp(e) {
    // If a drag was just executed, ignore this mouseup entirely
    if (this._subtitleDragState && this._subtitleDragState.dragActivated) {
      // Clear any stray selection from the drag
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      return;
    }

    this.handleInteractiveSelection(e, this.subtitleContainer, null, this.getRichContext());
  }

  renderInteractiveSentence(sentence, targetElement, modalOrSidebar) {
    if (!sentence || !targetElement) return;

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

    targetElement.addEventListener('mouseup', (e) => {
        this.handleInteractiveSelection(e, targetElement, modalOrSidebar, sentence);
    });
  }

  handleInteractiveSelection(e, container, modalOrSidebar, context) {
    // 1. Check for text selection
    const selection = window.getSelection();
    const selectedText = selection.toString();

    if (selectedText.length > 0) {
      // We have a selection. Let's snap to words if it's partial.
      e.stopPropagation();

      let range = selection.getRangeAt(0);
      let startNode = range.startContainer;
      let endNode = range.endContainer;

      // Ensure we are selecting text nodes inside interactive-word
      if (startNode.nodeType === Node.TEXT_NODE) startNode = startNode.parentNode;
      if (endNode.nodeType === Node.TEXT_NODE) endNode = endNode.parentNode;

      // Check if selection is within our target container
      if (!container.contains(startNode) || !container.contains(endNode)) {
        return; // Selection outside target
      }

      // Snap logic: Find the full words corresponding to start and end
      const startWordEl = startNode.closest('.interactive-word');
      const endWordEl = endNode.closest('.interactive-word');

      let phrase = '';

      if (startWordEl && endWordEl) {
        const allWords = Array.from(container.querySelectorAll('.interactive-word'));
        const startIndex = allWords.indexOf(startWordEl);
        const endIndex = allWords.indexOf(endWordEl);

        if (startIndex !== -1 && endIndex !== -1) {
          const first = Math.min(startIndex, endIndex);
          const last = Math.max(startIndex, endIndex);

          // Clear previous highlights
          allWords.forEach(w => w.classList.remove('active-lookup'));

          const words = [];
          for (let i = first; i <= last; i++) {
            words.push(allWords[i].textContent);
            allWords[i].classList.add('active-lookup');
          }
          phrase = words.join(' ');
        } else {
          phrase = selectedText;
        }
      } else if (startWordEl) {
        container.querySelectorAll('.interactive-word').forEach(w => w.classList.remove('active-lookup'));
        phrase = startWordEl.textContent;
        startWordEl.classList.add('active-lookup');
      } else if (endWordEl) {
        container.querySelectorAll('.interactive-word').forEach(w => w.classList.remove('active-lookup'));
        phrase = endWordEl.textContent;
        endWordEl.classList.add('active-lookup');
      } else {
        phrase = selectedText;
      }

        // Clear selection to avoid visual clutter
        if (selection && typeof selection.removeAllRanges === 'function') {
          selection.removeAllRanges();
        }

        phrase = phrase.trim();
        console.log('Selection processed:', phrase);

        if (phrase.length > 0) {
          // If this is inside a special interactive area (like the context box in modal/sidebar),
          // we update the target word badge/button instead of opening a new modal.
          if (container.classList.contains('sentence-lookup-area')) {
            const badge = (modalOrSidebar || document).querySelector('#modal-target-word-badge') || 
                          (modalOrSidebar || document).querySelector('#sidebar-target-word-badge');
            if (badge) badge.textContent = phrase;
            const aiBtn = (modalOrSidebar || document).querySelector('#get-ai-definition') || 
                          (modalOrSidebar || document).querySelector('#sidebar-get-ai');
            if (aiBtn) {
              aiBtn.setAttribute('data-target-word', phrase);
              aiBtn.textContent = 'Get AI Definition for "' + phrase + '"';
            }
            this.updateLookupTarget((modalOrSidebar || document), phrase, context);
          } else {
            // It's a subtitle selection - trigger lookup
            const anchor = endWordEl || e.target;
            const anchorEl = selection.anchorNode ? selection.anchorNode.parentElement : anchor;

            this.handleWordClick(phrase, anchorEl);
          }
        }
    }
  }

  handleSelection() {
    // Deprecated in favor of handleSubtitleMouseUp but kept for safety/logic reference if needed
    // logic moved to handleSubtitleMouseUp
  }

  handleWordClick(word, element) {
    const cleanWord = word.replace(/[.,!?;:"'()[\]{}]/g, '').toLowerCase();
    if (!cleanWord || cleanWord.length < 2) return;

    const context = this.getRichContext();

    console.log('Word clicked:', cleanWord);
    console.log('Rich context:', context);

    this.showDefinitionModal(cleanWord, context, element);
  }

  isItalianLang(word, context) {
    if (this.ankiDeckItalian === 'Italian' && context) {
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

  buildDictionaryLinksMarkup(word, isItalian) {
    if (isItalian) {
      return `
        <div style="display:flex; flex-direction:row; gap:8px; justify-content:center; flex-wrap:wrap;">
          <a href="https://www.collinsdictionary.com/dictionary/italian-english/${encodeURIComponent(word.toLowerCase())}" 
             target="_blank" 
             class="dict-link" style="padding:6px 12px; border-radius:6px; background:linear-gradient(135deg, #1e3a8a, #0ea5e9); color:white; text-decoration:none; font-size:12px; font-weight:500;">
            Collins
          </a>
          <a href="https://www.wordreference.com/iten/${encodeURIComponent(word.toLowerCase())}" 
             target="_blank" 
             class="dict-link" style="padding:6px 12px; border-radius:6px; background:linear-gradient(135deg, #4c1d95, #8b5cf6); color:white; text-decoration:none; font-size:12px; font-weight:500;">
            WordReference
          </a>
          <a href="https://context.reverso.net/translation/italian-english/${encodeURIComponent(word.toLowerCase())}" 
             target="_blank" 
             class="dict-link" style="padding:6px 12px; border-radius:6px; background:linear-gradient(135deg, #831843, #f43f5e); color:white; text-decoration:none; font-size:12px; font-weight:500;">
            Reverso
          </a>
        </div>
      `;
    }

    return `
      <div style="display:flex; flex-direction:row; gap:8px; justify-content:center; flex-wrap:wrap;">
        <a href="https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(word)}" 
           target="_blank" 
           class="dict-link" style="padding:6px 12px; border-radius:6px; background:linear-gradient(135deg, #1e3a8a, #3b82f6); color:white; text-decoration:none; font-size:12px; font-weight:500;">
          Cambridge
        </a>
        <a href="https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(word)}" 
           target="_blank" 
           class="dict-link" style="padding:6px 12px; border-radius:6px; background:linear-gradient(135deg, #1e1b4b, #3730a3); color:white; text-decoration:none; font-size:12px; font-weight:500;">
          Oxford
        </a>
        <a href="https://www.ldoceonline.com/dictionary/${encodeURIComponent(word)}" 
           target="_blank" 
           class="dict-link" style="padding:6px 12px; border-radius:6px; background:linear-gradient(135deg, #166534, #22c55e); color:white; text-decoration:none; font-size:12px; font-weight:500;">
          Longman
        </a>
      </div>
    `;
  }

  updateLookupTarget(targetRoot, wordOrPhrase, context) {
    const normalizedWord = (wordOrPhrase || '').trim().replace(/^[^\w]+|[^\w]+$/g, '');
    if (!normalizedWord || !targetRoot) return;

    const isItalian = this.isItalianLang(normalizedWord, context);
    const websterTabName = isItalian ? 'Wiktionary IT' : 'Merriam-Webster';
    const merriamUrl = isItalian
      ? `https://en.wiktionary.org/wiki/${encodeURIComponent(normalizedWord.toLowerCase())}#Italian`
      : `https://www.merriam-webster.com/dictionary/${encodeURIComponent(normalizedWord)}`;
    const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(normalizedWord)}`;

    const modalTitle = targetRoot.querySelector('.modal-word-title');
    if (modalTitle) modalTitle.textContent = `Definition: "${normalizedWord}"`;

    const tabBtn = targetRoot.querySelector('[data-tab="merriam"]');
    if (tabBtn) tabBtn.textContent = websterTabName;

    const badge = targetRoot.querySelector('#modal-target-word-badge');
    if (badge) badge.textContent = normalizedWord;

    const aiBtn = targetRoot.querySelector('#get-ai-definition');
    if (aiBtn) {
      aiBtn.setAttribute('data-target-word', normalizedWord);
      aiBtn.textContent = `Get AI Definition for "${normalizedWord}"`;
      aiBtn.disabled = false;
      aiBtn.style.opacity = '1';
    }

    const merriamFrame = targetRoot.querySelector('.tab-content[data-tab="merriam"] iframe');
    const merriamLink = targetRoot.querySelector('.tab-content[data-tab="merriam"] .external-link');

    if (merriamFrame) merriamFrame.src = merriamUrl;
    if (merriamLink) merriamLink.href = merriamUrl;

    const wikiFrame = targetRoot.querySelector('.tab-content[data-tab="wikipedia"] iframe');
    const wikiLink = targetRoot.querySelector('.tab-content[data-tab="wikipedia"] .external-link');

    if (wikiFrame) wikiFrame.src = wikiUrl;
    if (wikiLink) wikiLink.href = wikiUrl;

    const dictContainer = targetRoot.querySelector('.tab-content[data-tab="dictionaries"] .dictionary-links');
    if (dictContainer) {
      dictContainer.innerHTML = this.buildDictionaryLinksMarkup(normalizedWord, isItalian);
    }
  }

  getRichContext() {
    let contextParts = [];

    const recentHistory = this.subtitleHistory
      .filter(item => item.text !== this.currentSubtitle)
      .slice(-3)
      .map(item => item.text);

    const uniqueHistory = [];
    const seen = new Set();

    for (const subtitle of recentHistory) {
      const cleanSubtitle = subtitle.trim().toLowerCase();
      if (!seen.has(cleanSubtitle) && cleanSubtitle.length > 0) {
        seen.add(cleanSubtitle);
        uniqueHistory.push(subtitle);
      }
    }

    contextParts = [...uniqueHistory];

    if (this.currentSubtitle) {
      const currentClean = this.currentSubtitle.trim().toLowerCase();
      const lastHistoryClean = uniqueHistory.length > 0 ?
        uniqueHistory[uniqueHistory.length - 1].trim().toLowerCase() : '';

      if (currentClean !== lastHistoryClean) {
        contextParts.push(this.currentSubtitle);
      }
    }

    const sanitizedParts = contextParts
      .map(part => this.sanitizeContextText(part))
      .filter(Boolean);

    const mergedParts = this.mergePartsWithOverlap(sanitizedParts);

    const context = this.dedupeRepeatedSentences(mergedParts.join(' '));
    console.log('Generated rich context from', contextParts.length, 'unique parts:', context);

    return context || this.sanitizeContextText(this.currentSubtitle) || 'No context available';
  }

  // Smart context extraction for articles/webpages (non-subtitle pages)
  getArticleContext(word) {
    const BLOCK_TAGS = new Set(['P', 'DIV', 'ARTICLE', 'SECTION', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGCAPTION', 'DD', 'DT']);
    const CONTENT_TAGS = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH', 'DD', 'DT', 'SUMMARY'];

    // Check if we captured context during contextmenu event
    const capturedWord = String(this.lastContextMenuContext?.word || '');
    if (capturedWord && capturedWord.toLowerCase().includes(word.toLowerCase())) {
      console.log('[CONTEXT] Using pre-captured contextmenu context');
      return this.formatSentenceContext(this.lastContextMenuContext.context, word);
    }

    let blockEl = null;

    // === Strategy 1: Try to use the active text selection ===
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && selection.anchorNode) {
      let node = selection.anchorNode;
      // If text node, start from parent
      if (node.nodeType === Node.TEXT_NODE) {
        node = node.parentNode;
      }
      // Walk up until we find a block-level element
      let candidate = node;
      while (candidate && candidate !== document.body && !BLOCK_TAGS.has(candidate.tagName)) {
        candidate = candidate.parentElement;
      }
      if (candidate && candidate !== document.body) {
        const text = (candidate.innerText || '').trim();
        if (text.toLowerCase().includes(word.toLowerCase())) {
          blockEl = candidate;
          console.log('[CONTEXT] Found block via selection:', candidate.tagName);
        }
      }
    }

    // === Strategy 2: Selection gone — scan DOM for the word ===
    if (!blockEl) {
      console.log('[CONTEXT] Selection unavailable, scanning DOM for word:', word);
      const wordLower = word.toLowerCase();

      // Search content-rich elements first (p, headings, list items)
      for (const tag of CONTENT_TAGS) {
        const elements = document.querySelectorAll(tag);
        for (const el of elements) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text.length > 0 && text.toLowerCase().includes(wordLower)) {
            // Prefer elements where word appears as a whole word, not substring
            const wordBoundaryRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (wordBoundaryRegex.test(text)) {
              blockEl = el;
              console.log('[CONTEXT] Found word in', tag, '- text length:', text.length);
              break;
            }
          }
        }
        if (blockEl) break;
      }

      // Broader fallback: search any visible element containing the word
      if (!blockEl) {
        const allElements = document.querySelectorAll('p, span, div, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, summary, a, em, strong, b, i');
        for (const el of allElements) {
          const text = (el.innerText || el.textContent || '').trim();
          if (text.length > 10 && text.toLowerCase().includes(wordLower)) {
            // Walk up to nearest block parent
            let parent = el;
            while (parent && parent !== document.body && !BLOCK_TAGS.has(parent.tagName)) {
              parent = parent.parentElement;
            }
            if (parent && parent !== document.body) {
              blockEl = parent;
            } else {
              blockEl = el;
            }
            console.log('[CONTEXT] Fallback DOM scan found word in:', blockEl.tagName);
            break;
          }
        }
      }
    }

    // If we still have nothing, return just the word
    if (!blockEl) {
      console.log('[CONTEXT] Could not find word in DOM, returning word only');
      return word;
    }

    // === Extract context from found block + neighbors ===
    const currentText = (blockEl.innerText || blockEl.textContent || '').trim();

    // Get previous sibling block text
    let prevText = '';
    let prevEl = blockEl.previousElementSibling;
    while (prevEl && !BLOCK_TAGS.has(prevEl.tagName)) {
      prevEl = prevEl.previousElementSibling;
    }
    if (prevEl) {
      prevText = (prevEl.innerText || prevEl.textContent || '').trim();
    }

    // Get next sibling block text
    let nextText = '';
    let nextEl = blockEl.nextElementSibling;
    while (nextEl && !BLOCK_TAGS.has(nextEl.tagName)) {
      nextEl = nextEl.nextElementSibling;
    }
    if (nextEl) {
      nextText = (nextEl.innerText || nextEl.textContent || '').trim();
    }

    // Combine: [prev] [current] [next]
    let parts = [prevText, currentText, nextText].filter(t => t.length > 0);
    let combined = parts.join(' ');

    return this.formatSentenceContext(combined, word, currentText);
  }

  formatSentenceContext(combined, word, fallbackText = '') {
    const MAX_CONTEXT_LEN = 500;

    combined = this.sanitizeContextText(combined);
    fallbackText = this.sanitizeContextText(fallbackText);

    // Ensure the word actually appears in the context
    if (!combined.toLowerCase().includes(word.toLowerCase())) {
      combined = fallbackText || word;
    }

    // === Extract the specific sentence containing the word ===
    // Split into sentences and find the one(s) with the word
    const sentences = combined.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [combined];
    const wordLower = word.toLowerCase();
    const matchingSentences = sentences.filter(s => s.toLowerCase().includes(wordLower));

    if (matchingSentences.length > 0) {
      // Use matching sentence(s) + one sentence before and after for context
      const matchIdx = sentences.indexOf(matchingSentences[0]);
      const contextSentences = [];
      if (matchIdx > 0) contextSentences.push(sentences[matchIdx - 1].trim());
      contextSentences.push(...matchingSentences.map(s => s.trim()));
      if (matchIdx + matchingSentences.length < sentences.length) {
        contextSentences.push(sentences[matchIdx + matchingSentences.length].trim());
      }
      combined = contextSentences.join(' ');
    }

    combined = this.dedupeRepeatedSentences(combined);
    combined = this.collapseImmediateDuplicatePhrases(combined);

    // Trim to max length, preserving sentence boundaries
    if (combined.length > MAX_CONTEXT_LEN) {
      const wordIdx = combined.toLowerCase().indexOf(wordLower);
      const halfWindow = Math.floor(MAX_CONTEXT_LEN / 2);
      let start = Math.max(0, wordIdx - halfWindow);
      let end = Math.min(combined.length, wordIdx + word.length + halfWindow);

      // Snap to sentence boundaries if possible
      const sentenceStart = combined.lastIndexOf('. ', start);
      if (sentenceStart !== -1 && sentenceStart > start - 80) {
        start = sentenceStart + 2;
      }
      const sentenceEnd = combined.indexOf('. ', end);
      if (sentenceEnd !== -1 && sentenceEnd < end + 80) {
        end = sentenceEnd + 1;
      }

      combined = combined.substring(start, end).trim();
    }

    console.log('[CONTEXT] Article context extracted:', combined.substring(0, 150) + (combined.length > 150 ? '...' : ''));
    return combined || fallbackText || word;
  }

  // FIXED: Enhanced Amazon Prime setup
  setupAmazonPrimeEnhancements() {
    console.log('Setting up Amazon Prime specific enhancements...');

    // Enhanced mutation observer for Amazon Prime
    const observer = new MutationObserver((mutations) => {
      let shouldCheck = false;
      let foundSubtitleChanges = false;

      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          const addedNodes = Array.from(mutation.addedNodes);
          const removedNodes = Array.from(mutation.removedNodes);

          const hasSubtitleChanges = [...addedNodes, ...removedNodes].some(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            return node.matches && (
              node.matches('atvwebplayersdk-captions-text') ||
              node.matches('[class*="subtitle"]') ||
              node.matches('[class*="caption"]') ||
              node.matches('[data-testid*="subtitle"]') ||
              node.matches('[data-testid*="caption"]') ||
              (node.querySelector && (
                node.querySelector('atvwebplayersdk-captions-text') ||
                node.querySelector('[class*="subtitle"]') ||
                node.querySelector('[class*="caption"]')
              ))
            );
          });

          if (hasSubtitleChanges) {
            foundSubtitleChanges = true;
            shouldCheck = true;
          }
        }

        // Watch for attribute changes that might affect subtitle visibility
        if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target && (
            target.className?.includes('caption') ||
            target.className?.includes('subtitle') ||
            target.getAttribute('data-testid')?.includes('subtitle')
          )) {
            shouldCheck = true;
          }
        }
      });

      if (shouldCheck) {
        console.log('Amazon Prime subtitle structure changed, subtitle changes:', foundSubtitleChanges);
        // Small delay to let DOM settle
        setTimeout(() => {
          this.ensureAmazonSubtitlePosition();
          if (foundSubtitleChanges) {
            // Force a subtitle check
            this.forceSubtitleCheck();
          }
        }, 50);
      }
    });

    const amazonContainer = document.querySelector('.webPlayerContainer, .cascadesContainer, .dv-player-fullscreen, body');
    if (amazonContainer) {
      observer.observe(amazonContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'data-testid', 'aria-hidden']
      });
      console.log('Amazon Prime mutation observer set up on:', amazonContainer.className || 'body');
      this.amazonObserver = observer;
    }

    this.setupAmazonVideoStateMonitoring();
  }

  // FIXED: Force subtitle check for Amazon Prime
  forceSubtitleCheck() {
    if (!this.enabled) return;

    const subtitleText = this.getCompleteSubtitleText();
    const currentTimestamp = Date.now();

    if (subtitleText && subtitleText !== this.lastSubtitleCheck) {
      console.log('Forced subtitle check found new text:', subtitleText);

      if (!this.isStaticContent(subtitleText, currentTimestamp)) {
        this.processNewSubtitle(subtitleText, currentTimestamp);
      }
    }
  }

  setupAmazonVideoStateMonitoring() {
    let videoEventsSetup = false;

    const checkVideoState = () => {
      const video = this.getVideoElement();
      if (video && !videoEventsSetup) {
        const videoEvents = ['play', 'pause', 'seeked', 'timeupdate', 'loadedmetadata', 'canplay'];

        videoEvents.forEach(eventType => {
          video.addEventListener(eventType, () => {
            console.log(`Amazon Prime video event: ${eventType}`);

            if (eventType === 'seeked') {
              console.log('Amazon Prime video seeked event detected');
              this.resetStateAfterSeek();
            }

            if (eventType === 'pause') {
              this.isVideoPaused = true;
              this.showSubtitleWhenPaused();
            }

            if (eventType === 'play') {
              this.isVideoPaused = false;
            }

            // Ensure subtitle container positioning
            setTimeout(() => {
              this.ensureAmazonSubtitlePosition();
            }, 100);
          });
        });

        videoEventsSetup = true;
        console.log('Amazon Prime video event listeners set up');
      } else if (!video) {
        setTimeout(checkVideoState, 1000);
      }
    };

    checkVideoState();
  }

  ensureAmazonSubtitlePosition() {
    if (!this.subtitleContainer || this.platform !== 'amazon') return;

    // Force proper positioning for Amazon Prime
    this.subtitleContainer.style.cssText = `
      position: fixed !important;
      bottom: 120px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      max-width: 85% !important;
      pointer-events: none !important;
      display: ${this.subtitleContainer.style.display} !important;
      font-family: Arial, sans-serif !important;
      z-index: 999999 !important;
      box-sizing: border-box !important;
      transition: opacity 0.2s ease !important;
      opacity: ${this.subtitleContainer.style.opacity || '1'} !important;
    `;

    // Ensure it's in the right container
    const videoContainer = this.getVideoContainer();
    if (videoContainer && !videoContainer.contains(this.subtitleContainer)) {
      videoContainer.appendChild(this.subtitleContainer);
      console.log('Repositioned subtitle container in Amazon video container');
    }
  }

  showDefinitionModal(word, context) {
    const existingModal = document.getElementById('definition-modal');
    if (existingModal) {
      existingModal.remove();
    }

    const modal = document.createElement('div');
    modal.id = 'definition-modal';
    modal.className = 'definition-modal';

    const modalContent = document.createElement('div');
    modalContent.className = 'definition-modal-content';
    if (this.darkMode) {
      modalContent.classList.add('dark-mode');
    }

    const wordCount = (word || '').trim().split(/\s+/).length;
    const isSentence = wordCount > 3;
    const displayWordTxt = isSentence ? "" : word;
    const headerTitle = isSentence ? "Select a word" : `Definition: "${displayWordTxt}"`;

    const isItalian = this.isItalianLang(displayWordTxt, context);

    const modalWordHeader = document.createElement('div');
    modalWordHeader.className = 'modal-word-header';
    modalWordHeader.innerHTML = `<h3 class="modal-word-title">${headerTitle}</h3>`;

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `
      <div class="header-left">
        <div class="definition-tabs">
          <button class="tab-btn active" data-tab="ai">AI Context</button>
          <button class="tab-btn" data-tab="merriam">${isItalian ? 'Wiktionary IT' : 'Merriam-Webster'}</button>
          <button class="tab-btn" data-tab="wikipedia">Wikipedia</button>
          <button class="tab-btn" data-tab="dictionaries">Other Dictionaries</button>
        </div>
      </div>
      <div class="header-right-controls" style="display:flex;align-items:center;gap:4px;">
        <button class="modal-theme-btn" title="Toggle Theme" style="background:none;border:none;cursor:pointer;font-size:16px;padding:4px 6px;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center;">🌙</button>
      </div>
    `;

    // Close button: inside header-right-controls for consistent positioning
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = '&times;';
    header.querySelector('.header-right-controls').appendChild(closeBtn);

    const contentArea = document.createElement('div');
    contentArea.className = 'definition-content';

    const merriamUrl = isItalian ? `https://en.wiktionary.org/wiki/${encodeURIComponent(displayWordTxt.toLowerCase())}#Italian` : `https://www.merriam-webster.com/dictionary/${encodeURIComponent(displayWordTxt)}`;
    const merriamContent = this.createIframeContent('merriam', merriamUrl);
    const dictionariesContent = this.createDictionariesContent(displayWordTxt, isItalian);
    const wikipediaContent = this.createIframeContent('wikipedia', `https://en.wikipedia.org/wiki/${encodeURIComponent(displayWordTxt)}`);
    const aiContent = this.createAIContent(displayWordTxt, context);

    aiContent.classList.add('active');
    aiContent.style.display = 'block';

    contentArea.appendChild(aiContent);
    contentArea.appendChild(merriamContent);
    contentArea.appendChild(wikipediaContent);
    contentArea.appendChild(dictionariesContent);

    // Anki button container
    const ankiContainer = document.createElement('div');
    ankiContainer.className = 'anki-bottom-bar';
    ankiContainer.style.cssText = 'padding: 8px 16px; border-top: 1px solid #e9ecef; display: flex; align-items: center; gap: 10px;';
    const screenshotCheckedAttr = this.getDefaultScreenshotEnabled() ? 'checked' : '';
    ankiContainer.innerHTML = `
      <label style="display:flex;align-items:center;gap:4px;color:#6c757d;font-size:12px;cursor:pointer;user-select:none;">
        <input type="checkbox" id="modal-screenshot-cb" ${screenshotCheckedAttr} style="accent-color:#3b82f6;cursor:pointer;"> Screenshot
      </label>
      <button id="anki-add-btn" class="anki-btn">⭐ Add to Anki</button>
      <span id="anki-status" style="font-size:12px;color:#6c757d;"></span>
    `;

    modalContent.appendChild(modalWordHeader);
    modalContent.appendChild(header);
    modalContent.appendChild(contentArea);
    modalContent.appendChild(ankiContainer);
    modal.appendChild(modalContent);

    document.body.appendChild(modal);

    this.setupModalEventListeners(modal, word, context);
    modal.offsetHeight;
    this.switchTab(modal, 'ai');

    // Anki button event
    modal.querySelector('#anki-add-btn').addEventListener('click', async () => {
      const liveWord = (modal.querySelector('#get-ai-definition')?.getAttribute('data-target-word') || word).trim();
      await this.handleAddToAnki(liveWord, context, modal);
    });
  }

  createDictionariesContent(word, isItalian) {
    const content = document.createElement('div');
    content.className = 'tab-content';
    content.setAttribute('data-tab', 'dictionaries');

    const container = document.createElement('div');
    container.className = 'dictionaries-container';
    container.innerHTML = `
      <div class="dictionaries-header">
        <h4>Other Dictionaries</h4>
        <p>Click to open ${word} in different dictionary sources:</p>
      </div>
      
      <div class="dictionary-links">
        ${this.buildDictionaryLinksMarkup(word, isItalian)}
      </div>
      
      <div class="dictionary-note">
        <p><strong>Tip:</strong> Each dictionary offers unique perspectives - Cambridge for British usage, Oxford for learners, and Longman for contemporary examples.</p>
      </div>
    `;

    content.appendChild(container);
    return content;
  }

  createIframeContent(type, url) {
    const content = document.createElement('div');
    content.className = 'tab-content';
    content.setAttribute('data-tab', type);

    const container = document.createElement('div');
    container.className = 'iframe-container';

    const themes = {
      merriam: {
        color: '#dc143c',
        name: 'Merriam-Webster',
        icon: '📚',
        description: 'America\'s most trusted dictionary since 1828'
      },
      wikipedia: {
        color: '#0066cc',
        name: 'Wikipedia',
        icon: '📖',
        description: 'Encyclopedia article and detailed information'
      }
    };

    const theme = themes[type] || themes.wikipedia;

    const iframeWrapper = document.createElement('div');
    iframeWrapper.style.cssText = `
      width: 100%;
      height: 100%;
      position: relative;
      background: white;
      display: block;
    `;

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.className = 'definition-iframe';
    iframe.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: white;
      display: block;
      position: absolute;
      top: 0;
      left: 0;
    `;

    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups allow-forms allow-top-navigation');
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');

    let errorShown = false;

    const showError = () => {
      if (errorShown) return;
      errorShown = true;
      iframeWrapper.innerHTML = `
        <div class="iframe-error" style="
          padding: 60px 20px;
          text-align: center;
          color: #6c757d;
          background: white;
          height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          box-sizing: border-box;
        ">
          <div style="font-size: 64px; margin-bottom: 20px; opacity: 0.7;">${theme.icon}</div>
          <h4 style="color: #212529; margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">${theme.name} Unavailable</h4>
          <p style="margin-bottom: 20px; font-size: 14px; line-height: 1.5; max-width: 400px;">The ${theme.name} page couldn't be loaded directly due to security restrictions.</p>
          <a href="${url}" target="_blank" class="external-link" style="
            background: ${theme.color};
            color: white;
            padding: 12px 20px;
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
          ">
            Open ${theme.name} in New Tab
          </a>
        </div>
      `;
    };

    iframe.onload = () => {
      setTimeout(() => {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
          if (!iframeDoc || iframeDoc.body.innerHTML.trim() === '') {
            showError();
          }
        } catch {
          // Cross-origin restrictions - iframe might still be working
        }
      }, 2000);
    };

    iframe.onerror = () => showError();

    setTimeout(() => {
      try {
        if (!iframe.contentDocument && !iframe.contentWindow) {
          showError();
        }
      } catch {
        // Cross-origin restrictions
      }
    }, 8000);

    const fallbackLink = document.createElement('div');
    fallbackLink.className = 'fallback-link';
    fallbackLink.style.cssText = `
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 10;
    `;
    fallbackLink.innerHTML = `
      <a href="${url}" target="_blank" class="external-link" style="
        background: #0066cc;
        color: white;
        padding: 8px 14px;
        text-decoration: none;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all 0.2s ease;
        box-shadow: 0 2px 8px rgba(0, 102, 204, 0.2);
      ">
        Open in New Tab
      </a>
    `;

    iframeWrapper.appendChild(iframe);
    iframeWrapper.appendChild(fallbackLink);
    container.appendChild(iframeWrapper);
    content.appendChild(container);
    return content;
  }

  createAIContent(word, context) {
    const displayWordTxt = word || '';
    const targetWordBadgeTxt = displayWordTxt || '...';
    const aiBtnText = displayWordTxt ? `Get AI Definition for "${displayWordTxt}"` : "Select a word to get AI Definition";

    const content = document.createElement('div');
    content.className = 'tab-content';
    content.setAttribute('data-tab', 'ai');

    const aiContainer = document.createElement('div');
    aiContainer.className = 'ai-content';
    aiContainer.innerHTML = `
      <div class="ai-header">
        <h4>AI Context Analysis</h4>
        <div class="ai-provider-selection">
          <label for="ai-provider">AI Provider:</label>
          <select id="ai-provider">
            <option value="mistral">Mistral AI</option>
            <option value="custom">Custom LLM</option>
          </select>
        </div>
      </div>
      <div class="context-display">
        <div style="margin-bottom: 10px;">
          <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #5f6368;">Target word(s):</strong>&nbsp;
          <span id="modal-target-word-badge" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6; padding: 3px 10px; border-radius: 12px; font-weight: bold; font-size: 15px;">${targetWordBadgeTxt}</span>
        </div>
        <strong>Context:</strong><br>
        <div id="interactive-sentence-container"
             class="sentence-lookup-area context-view-mode"
             style="margin: 10px 0; font-size: 16px; line-height: 1.6; color: inherit;
                    cursor: text; user-select: text; -webkit-user-select: text;
                    pointer-events: auto;">
        </div>
        <div style="font-size: 12px; color: #6c757d; font-style: italic; margin-top: 8px;">
          💡 Select any word or phrase above to update all lookup sections
        </div>
      </div>

      <button id="get-ai-definition" class="ai-btn" data-target-word="${displayWordTxt}">${aiBtnText}</button>
      <div id="ai-response" class="ai-response"></div>
      <div id="modal-ai-chat" class="ai-chat-container" style="display:none;">
        <div class="ai-chat-messages" id="modal-chat-messages"></div>
        <div class="ai-chat-input-area">
          <input type="text" class="ai-chat-input" id="modal-chat-input" placeholder="Ask a follow-up question...">
          <button class="ai-chat-send-btn" id="modal-chat-send" title="Send">➤</button>
        </div>
      </div>
    `;

    setTimeout(() => {
        const interactiveContainer = aiContainer.querySelector('#interactive-sentence-container');
        if (interactiveContainer) {
            this.renderInteractiveSentence(context, interactiveContainer, aiContainer.closest('.definition-modal-content'));
        }
    }, 0);

    content.appendChild(aiContainer);
    return content;
  }

  setupModalEventListeners(modal, word, context) {
    // Interactive Sentence Mode (Modal) handled by renderInteractiveSentence

    // AI Context Editing (Modal)
    const aiPanel = modal.querySelector('.tab-content[data-tab="ai"]');
    if (aiPanel) {
      const editBtn = aiPanel.querySelector('.edit-context-btn');
      const saveBtn = aiPanel.querySelector('.save-context-btn');
      const cancelBtn = aiPanel.querySelector('.cancel-context-btn');
      const displayWrap = aiPanel.querySelector('.context-edit-wrapper');
      const editorWrap = aiPanel.querySelector('.context-editor');
      const textarea = aiPanel.querySelector('.context-textarea');
      const textSpan = aiPanel.querySelector('.context-text');

      if (editBtn) {
        editBtn.addEventListener('click', () => {
          displayWrap.style.display = 'none';
          editorWrap.style.display = 'block';
          textarea.focus();
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          displayWrap.style.display = 'block';
          editorWrap.style.display = 'none';
          textarea.value = context;
        });
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', () => {
          const newContext = textarea.value.trim();
          if (newContext) {
            context = newContext; // This updates the closure variable
            textSpan.textContent = `"${newContext}"`;
            displayWrap.style.display = 'block';
            editorWrap.style.display = 'none';
            console.log('[CONTEXT] Manually updated context in modal:', newContext);
          }
        });
      }
    }

    const themeBtn = modal.querySelector('.modal-theme-btn');
    if (themeBtn) {
      themeBtn.textContent = this.darkMode ? '☀️' : '🌙';
      themeBtn.addEventListener('click', () => {
        const contentDiv = modal.querySelector('.definition-modal-content');
        const nextDarkMode = !contentDiv.classList.contains('dark-mode');
        contentDiv.classList.toggle('dark-mode', nextDarkMode);
        themeBtn.textContent = nextDarkMode ? '☀️' : '🌙';
        this.darkMode = nextDarkMode;
        if (this.sidebarContainer) {
          this.sidebarContainer.classList.toggle('dark-mode', nextDarkMode);
        }
        chrome.storage.sync.set({ darkMode: nextDarkMode });
      });
    }

    modal.querySelector('.close-btn').addEventListener('click', () => {
      modal.remove();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });

    modal.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tabName = e.target.getAttribute('data-tab');
        this.switchTab(modal, tabName);
      });
    });

    const aiBtn = modal.querySelector('#get-ai-definition');
    if (aiBtn) {
      aiBtn.addEventListener('click', () => {
        const targetWord = aiBtn.getAttribute('data-target-word') || word;
        
        // Disable button during call
        aiBtn.disabled = true;
        aiBtn.textContent = '⏳ Getting AI definition...';
        aiBtn.style.opacity = '0.6';
        
        this.conversationHistory = [];
        this.getAIDefinition(targetWord, context, modal);
      });
    }

    // Chat follow-up (modal)
    const chatSendBtn = modal.querySelector('#modal-chat-send');
    const chatInput = modal.querySelector('#modal-chat-input');
    if (chatSendBtn && chatInput) {
      const sendChat = () => {
        const message = chatInput.value.trim();
        if (!message) return;
        chatInput.value = '';
        const messagesDiv = modal.querySelector('#modal-chat-messages');
        this.sendChatFollowUp(message, messagesDiv, word, context);
      };
      chatSendBtn.addEventListener('click', sendChat);
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
      });
    }

    const escHandler = (e) => {
      if (e.key === 'Escape' && document.getElementById('definition-modal')) {
        modal.remove();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  switchTab(modal, tabName) {
    console.log('🔄 SWITCHING TO TAB:', tabName);

    const allTabBtns = modal.querySelectorAll('.tab-btn');
    allTabBtns.forEach(btn => {
      btn.classList.remove('active');
    });

    const activeTabBtn = modal.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (activeTabBtn) {
      activeTabBtn.classList.add('active');
    }

    const allTabContent = modal.querySelectorAll('.tab-content');
    allTabContent.forEach(content => {
      content.classList.remove('active');
      content.style.display = 'none';
      content.style.opacity = '0';
    });

    const activeContent = modal.querySelector(`.tab-content[data-tab="${tabName}"]`);
    if (activeContent) {
      activeContent.classList.add('active');
      activeContent.style.display = 'block';
      activeContent.style.opacity = '1';
      activeContent.style.visibility = 'visible';
      activeContent.style.zIndex = '10';

      activeContent.offsetHeight;

      console.log(`✅ SHOWN: ${tabName}`);
    } else {
      console.error(`❌ Tab content for ${tabName} not found`);
    }
  }

  async getAIDefinition(word, context, modal) {
    const responseDiv = modal.querySelector('#ai-response');
    const provider = modal.querySelector('#ai-provider').value;

    responseDiv.innerHTML = '<div class="loading">Getting AI definition...</div>';

    try {
      const aiBtn = modal.querySelector('#get-ai-definition');
      if (aiBtn) aiBtn.style.display = 'none';
      responseDiv.style.display = 'block';
      
      if (provider === 'mistral') {
        await this.getMistralDefinition(word, context, responseDiv, () => {
          const chatContainer = modal.querySelector('#modal-ai-chat');
          if (chatContainer) chatContainer.style.display = 'block';
          
          // Restore button state in modal
          const aiBtn = modal.querySelector('#get-ai-definition');
          if (aiBtn) {
            aiBtn.disabled = false;
            const currentWord = aiBtn.getAttribute('data-target-word') || word;
            aiBtn.textContent = 'Get AI Definition for "' + currentWord + '"';
            aiBtn.style.opacity = '1';
          }
        });
      } else if (provider === 'custom') {
        await this.getCustomLlmDefinition(word, context, responseDiv, () => {
          const chatContainer = modal.querySelector('#modal-ai-chat');
          if (chatContainer) chatContainer.style.display = 'block';
        });
      } else {
        const prompt = `
          Please analyze the word "${word}" in this context: "${context}"
          
          Provide:
          1. The meaning of "${word}" as used in this specific context
          2. Alternative meanings if any
          3. Example sentences using the word
          4. Any cultural or contextual nuances
          
          Be concise but thorough.
        `;

        responseDiv.innerHTML = `
          <div class="ai-prompt">
            <strong>Analysis Request for ${provider}:</strong><br>
            ${prompt}
          </div>
          <div class="ai-note">
            <strong>Note:</strong> This extension currently shows a demo interface for ${provider}. To enable actual functionality, you would need to:
            <br>• Add your API key for ${provider}
            <br>• Implement the API integration
            <br>• Configure the backend service
            <br><br>
            The word "<strong>${word}</strong>" was detected in the context: "<em>${context}</em>"
            <br><br>
            <strong>Mistral AI is fully functional!</strong>
          </div>
        `;
      }

    } catch (error) {
      responseDiv.innerHTML = `<div class="error">Error getting AI definition: ${error.message}</div>`;
    }
  }

  async getMistralDefinition(word, context, responseDiv, onComplete) {
    const apiKey = this.mistralApiKey;
    const API_URL = 'https://api.mistral.ai/v1/chat/completions';

    // Check cache first
    if (this.currentAnalysis && this.currentAnalysis.word === word && this.currentAnalysis.context === context && this.currentAnalysis.responseHtml) {
      console.log('[AI-CACHE] Returning cached response for:', word);
      responseDiv.innerHTML = this.currentAnalysis.responseHtml;
      if (onComplete) onComplete();
      return;
    }

    const isArticleContext = !this.currentSubtitle && (!this.subtitleHistory || this.subtitleHistory.length === 0);
    const preamble = isArticleContext
      ? `I'm reading an article or webpage and need help understanding a word in context.`
      : `I'm watching a video with subtitles and need help understanding a word in context.`;
    let configuredLanguagesStr = 'Any language';
    if (this.languageMappings && this.languageMappings.length > 0) {
        configuredLanguagesStr = this.languageMappings.map(m => m.language).join(', ');
    }
    const responseLanguage = (this.aiResponseLanguage || 'English').trim() || 'English';

    const prompt = `${preamble}

Word to analyze: "${word}"

Extended context (previous sentences + current context): "${context}"

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

    // Store the initial user message in conversation history
    this.conversationHistory = [{ role: 'user', content: prompt }];

    try {
      console.log('Sending request to Mistral AI API...');

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'mistral-small-latest',
          messages: this.conversationHistory,
          max_tokens: 1000,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Mistral AI API Error:', response.status, errorText);

        responseDiv.innerHTML = `
          <div class="error">
            <h5>❌ Mistral AI API Error</h5>
            <p><strong>Error:</strong> ${response.status} - ${errorText}</p>
            <p><strong>Word:</strong> "${word}"</p>
            <p><strong>Context:</strong> "${context}"</p>
            <div class="error-details">
              <p><strong>Setup Instructions:</strong></p>
              <ul>
                <li>Sign up for Mistral AI API at <a href="https://console.mistral.ai/" target="_blank">console.mistral.ai</a></li>
                <li>Get your API key from the dashboard</li>
                <li>Replace 'your-mistral-api-key-here' in the code with your actual API key</li>
                <li>Note: For production use, API keys should be stored securely on a backend server</li>
              </ul>
            </div>
          </div>
        `;
        return;
      }

      const result = await response.json();
      console.log('Mistral AI API Response:', result);

      if (result.error) {
        throw new Error(result.error.message || 'API returned an error');
      }

      if (!result.choices || result.choices.length === 0) {
        throw new Error('No response generated by the AI model');
      }

      const generatedText = result.choices[0].message.content;

      // Store assistant response in conversation history
      this.conversationHistory.push({ role: 'assistant', content: generatedText });

      const formattedResponse = this.formatAIResponse(generatedText, word, context);

      const responseHtml = `
        <div class="ai-success">
          <div class="ai-response-header">
            <h5>🤖 Mistral AI Analysis</h5>
            <span class="response-time">Model: mistral-small-latest</span>
          </div>
          <div class="ai-response-content mistral-formatted">
            ${formattedResponse}
          </div>
          <div class="ai-metadata">
            <small>Tokens used: ${result.usage?.total_tokens || 'N/A'} | Response time: ${new Date().toLocaleTimeString()}</small>
          </div>
        </div>
      `;

      responseDiv.innerHTML = responseHtml;

      // Cache the result
      this.currentAnalysis = {
        word: word,
        context: context,
        aiResponse: generatedText,
        responseHtml: responseHtml
      };

      console.log('[AI-CACHE] Analysis cached for:', word);

      // Call the onComplete callback to reveal the chat input
      if (onComplete) onComplete();

    } catch (error) {
      console.error('Error calling Mistral AI API:', error);

      responseDiv.innerHTML = `
        <div class="error">
          <h5>❌ Mistral AI Setup Required</h5>
          <p><strong>Error:</strong> ${error.message}</p>
          <p><strong>Word:</strong> "${word}"</p>
          <p><strong>Context:</strong> "${context}"</p>
          <div class="error-details">
            <p><strong>To enable Mistral AI:</strong></p>
            <ol>
              <li>Get your API key from <a href="https://console.mistral.ai/" target="_blank">Mistral AI Console</a></li>
              <li>Replace <code>your-mistral-api-key-here</code> in content.js with your actual API key</li>
              <li>For production: Move API calls to a secure backend server</li>
            </ol>
            <p><strong>Current Implementation:</strong> Client-side API call (not recommended for production)</p>
            <p><strong>Recommended:</strong> Use a backend service to proxy API calls and protect your API key</p>
          </div>
        </div>
      `;
    }
  }

  // Chat follow-up — send a follow-up message in the same conversation
  async sendChatFollowUp(message, messagesDiv, word, context) {
    // Determine which API to use based on current provider setting
    const isCustom = this.aiProvider === 'custom';
    const API_URL = isCustom ? this.customLlmUrl : 'https://api.mistral.ai/v1/chat/completions';
    const API_KEY = isCustom ? this.customLlmApiKey : this.mistralApiKey;
    const MODEL = isCustom ? this.customLlmModel : 'mistral-small-latest';

    // Add user message to UI
    const userBubble = document.createElement('div');
    userBubble.className = 'ai-chat-msg user';
    userBubble.textContent = message;
    messagesDiv.appendChild(userBubble);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Add to conversation history
    this.conversationHistory.push({ role: 'user', content: message });

    // Show loading
    const loadingBubble = document.createElement('div');
    loadingBubble.className = 'ai-chat-msg assistant';
    loadingBubble.innerHTML = '<em>Thinking...</em>';
    messagesDiv.appendChild(loadingBubble);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          messages: this.conversationHistory,
          max_tokens: 800,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      const assistantText = result.choices?.[0]?.message?.content || 'No response.';

      // Store in conversation history
      this.conversationHistory.push({ role: 'assistant', content: assistantText });

      // Replace loading bubble with actual response
      const formatted = this.formatAIResponse(assistantText, word, context);
      loadingBubble.innerHTML = `<div class="mistral-formatted">${formatted}</div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

    } catch (error) {
      loadingBubble.innerHTML = `<em style="color:#dc3545;">Error: ${error.message}</em>`;
    }
  }

  // Standalone freeform chat — no word-specific prompt, just a simple conversation
  async sendChatMessage(message, messagesDiv) {
    const isCustom = this.aiProvider === 'custom';
    const API_URL = isCustom ? this.customLlmUrl : 'https://api.mistral.ai/v1/chat/completions';
    const API_KEY = isCustom ? this.customLlmApiKey : this.mistralApiKey;
    const MODEL = isCustom ? this.customLlmModel : 'mistral-small-latest';

    // Add user message to UI
    const userBubble = document.createElement('div');
    userBubble.className = 'ai-chat-msg user';
    userBubble.textContent = message;
    messagesDiv.appendChild(userBubble);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Add to freeform chat history (no definition prompt)
    this.freeformChatHistory.push({ role: 'user', content: message });

    // Show loading
    const loadingBubble = document.createElement('div');
    loadingBubble.className = 'ai-chat-msg assistant';
    loadingBubble.innerHTML = '<em>Thinking...</em>';
    messagesDiv.appendChild(loadingBubble);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      console.log('[CHAT] Sending freeform chat, history length:', this.freeformChatHistory.length);
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          messages: this.freeformChatHistory,
          max_tokens: 800,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();
      const assistantText = result.choices?.[0]?.message?.content || 'No response.';

      // Store in freeform history
      this.freeformChatHistory.push({ role: 'assistant', content: assistantText });

      // Replace loading bubble with actual response
      const formatted = this.convertMarkdownToHtml(assistantText);
      loadingBubble.innerHTML = `<div class="mistral-formatted">${formatted}</div>`;
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

    } catch (error) {
      console.error('[CHAT] Freeform chat error:', error);
      loadingBubble.innerHTML = `<em style="color:#dc3545;">Error: ${error.message}</em>`;
    }
  }

  // Custom LLM definition — uses user-configured OpenAI-compatible endpoint
  async getCustomLlmDefinition(word, context, responseDiv, onComplete) {
    if (!this.customLlmUrl || !this.customLlmApiKey || !this.customLlmModel) {
      responseDiv.innerHTML = `
        <div class="error">
          <h5>⚠️ Custom LLM Not Configured</h5>
          <p>Go to <strong>Settings</strong> and fill in the Custom LLM fields:</p>
          <ul>
            <li>API URL (e.g. <code>https://api.openai.com/v1/chat/completions</code>)</li>
            <li>API Key</li>
            <li>Model Name (e.g. <code>gpt-4o-mini</code>)</li>
          </ul>
        </div>
      `;
      return;
    }

    let configuredLanguagesStr = 'Any language';
    if (this.languageMappings && this.languageMappings.length > 0) {
        configuredLanguagesStr = this.languageMappings.map(m => m.language).join(', ');
    }
    const responseLanguage = (this.aiResponseLanguage || 'English').trim() || 'English';

    const prompt = `I'm watching a video with subtitles and need help understanding a word in context.

Word to analyze: "${word}"
Extended context: "${context}"

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

    this.conversationHistory = [{ role: 'user', content: prompt }];

    try {
      responseDiv.innerHTML = '<div class="loading">Getting Custom LLM definition...</div>';

      const response = await fetch(this.customLlmUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.customLlmApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.customLlmModel,
          messages: this.conversationHistory,
          max_tokens: 1000,
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status} - ${errorText}`);
      }

      const result = await response.json();
      const generatedText = result.choices?.[0]?.message?.content;

      if (!generatedText) throw new Error('No response from Custom LLM');

      this.conversationHistory.push({ role: 'assistant', content: generatedText });

      const formatted = this.formatAIResponse(generatedText, word, context);

      responseDiv.innerHTML = `
        <div class="ai-success">
          <div class="ai-response-header">
            <h5>🔧 Custom LLM Analysis</h5>
            <span class="response-time">Model: ${this.customLlmModel}</span>
          </div>
          <div class="ai-response-content mistral-formatted">
            ${formatted}
          </div>
          <div class="ai-metadata">
            <small>Tokens used: ${result.usage?.total_tokens || 'N/A'} | Response time: ${new Date().toLocaleTimeString()}</small>
          </div>
        </div>
      `;

      if (onComplete) onComplete();

    } catch (error) {
      responseDiv.innerHTML = `
        <div class="error">
          <h5>❌ Custom LLM Error</h5>
          <p><strong>Error:</strong> ${error.message}</p>
          <p>Check your Custom LLM settings (URL, API Key, Model) in the Settings page.</p>
        </div>
      `;
    }
  }

  formatAIResponse(text, word) {
    const structured = this.extractStructuredAiData(text);
    if (structured) {
      return this.formatStructuredAiResponse(structured);
    }

    let cleaned = text.trim();

    cleaned = this.convertMarkdownToHtml(cleaned);

    const paragraphs = cleaned.split('\n').filter(p => p.trim());

    let formatted = '';

    paragraphs.forEach(paragraph => {
      const trimmed = paragraph.trim();
      if (!trimmed) return;

      if (trimmed.match(/^#{2,3}\s+/)) {
        const headerText = trimmed.replace(/^#{2,3}\s+/, '');
        formatted += `<div class="definition-section"><h6>${headerText}</h6></div>`;
      }
      else if (trimmed.match(/^\d+\./)) {
        formatted += `<div class="definition-point">${trimmed}</div>`;
      }
      else if (trimmed.match(/^-\s+/)) {
        const bulletText = trimmed.replace(/^-\s+/, '');
        formatted += `<div class="definition-point">• ${bulletText}</div>`;
      }
      else if (trimmed.includes(':') && trimmed.length < 100 && !trimmed.includes(word) && trimmed.endsWith(':')) {
        formatted += `<div class="definition-section"><h6>${trimmed}</h6></div>`;
      }
      else if (trimmed.match(/^---+$/)) {
        formatted += `<hr style="margin: 12px 0; border: none; border-top: 1px solid #e9ecef;">`;
      }
      else {
        formatted += `<p class="definition-content">${trimmed}</p>`;
      }
    });

    if (formatted.length < text.length * 0.3) {
      formatted = `<div class="definition-content">${cleaned.replace(/\n/g, '<br>')}</div>`;
    }

    return formatted || `<div class="definition-content">${cleaned}</div>`;
  }

  extractStructuredAiData(aiResponseText) {
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
        // Keep trying fallback candidates.
      }
    }

    return null;
  }

  normalizeAiList(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.map(v => String(v || '').trim()).filter(Boolean);
    }
    return String(value)
      .split(/\n|;/)
      .map(v => v.replace(/^[-*•]\s*/, '').trim())
      .filter(Boolean);
  }

  formatStructuredAiResponse(data) {
    const detectedLanguage = data.detectedLanguage || 'Unknown';
    const partOfSpeech = data.partOfSpeech || 'unknown';
    const phonetics = data.phonetics || '';
    const meaning = data.meaningInContext || '';
    const alternatives = this.normalizeAiList(data.alternativeMeanings);
    const examples = this.normalizeAiList(data.exampleSentences);
    const nuances = data.culturalNuances || '';
    const visual = typeof data.isVisual === 'boolean' ? (data.isVisual ? 'Yes' : 'No') : '';
    const visualQuery = data.visualQuery || '';

    let conjugationHtml = '';
    if (data.verbConjugation && Array.isArray(data.verbConjugation.rows) && data.verbConjugation.rows.length > 0) {
      const headers = Array.isArray(data.verbConjugation.headers) ? data.verbConjugation.headers : [];
      const rows = data.verbConjugation.rows;
      conjugationHtml = '<table><thead><tr>'
        + headers.map(h => `<th>${h}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(row => `<tr>${(Array.isArray(row) ? row : [row]).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>';
    }

    let html = '';
    html += `<div class="definition-section"><h6>Language Detection</h6></div><p class="definition-content">${detectedLanguage}</p>`;
    html += `<div class="definition-section"><h6>Part of Speech</h6></div><p class="definition-content">${partOfSpeech}</p>`;
    if (phonetics) {
      html += `<div class="definition-section"><h6>Phonetics & Stress</h6></div><p class="definition-content">${phonetics}</p>`;
    }
    if (meaning) {
      html += `<div class="definition-section"><h6>Meaning in Context</h6></div><p class="definition-content">${meaning}</p>`;
    }
    if (alternatives.length > 0) {
      html += `<div class="definition-section"><h6>Alternative Meanings</h6></div>${alternatives.map(item => `<div class="definition-point">• ${item}</div>`).join('')}`;
    }
    if (examples.length > 0) {
      html += `<div class="definition-section"><h6>Example Sentences</h6></div>${examples.map(item => `<div class="definition-point">• ${item}</div>`).join('')}`;
    }
    if (nuances) {
      html += `<div class="definition-section"><h6>Cultural & Linguistic Nuances</h6></div><p class="definition-content">${nuances}</p>`;
    }
    if (visual || visualQuery) {
      html += `<div class="definition-section"><h6>Visual</h6></div><p class="definition-content">${visual}${visual && visualQuery ? ' - ' : ''}${visualQuery}</p>`;
    }
    if (conjugationHtml) {
      html += `<div class="definition-section"><h6>Verb Conjugation Table</h6></div>${conjugationHtml}`;
    }

    return html;
  }

  convertMarkdownToHtml(text) {
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');

    text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');

    text = text.replace(/`([^`]+)`/g, '<code style="background: #f8f9fa; padding: 2px 4px; border-radius: 3px; font-family: monospace; font-size: 90%;">$1</code>');

    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color: #007bff; text-decoration: none;">$1</a>');

    // Convert markdown tables to HTML tables
    const lines = text.split('\n');
    let inTable = false;
    let tableHtml = '';
    let resultLines = [];
    let headerDone = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.match(/^\|.+\|$/)) {
        if (line.match(/^\|[\s\-:|]+\|$/)) {
          headerDone = true;
          continue;
        }
        if (!inTable) {
          inTable = true;
          headerDone = false;
          tableHtml = '<table>';
        }
        const cells = line.split('|').filter(c => c.trim() !== '');
        const tag = !headerDone ? 'th' : 'td';
        const rowHtml = '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
        if (!headerDone) {
          tableHtml += '<thead>' + rowHtml + '</thead><tbody>';
          const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
          if (nextLine.match(/^\|[\s\-:|]+\|$/)) {
            headerDone = true;
            i++;
          } else {
            headerDone = true;
          }
        } else {
          tableHtml += rowHtml;
        }
      } else {
        if (inTable) {
          tableHtml += '</tbody></table>';
          resultLines.push(tableHtml);
          tableHtml = '';
          inTable = false;
          headerDone = false;
        }
        resultLines.push(line);
      }
    }
    if (inTable) {
      tableHtml += '</tbody></table>';
      resultLines.push(tableHtml);
    }

    text = resultLines.join('\n');
    text = text.replace(/\n\n/g, '\n');

    return text;
  }

  // Screenshot capture — hides extension UI before capture, restores after
  async downsampleScreenshotDataUrl(dataUrl, scale = 0.5) {
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

          // Single-pass drawImage is the fastest practical browser-side downsampling path.
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'low';
          ctx.drawImage(img, 0, 0, targetW, targetH);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        } catch (err) {
          console.warn('[SCREENSHOT] Downsample failed, using original image:', err);
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async captureScreenshot() {
    // Hide extension UI elements so they don't appear in the screenshot
    const modal = document.getElementById('definition-modal');
    const sidebar = this.sidebarContainer;
    const subtitleContainer = this.subtitleContainer;
    const elementsToHide = [modal, sidebar, subtitleContainer].filter(Boolean);

    // Store original opacities and hide
    const savedStyles = elementsToHide.map(el => {
      const orig = el.style.opacity;
      el.style.opacity = '0';
      return { el, orig };
    });

    // Wait for browser to repaint
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        console.log('[SCREENSHOT] Requesting captureVisibleTab...');
        chrome.runtime.sendMessage({ action: 'captureScreenshot' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('[SCREENSHOT] Runtime error:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            console.log('[SCREENSHOT] Success, data length:', response.dataUrl?.length);
            resolve(response.dataUrl);
          } else {
            console.error('[SCREENSHOT] Failed response:', response);
            reject(new Error(response?.error || 'Screenshot capture failed'));
          }
        });
      });
      const downsampled = await this.downsampleScreenshotDataUrl(dataUrl, 0.5);
      console.log('[SCREENSHOT] Downsampled data length:', downsampled?.length);
      return downsampled;
    } finally {
      // Restore opacities
      savedStyles.forEach(({ el, orig }) => {
        el.style.opacity = orig || '1';
      });
    }
  }

  // Lightweight POS detection from AI response text + suffix heuristics
  detectPartOfSpeech(word, aiResponseText) {
    const structured = this.extractStructuredAiData(aiResponseText);
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
    const lowerAI = (aiResponseText || '').toLowerCase();

    // 1. Explicit POS extraction from AI Line "2. Part of Speech: ..."
    // Look for one of the allowed types explicitly. Handle markdown bolding e.g. **Part of Speech**:
    const explicitPosMatch = aiResponseText.match(/(?:Part of Speech|Grammatical Category|POS)[^:]*:\s*(?:\[)?([a-zA-Z\s]+)(?:\])?/i);

    if (explicitPosMatch && explicitPosMatch[1]) {
      const rawPos = explicitPosMatch[1].toLowerCase().trim();

      // Map raw POS to standard types
      if (rawPos.includes('expression') || rawPos.includes('phrase') || rawPos.includes('idiom')) return { pos: 'expression', isItalianVerb: false };
      if (rawPos.includes('noun') || rawPos.includes('sostantivo')) return { pos: 'noun', isItalianVerb: false };
      if (rawPos.includes('verb') || rawPos.includes('verbo')) {
        // Check if it's Italian
        const isIt = /\b(italian|italiano)\b/i.test(lowerAI) ||
          (aiResponseText.includes('Conjugation Table') && aiResponseText.includes('io'));
        return { pos: 'verb', isItalianVerb: isIt };
      }
      if (rawPos.includes('adjective') || rawPos.includes('aggettivo')) return { pos: 'adjective', isItalianVerb: false };
      if (rawPos.includes('adverb') || rawPos.includes('avverbio')) return { pos: 'adverb', isItalianVerb: false };
      if (rawPos.includes('preposition') || rawPos.includes('preposizione')) return { pos: 'preposition', isItalianVerb: false };
      if (rawPos.includes('pronoun') || rawPos.includes('pronome')) return { pos: 'pronoun', isItalianVerb: false };
      if (rawPos.includes('conjunction') || rawPos.includes('congiunzione')) return { pos: 'conjunction', isItalianVerb: false };
      if (rawPos.includes('interjection') || rawPos.includes('interiezione')) return { pos: 'interjection', isItalianVerb: false };
    }

    // Check if Italian verb was detected by Mistral (conjugation table present)
    const hasConjugation = /\b(presente|passato prossimo|imperfetto|futuro)\b/i.test(aiResponseText)
      && /\b(io|tu|lui\/lei|noi|voi|loro)\b/i.test(aiResponseText);
    const isItalianVerb = hasConjugation || (/\bitalian\s*(verb|verbo)\b/i.test(lowerAI));

    if (isItalianVerb) return { pos: 'verb', isItalianVerb: true };

    // Search AI response for POS indicators near the word
    const posPatterns = [
      { pattern: /\b(verb|verbo)\b/i, pos: 'verb' },
      { pattern: /\b(noun|sostantivo|nome)\b/i, pos: 'noun' },
      { pattern: /\b(adjective|aggettivo)\b/i, pos: 'adjective' },
      { pattern: /\b(adverb|avverbio)\b/i, pos: 'adverb' },
      { pattern: /\b(pronoun|pronome)\b/i, pos: 'pronoun' },
      { pattern: /\b(preposition|preposizione)\b/i, pos: 'preposition' },
      { pattern: /\b(conjunction|congiunzione)\b/i, pos: 'conjunction' },
      { pattern: /\b(interjection|interiezione)\b/i, pos: 'interjection' },
    ];

    for (const { pattern, pos } of posPatterns) {
      if (pattern.test(lowerAI)) return { pos, isItalianVerb: false };
    }

    // Suffix heuristics (fallback)
    if (/(?:tion|sion|ment|ness|ity|ance|ence|er|or|ist|ism|dom)$/i.test(lowerWord)) return { pos: 'noun', isItalianVerb: false };
    if (/(?:ful|ous|ive|able|ible|al|ial|ent|ant|ic|ical|less)$/i.test(lowerWord)) return { pos: 'adjective', isItalianVerb: false };
    if (/(?:ly)$/i.test(lowerWord)) return { pos: 'adverb', isItalianVerb: false };
    if (/(?:ize|ise|ify|ate|en|ing|ed)$/i.test(lowerWord)) return { pos: 'verb', isItalianVerb: false };
    // Italian verb endings
    if (/(?:are|ere|ire|ato|uto|ito)$/i.test(lowerWord)) return { pos: 'verb', isItalianVerb: /(?:are|ere|ire)$/i.test(lowerWord) };

    return { pos: 'unknown', isItalianVerb: false };
  }

  // Extract phonetics from Mistral AI response text
  extractPhoneticsFromAI(aiResponseText) {
    if (!aiResponseText) return '';
    const structured = this.extractStructuredAiData(aiResponseText);
    if (structured?.phonetics) {
      return String(structured.phonetics).trim();
    }
    const text = aiResponseText;

    // Try to find "Phonetics & Stress" section
    const pattern = /(?:\*\*)?Phonetics(?: & Stress)?(?:\*\*)?[:\s]*(.+?)(?:\n|$)/i;
    const match = text.match(pattern);

    if (match && match[1]) {
      let phonetics = match[1].trim();
      // Strip markdown
      phonetics = phonetics.replace(/\*\*/g, '').replace(/\*/g, '');
      return phonetics;
    }

    return '';
  }

  // Extract the main meaning from Mistral AI response text
  extractMeaningFromAI(aiResponseText) {
    if (!aiResponseText) return '';
    const structured = this.extractStructuredAiData(aiResponseText);
    if (structured?.meaningInContext) {
      return String(structured.meaningInContext).trim();
    }
    const text = aiResponseText;

    // Try to find "Meaning in Context" section
    const meaningPatterns = [
      /(?:\*\*)?Meaning in Context(?:\*\*)?[:\s]*(.+?)(?:\n\n|\n(?:\d+\.|\*\*|#{2,}))/is,
      /(?:\*\*)?(?:The )?(?:specific )?meaning[^:]*(?:\*\*)?[:\s]*(.+?)(?:\n\n|\n(?:\d+\.|\*\*|#{2,}))/is,
      /(?:means?|refers? to|denotes?|signifies?)[:\s]+["']?([^"'\n.]+)/i,
    ];

    for (const pattern of meaningPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        let meaning = match[1].trim();
        // Strip markdown
        meaning = meaning.replace(/\*\*/g, '').replace(/\*/g, '').replace(/^[-•]\s*/, '');
        return meaning;
      }
    }

    // Fallback 1: take the first substantive sentence that contains the word or "means"
    const sentences = text.split(/[.\n]/).filter(s => s && s.trim().length > 10);
    for (const s of sentences) {
      if (/means?|refers?|denotes?|signif/i.test(s)) {
        let meaning = s.trim().replace(/\*\*/g, '').replace(/\*/g, '');
        return meaning;
      }
    }

    // Fallback 2: just take the first meaningful chunk of text
    const fallbackMeaning = sentences[0] ? sentences[0].trim().replace(/\*\*/g, '') : text;
    return fallbackMeaning || 'Definition not found.';
  }

  // Extract conjugation block/table HTML from AI response across conjugating languages
  extractConjugationFromAI(aiResponseText) {
    if (!aiResponseText) return null;

    const structured = this.extractStructuredAiData(aiResponseText);
    if (structured?.verbConjugation && Array.isArray(structured.verbConjugation.rows) && structured.verbConjugation.rows.length > 0) {
      const headers = Array.isArray(structured.verbConjugation.headers) ? structured.verbConjugation.headers : [];
      let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;">';
      if (headers.length > 0) {
        html += '<tr>';
        headers.forEach((header) => {
          html += `<th style="border:1px solid #808080;padding:3px 5px;font-weight:600;">${String(header)}</th>`;
        });
        html += '</tr>';
      }
      structured.verbConjugation.rows.forEach((row) => {
        const cells = Array.isArray(row) ? row : [row];
        html += '<tr>';
        cells.forEach((cell) => {
          html += `<td style="border:1px solid #808080;padding:3px 5px;">${String(cell)}</td>`;
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

    if (tableMatches.length) {
      const prioritized = tableMatches.slice().sort((a, b) => {
        const score = (text) => {
          const lower = text.toLowerCase();
          let s = 0;
          if (/\b(tense|conjugation|presente|passato|imperfetto|futuro|past|present|future|indicativo|subjuntivo|subjonctif)\b/i.test(lower)) s += 3;
          if (/\b(io|tu|lui\/lei|noi|voi|loro|yo|t[uú]|[ée]l|nosotros|vosotros|ellos|je|il\/elle|nous|vous|ils\/elles)\b/i.test(lower)) s += 2;
          if (((text.split('\n')[0].match(/\|/g)) || []).length >= 4) s += 1;
          return s;
        };
        return score(b) - score(a);
      });

      const rows = prioritized[0].trim().split('\n').filter(r => r.trim().startsWith('|'));
      if (rows.length >= 3) {
        let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:8px;">';
        rows.forEach((row, idx) => {
          if (/^\|[\s-|]+\|$/.test(row.trim())) return;
          const cells = row.split('|').filter(c => c.trim() !== '');
          const tag = idx === 0 ? 'th' : 'td';
          const headerStyles = idx === 0 ? 'font-weight:600;' : '';
          html += '<tr>';
          cells.forEach(cell => {
            html += `<${tag} style="border:1px solid #808080;padding:3px 5px;${headerStyles}">${cell.trim()}</${tag}>`;
          });
          html += '</tr>';
        });
        return html + '</table>';
      }
    }

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
    const escapedBlock = block.join('\n')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<div style="font-size:0.92em;line-height:1.45;white-space:pre-line;">${escapedBlock}</div>`;
  }

  // Extract the sentence containing the word from the context, and create a blanked version
  extractContextSentence(word, context) {
    if (!context || !word) return { original: '', blanked: '' };

    // Clean up the raw subtitle context: remove >> markers, collapse whitespace, deduplicate fragments
    let cleaned = context
      .replace(/>>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Split into sentences
    const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];

    // Find the sentence that contains the word (case-insensitive)
    const wordLower = word.toLowerCase();
    let bestSentence = '';
    for (const s of sentences) {
      if (s.toLowerCase().includes(wordLower)) {
        bestSentence = s.trim();
        break;
      }
    }

    // Fallback: if no sentence found, just use the cleaned context truncated
    if (!bestSentence) {
      bestSentence = cleaned.length > 150 ? cleaned.substring(0, 150) + '...' : cleaned;
    }

    // Deduplicate: if the same phrase repeats, keep only first occurrence
    const halfLen = Math.floor(bestSentence.length / 2);
    const firstHalf = bestSentence.substring(0, halfLen).trim();
    if (firstHalf.length > 20 && bestSentence.indexOf(firstHalf, halfLen - 10) > 0) {
      bestSentence = firstHalf;
      // Re-add punctuation if lost
      if (!/[.!?]$/.test(bestSentence)) bestSentence += '.';
    }

    // New cleaning heuristic: remove immediate repetitions of phrases (length > 5)
    // e.g. "Because it's... because it's..." -> "Because it's..."
    // Also handle "I mean... I mean..."
    const repeatPattern = /(.{5,}?)(?:[\s,.]+|\s*\.\.\.\s*)\1/i;
    let match = bestSentence.match(repeatPattern);
    while (match) {
      // Replace the repetition with just one instance (plus punctuation from before/after if needed, simplistically)
      // actually easier to just take the first part and the rest of the string after the repetition matches
      const repeatingPart = match[1];
      // We want to keep one instance. 
      // Logic: replace the full match with just the repeating part + space/dots?
      // Let's just remove the FIRST instance of the repetition in the match
      bestSentence = bestSentence.replace(match[0], repeatingPart);
      match = bestSentence.match(repeatPattern);
    }

    // Return original sentence (cleaned) - we will add cloze formatting in sendToAnki
    return { original: bestSentence };
  }

  // Helper to sanitize filenames for Anki (ASCII only, no special chars)
  sanitizeFilename(name) {
    // Remove extensions first to handle them separately? No, input is usually "prefix_word.jpg"
    // But here we might get just a string.
    // Let's replace non-alphanumeric chars (except . _ -) with _
    return name.replace(/[^a-z0-9._-]/gi, '_');
  }

  // Extract multiple example sentences from the AI response text (different from the context)
  extractExampleSentences(aiResponseText, word, limit = 3) {
    if (!aiResponseText) return [];

    const structured = this.extractStructuredAiData(aiResponseText);
    if (structured?.exampleSentences) {
      return this.normalizeAiList(structured.exampleSentences).slice(0, limit);
    }

    // Look for lines that look like example sentences
    // Better strategy: Find the "Example Sentences" section and take lines from there
    const examples = [];

    // Attempt to extract text within the Example Sentences section
    const sectionMatch = aiResponseText.match(/(?:Example Sentences|Esempi)(?:[:\s]+\n?|[:\s]+)([\s\S]*?)(?:\n\n|\n(?:[A-Z0-9]|#{2,})|$)/i);

    let sourceText = aiResponseText;
    if (sectionMatch && sectionMatch[1]) {
      sourceText = sectionMatch[1];
    }

    const lines = sourceText.split('\n');
    const wordLower = word.toLowerCase();
    const seen = new Set();

    for (const line of lines) {
      const trimmed = line.trim()
        .replace(/^[-•*]\s*/, '') // Remove bullets
        .replace(/^\d+\.\s*/, '') // Remove numbers
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/^["']|["']$/g, '')
        .trim();

      // Skip short lines, headers, or non-sentence lines
      if (trimmed.length < 15 || trimmed.length > 200) continue;
      if (/^(#|\||Meaning|Language|Part of Speech|Context|Alternative|Cultural|Nuance|Example|Note)/i.test(trimmed)) continue;

      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;

      // Prefer examples containing the lookup word, but still allow sentence-like lines from the examples section
      const looksLikeSentence = /[.!?]$/.test(trimmed) || trimmed.split(' ').length >= 6;
      if ((trimmed.toLowerCase().includes(wordLower) || looksLikeSentence) && !/^(#|\|)/.test(trimmed)) {
        seen.add(key);
        examples.push(trimmed);
        if (examples.length >= limit) break;
      }
    }

    return examples.slice(0, limit);
  }

  // Backward-compatible helper for existing call sites
  extractExampleSentence(aiResponseText, word) {
    const examples = this.extractExampleSentences(aiResponseText, word, 1);
    return examples[0] || '';
  }

  // Get POS abbreviation (n, v, adj, adv, etc.)
  getPosAbbreviation(pos) {
    const abbrevMap = {
      'noun': 'n.',
      'verb': 'v.',
      'adjective': 'adj.',
      'adverb': 'adv.',
      'pronoun': 'pron.',
      'preposition': 'prep.',
      'conjunction': 'conj.',
      'interjection': 'interj.',
      'expression': 'expr.',
      'phrase': 'expr.',
      'idiom': 'idiom'
    };
    return abbrevMap[pos] || '';
  }

  // Mask the target word in a text (replace with "The word" or "It")
  maskWordInText(text, word) {
    if (!text || !word) return text;
    // Case insensitive replacement
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    return text.replace(regex, "the word");
  }

  // Fetch a visual image from Google Custom Search (preferred) or Wikipedia (fallback)
  async fetchVisualImage(query) {
    if (!query) return null;

    // 1. Google Custom Search temporarily disabled.
    // if (this.googleApiKey && this.googleSearchEngineId) {
    //   console.log(`[IMAGE] Fetching from Google for: ${query}`);
    //   try {
    //     const url = `https://www.googleapis.com/customsearch/v1?key=${this.googleApiKey}&cx=${this.googleSearchEngineId}&q=${encodeURIComponent(query)}&searchType=image&num=1`;
    //     const response = await fetch(url);
    //     const data = await response.json();

    //     if (data.items && data.items.length > 0) {
    //       console.log('[IMAGE] Found Google image:', data.items[0].link);
    //       return {
    //         url: data.items[0].link,
    //         filename: `google_${query.replace(/\s+/g, '_')}.jpg`
    //       };
    //     } else {
    //       console.warn('[IMAGE] No results from Google, falling back...');
    //     }
    //   } catch (e) {
    //     console.error('[IMAGE] Google search error:', e);
    //   }
    // } else {
    //   console.log('[IMAGE] valid Google API Key or CX not found, skipping Google Search.');
    // }

    // 2. Fallback to Wikipedia
    try {
      console.log(`[IMAGE] Fetching from Wikipedia for: ${query}`);
      // Use Wikimedia Action API
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&format=json&piprop=original&origin=*&titles=${encodeURIComponent(query)}&redirects=1`;

      const response = await fetch(searchUrl);
      const data = await response.json();

      if (!data.query || !data.query.pages) return null;

      const pages = data.query.pages;
      const pageId = Object.keys(pages)[0];

      if (pageId === '-1') {
        // Try search if direct title check failed
        const searchOpUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&limit=1&search=${encodeURIComponent(query)}`;
        const searchRes = await fetch(searchOpUrl);
        const searchData = await searchRes.json();
        if (searchData[1] && searchData[1][0]) {
          return this.fetchVisualImage(searchData[1][0]); // Recurse with exact title (will try Google again, but that's fine/safe)
        }
        return null;
      }

      const page = pages[pageId];
      if (page.original && page.original.source) {
        console.log(`[IMAGE] Found: ${page.original.source}`);
        return {
          url: page.original.source,
          filename: `wiki_${query.replace(/\s+/g, '_')}.jpg`
        };
      }
      return null;
    } catch (e) {
      console.error('[IMAGE] Fetch failed:', e);
      return null;
    }
  }

  // AnkiConnect integration — Clean Cloze Deletion format
  async sendToAnki(word, definition, context, screenshot) {

    // Use cached AI response if available and matches
    let rawAIText = '';
    if (this.currentAnalysis && this.currentAnalysis.word === word) {
      console.log('[ANKI-CONTENT] Using cached AI response');
      rawAIText = this.currentAnalysis.aiResponse;
    } else {
      // If not cached, we might need to fetch it (if the user clicked "Add to Anki" directly without opening context)
      // But sendToAnki is usually called AFTER context is open or directly. 
      // If called directly, we might need to trigger AI analysis here if we want detailed fields.
      // For now, let's assume rawAIText can be grabbed from conversationHistory as fallback
      rawAIText = this.conversationHistory?.find(m => m.role === 'assistant')?.content || '';
    }

    // Check language detection from AI
    // Extract language directly from the Mistral AI "1. Language Detection" response
    // Look for the "Language" or "Language Detection" section in the AI response
    let detectedLanguage = '';
    const structured = this.extractStructuredAiData(rawAIText);
    if (structured?.detectedLanguage) {
      detectedLanguage = String(structured.detectedLanguage).trim().toLowerCase();
      console.log('[ANKI-CONTENT] AI structured detected language:', detectedLanguage);
    }
    const langSectionMatch = rawAIText.match(/(?:1\.\s*\**Language Detection\**|Language)\s*[:*]+(.*)/i);

    if (!detectedLanguage && langSectionMatch) {
      detectedLanguage = langSectionMatch[1].trim().toLowerCase();
      console.log('[ANKI-CONTENT] AI explicitly detected language:', detectedLanguage);
    } else if (!detectedLanguage) {
      console.log('[ANKI-CONTENT] AI language section missing');
    }

    let targetDeck = this.ankiDeck;
    if (this.languageMappings && this.languageMappings.length > 0) {
        const matchedMapping = this.languageMappings.find(m => detectedLanguage.includes(m.language.toLowerCase()));
        if (matchedMapping && matchedMapping.deck) {
            targetDeck = matchedMapping.deck;
            console.log(`[ANKI-CONTENT] Mapped detected language "${detectedLanguage}" to deck "${targetDeck}"`);
        }
    } else if (detectedLanguage.includes('italian') && this.ankiDeckItalian) {
        // Fallback for older configs
        targetDeck = this.ankiDeckItalian;
    }

    console.log('[ANKI-CONTENT] 📦 sendToAnki called for word:', word);
    console.log('[ANKI-CONTENT] Target Deck:', targetDeck, 'NoteType:', this.ankiNoteType);

    // Extract clean data from AI response
    // const rawAIText = this.conversationHistory?.find(m => m.role === 'assistant')?.content || ''; // Already defined above
    const aiSourceText = (rawAIText || definition || '').trim();
    const posInfo = this.detectPartOfSpeech(word, aiSourceText);
    const phonetics = this.extractPhoneticsFromAI(aiSourceText);

    let meaning = this.extractMeaningFromAI(aiSourceText, word);
    // Mask the word in the meaning to avoid spoilers
    if (meaning) {
      meaning = this.maskWordInText(meaning, word);
    }

    const conjugation = this.extractConjugationFromAI(aiSourceText);
    const exampleSentences = this.extractExampleSentences(aiSourceText, word, 3);

    // Get context sentence (cleaned)
    const { original: contextSentence } = this.extractContextSentence(word, context);

    console.log('[ANKI-CONTENT] POS:', posInfo, 'Meaning:', meaning?.substring(0, 50));
    console.log('[ANKI-CONTENT] Context sentence:', contextSentence);
    console.log('[ANKI-CONTENT] Example sentences:', exampleSentences);

    // POS abbreviation (n. / v. / adj. / adv.)
    const posAbbr = this.getPosAbbreviation(posInfo.pos);
    const posTag = posAbbr ? ` <i style="opacity:0.75;">${posAbbr}</i>` : '';

    // === PREPARE FIELDS BASED ON NOTE TYPE ===
    let fields = {};

    // Check if we should use Cloze deletion ({{c1::word}})
    const isCloze = (this.ankiNoteType || '').toLowerCase().includes('cloze');
    const mediaField = isCloze ? 'Extra' : 'Back';

    if (isCloze) {
      // Sentences with Cloze Deletion: "I am {{c1::going}} to the store."
      const clozeSentence = contextSentence ? contextSentence.replace(
        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
        `{{c1::${word}}}`
      ) : `{{c1::${word}}}`;

      // Formatting the Extra field (back of the card)
      let backExtra = '';

      // 1. The Word + Phonetics
      const phoneticsTag = phonetics ? ` <span style="font-family: Arial, sans-serif; font-weight: normal; margin-left: 8px;">${phonetics}</span>` : '';
      backExtra += `<div style="font-size:1.2em;margin-bottom:8px;"><b>${word}</b>${phoneticsTag}${posTag}</div>`;

      // 2. Meaning
      const rawMeaning = this.extractMeaningFromAI(aiSourceText, word);
      if (rawMeaning && rawMeaning !== 'Definition not found.') {
        backExtra += `<div style="margin-bottom:10px;"><b>Meaning:</b> ${rawMeaning}</div>`;
      }

      // 3. Example
      if (exampleSentences.length > 0) {
        const examplesHtml = exampleSentences
          .map((sentence) => `<div style="margin-top:4px;">- ${sentence}</div>`)
          .join('');
        backExtra += `<div style="margin-bottom:8px; font-style: italic; opacity:0.85;"><b>Examples:</b>${examplesHtml}</div>`;
      }

      // 4. Conjugation
      if (conjugation) {
        backExtra += `<div style="margin-top:10px; border-top: 1px solid #808080; padding-top:8px;"><b>Conjugation</b>${conjugation}</div>`;
      }

      fields = {
        Text: `<div style="font-size:1.15em; line-height:1.4;">${clozeSentence}</div>`,
        Extra: backExtra
      };
    } else {
      // Fallback for Basic (Front/Back)
      const blankedWord = '_______';
      let manualBlankedSentence = contextSentence ? contextSentence.replace(
        new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
        blankedWord
      ) : blankedWord;

      let front = `<div style="font-size:1.1em;line-height:1.5;margin-bottom:10px;">${manualBlankedSentence}</div>`;
      if (posAbbr || meaning) {
        front += `<div style="font-size:0.85em;margin-top:10px;opacity:0.75;"><b>${posTag}</b> ${meaning || ''}</div>`;
      }

      const phoneticsText = phonetics ? ` ${phonetics}` : '';
      let back = `<div style="font-size:1.3em;margin-bottom:12px;"><b>${word}</b>${phoneticsText}</div>`;
      const rawMeaning = this.extractMeaningFromAI(aiSourceText, word);
      if (rawMeaning) back += `<div style="margin-bottom:12px;">${rawMeaning}</div>`;
      if (exampleSentences.length > 0) {
        const examplesHtml = exampleSentences
          .map((sentence) => `<div style="margin-top:4px;">- ${sentence}</div>`)
          .join('');
        back += `<div style="margin-bottom:12px; font-style: italic; opacity:0.85;"><b>Examples:</b>${examplesHtml}</div>`;
      }
      if (contextSentence) back += `<div style="font-size:0.9em;opacity:0.8;"><i>${contextSentence}</i></div>`;
      if (conjugation) back += `<div style="margin-top:10px; border-top: 1px solid #808080; padding-top:8px;"><b>Conjugation</b>${conjugation}</div>`;

      fields = {
        Front: front,
        Back: back
      };
    }

    // Prepare media (screenshot + fetched image)
    const media = [];

    // 1. Screenshot
    // 1. Screenshot
    if (screenshot) {
      console.log('[ANKI-CONTENT] Screenshot available, attaching...');
      // Sanitize the filename
      const safeWord = this.sanitizeFilename(word);
      const mimeMatch = screenshot.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
      const filename = `subtitle_${safeWord}_${Date.now()}.${extension}`;

      media.push({
        data: screenshot.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ''),
        filename: filename,
        fields: [mediaField]
      });
    }

    // 2. Fetched Image (if word is visual)
    // Extract visual query from AI - Relaxed regex for markdown
    console.log('[ANKI-CONTENT] Checking for visual in AI text length:', rawAIText.length);

    // Matches "Visual" followed by optional markdown chars and colon, then value
    const visualMatch = rawAIText.match(/Visual(?:[\s*]*):(?:(?:\s|\*|\[)*)(Yes|Sì|True)/i);
    const queryMatch = rawAIText.match(/Visual Query(?:[\s*]*):(?:(?:\s|\*|\[)*)(.+)/i);

    if (visualMatch) console.log('[ANKI-CONTENT] Visual match found:', visualMatch[1]);
    if (queryMatch) console.log('[ANKI-CONTENT] Query match found:', queryMatch[1]);

    if (visualMatch && queryMatch && queryMatch[1]) {
      let query = queryMatch[1].trim();
      // Remove trailing markdown or brackets
      query = query.replace(/[\]*]+$/, '').trim();

      console.log('[ANKI-CONTENT] Fetching image for query:', query);
      const visualImage = await this.fetchVisualImage(query); // We need to await this!

      if (visualImage) {
        // Sanitize the filename for the visual image
        const safeFilename = this.sanitizeFilename(visualImage.filename);

        // We need to download it to base64 for AnkiConnect usually, or provide URL if allowed.
        // AnkiConnect allow 'url' in media options. 
        media.push({
          url: visualImage.url,
          filename: safeFilename,
          fields: [mediaField]
        });
      }
    } else {
      console.log('[ANKI-CONTENT] Not visual or no query found');
    }

    const ankiPayload = {
      action: 'addNote',
      version: 6,
      params: {
        note: {
          deckName: targetDeck, // Use targetDeck here
          modelName: this.ankiNoteType,
          fields: fields,
          options: {
            allowDuplicate: false,
            duplicateScope: 'deck'
          },
          tags: ['interactive-subtitles'],
          ...(media.length > 0 ? { picture: media } : {})
        }
      }
    };

    if (media.length > 0) {
      console.log('[ANKI-CONTENT] 📸 Attaching media:', JSON.stringify(media).substring(0, 500));
    } else {
      console.warn('[ANKI-CONTENT] ⚠️ No media attached!');
    }

    console.log('[ANKI-CONTENT] Sending ankiRequest to background, payload action:', ankiPayload.action);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'ankiRequest', payload: ankiPayload },
        (response) => {
          console.log('[ANKI-CONTENT] Got response from background:', response);
          console.log('[ANKI-CONTENT] chrome.runtime.lastError:', chrome.runtime.lastError);
          if (chrome.runtime.lastError) {
            console.error('[ANKI-CONTENT] ❌ Runtime error:', chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.success) {
            console.log('[ANKI-CONTENT] ✅ Note added, ID:', response.result);
            resolve({ success: true, noteId: response.result });
          } else {
            console.error('[ANKI-CONTENT] ❌ Failed:', response?.error);
            reject(new Error(response?.error || 'Anki request failed'));
          }
        }
      );
    });
  }

  async handleAddToAnki(word, context, container) {
    console.log('[ANKI-CONTENT] 🎯 handleAddToAnki called for word:', word);
    const statusEl = container.querySelector('#anki-status') || container.querySelector('.anki-status') || container.querySelector('#sidebar-anki-status');
    const btn = container.querySelector('#anki-add-btn, #sidebar-anki-btn');

    // Check screenshot checkbox
    const screenshotCb = container.querySelector('#modal-screenshot-cb, #sidebar-screenshot-cb');
    this.includeScreenshot = screenshotCb ? screenshotCb.checked : this.getDefaultScreenshotEnabled();

    if (btn) btn.disabled = true;

    try {
      // Capture screenshot only if checkbox is checked
      let screenshot = null;
      if (this.includeScreenshot) {
        if (statusEl) statusEl.textContent = 'Capturing screenshot...';
        try {
          screenshot = await this.captureScreenshot();
          console.log('[ANKI-CONTENT] Screenshot captured successfully');
        } catch (e) {
          console.warn('[ANKI-CONTENT] Screenshot capture failed, proceeding without it:', e);
        }
      }

      if (statusEl) statusEl.textContent = 'Sending to Anki...';

      // Check if we have an AI response. If not, we MUST fetch it first.
      let aiResponseContent = container.querySelector('.ai-response-content, #sidebar-ai-response')?.innerText;

      // If no AI content or it's empty, or it's just the initial "Word: ... Context: ..." fallback
      const hasValidAIResponse = aiResponseContent &&
        !aiResponseContent.includes('Getting AI definition') &&
        aiResponseContent.length > 20;

      if (!hasValidAIResponse) {
        console.log('[ANKI-CONTENT] No existing AI response found. Fetching Mistral definition explicitly...');
        if (statusEl) statusEl.textContent = 'Analysing word with AI first...';

        if (btn) {
          btn.textContent = '🤖 Analysing...';
        }

        // We must create a dummy div that has innerHTML to catch loading errors,
        // and we pass it to getMistralDefinition, which depends on modifying its innerHTML.
        const dummyDiv = document.createElement('div');
        dummyDiv.innerHTML = '<div class="loading"></div>';

        try {
          await this.getMistralDefinition(word, context, dummyDiv);
          console.log('[ANKI-CONTENT] AI Analysis step complete.');
        } catch (e) {
          console.warn('[ANKI-CONTENT] AI Analysis failed or timed out', e);
        }

        if (statusEl) statusEl.textContent = 'Sending to Anki...';
      }

      // Re-fetch definition after potential AI call
      // If we just fetched it, grab it from the cached analysis, otherwise fallback to UI.
      const aiResponse = container.querySelector('.ai-response-content, #sidebar-ai-response');
      let definition = `Word: ${word}\nContext: ${context}`;

      if (this.currentAnalysis && this.currentAnalysis.word === word) {
        definition = this.currentAnalysis.aiResponse;
      } else if (aiResponse && aiResponse.innerHTML.length > 20) {
        definition = aiResponse.innerHTML;
      }

      console.log('[ANKI-CONTENT] Definition length:', definition.length);

      const result = await this.sendToAnki(word, definition, context, screenshot);
      console.log('[ANKI-CONTENT] ✅ sendToAnki resolved:', result);

      if (statusEl) {
        statusEl.textContent = '✅ Added to Anki!';
        statusEl.style.color = '#28a745';
      }
      if (btn) {
        btn.textContent = '✅ Added!';
        btn.style.background = '#28a745';
      }
    } catch (error) {
      console.error('[ANKI-CONTENT] ❌ handleAddToAnki error:', error.message);
      const errorMsg = error.message.includes('Extension context invalidated')
        ? 'Extension was reloaded. Refresh this tab, then try Add to Anki again.'
        : error.message.includes('Failed to fetch')
        ? 'Anki not running or AnkiConnect not installed'
        : error.message;
      if (statusEl) {
        statusEl.textContent = `❌ ${errorMsg}`;
        statusEl.style.color = '#dc3545';
      }
      if (btn) btn.disabled = false;
    }
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      console.log('Received message:', request);

      if (request.action === 'toggle') {
        this.enabled = !this.enabled;
        console.log('Extension toggled:', this.enabled);

        if (!this.enabled) {
          this.subtitleContainer.style.display = 'none';
          if (this.sidebarContainer) this.sidebarContainer.style.display = 'none';
          const existingModal = document.getElementById('definition-modal');
          if (existingModal) {
            existingModal.remove();
          }

          // Clean up intervals when disabled
          if (this.pauseCheckInterval) {
            clearInterval(this.pauseCheckInterval);
            this.pauseCheckInterval = null;
          }
        } else {
          // When enabling, restart everything
          if (this.platform === 'amazon') {
            this.createInteractiveContainer();
          }
          this.startPauseDetection();
        }
        sendResponse({ enabled: this.enabled });
      } else if (request.action === 'setEnabled') {
        this.enabled = Boolean(request.enabled);
        console.log('Extension globally set to:', this.enabled);

        if (!this.enabled) {
          this.subtitleContainer.style.display = 'none';
          if (this.sidebarContainer) this.sidebarContainer.style.display = 'none';
          const existingModal = document.getElementById('definition-modal');
          if (existingModal) {
            existingModal.remove();
          }

          if (this.pauseCheckInterval) {
            clearInterval(this.pauseCheckInterval);
            this.pauseCheckInterval = null;
          }
        } else {
          if (this.platform === 'amazon') {
            this.createInteractiveContainer();
          }
          this.startPauseDetection();
        }
        sendResponse({ enabled: this.enabled });
      } else if (request.action === 'updateDarkMode') {
        const enabled = Boolean(request.enabled);
        this.darkMode = enabled;

        document.querySelectorAll('.definition-modal-content').forEach((el) => {
          el.classList.toggle('dark-mode', enabled);
        });

        document.querySelectorAll('.modal-theme-btn').forEach((btn) => {
          btn.textContent = enabled ? '☀️' : '🌙';
        });

        if (this.sidebarContainer) {
          this.sidebarContainer.classList.toggle('dark-mode', enabled);
        }

        sendResponse({ success: true, darkMode: enabled });
      } else if (request.action === 'getStatus') {
        sendResponse({ enabled: this.enabled });
      } else if (request.action === 'pageUpdated') {
        console.log('Page updated, reinitializing...');
        this.createInteractiveContainer();
        if (this.platform === 'amazon') {
          this.setupAmazonPrimeEnhancements();
        }
        sendResponse({ status: 'reinitialized' });
      } else if (request.action === 'updateDisplayMode') {
        this.displayMode = request.mode;
        console.log('Display mode updated to:', this.displayMode);
        sendResponse({ success: true });
      } else if (request.action === 'updateAnkiSettings') {
        if (request.deck) this.ankiDeck = request.deck;
        if (request.languageMappings) this.languageMappings = request.languageMappings;
        if (request.noteType) this.ankiNoteType = request.noteType;
        console.log('Anki settings updated:', this.ankiDeck, this.ankiDeckItalian, this.ankiNoteType);
        sendResponse({ success: true });
      } else if (request.action === 'updateImageSettings') {
        // Google image API update path temporarily disabled.
        // if (request.googleApiKey !== undefined) this.googleApiKey = request.googleApiKey;
        // if (request.googleSearchEngineId !== undefined) this.googleSearchEngineId = request.googleSearchEngineId;
        // console.log('Image settings updated');
        sendResponse({ success: true });
      } else if (request.action === 'contextMenuTranslate') {
        const word = String(request.word || '').trim();
        const passedContext = String(request.context || '').trim();

        if (!word) {
          sendResponse({ success: false, error: 'No selected word received' });
          return;
        }

        // Smart context extraction: use article-aware method for rich paragraph context
        let context = '';
        if (passedContext && passedContext.toLowerCase().includes(word.toLowerCase())) {
          console.log('[CONTEXT] Using context captured immediately via background script');
          context = this.formatSentenceContext(passedContext, word);
        } else {
          context = this.getArticleContext(word);
        }

        console.log('Context menu translate:', word, context);

        if (this.displayMode === 'sidebar') {
          this.showDefinitionInSidebar(word, context, null);
        } else {
          this.showDefinitionModal(word, context, null);
        }
        sendResponse({ success: true });
      } else if (request.action === 'getAIDefinition') {
        const { word, context } = request;
        const dummyDiv = document.createElement('div');
        this.getMistralDefinition(word, context, dummyDiv).then(() => {
          sendResponse({
            definition: dummyDiv.innerHTML,
            rawText: this.currentAnalysis?.aiResponse || ''
          });
        }).catch(err => {
          sendResponse({ error: err.message });
        });
        return true; // async
      }
    });

    window.interactiveSubtitles = this;
  }

  // Cleanup method for proper disposal
  cleanup() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    if (this.pauseCheckInterval) {
      clearInterval(this.pauseCheckInterval);
      this.pauseCheckInterval = null;
    }

    if (this.subtitleClearTimeout) {
      clearTimeout(this.subtitleClearTimeout);
      this.subtitleClearTimeout = null;
    }

    if (this.subtitleDisplayTimeout) {
      clearTimeout(this.subtitleDisplayTimeout);
      this.subtitleDisplayTimeout = null;
    }

    if (this.amazonObserver) {
      this.amazonObserver.disconnect();
      this.amazonObserver = null;
    }

    if (this.subtitleContainer) {
      this.subtitleContainer.remove();
      this.subtitleContainer = null;
    }

    console.log('Interactive Subtitles cleaned up');
  }
}

// Initialize when page loads
let currentInstance = null;

function initializeSubtitles() {
  // Clean up previous instance
  if (currentInstance) {
    currentInstance.cleanup();
  }

  currentInstance = new InteractiveSubtitles();
  console.log('Interactive Subtitles initialized');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSubtitles);
} else {
  initializeSubtitles();
}

// Handle dynamic page changes (SPA navigation) with better detection
let lastUrl = location.href;
let navigationTimeout = null;

const handleNavigation = () => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    console.log('Page navigation detected', url);

    if (navigationTimeout) {
      clearTimeout(navigationTimeout);
    }

    // Delay reinitialization to let the page settle
    navigationTimeout = setTimeout(() => {
      // If we have an instance, we might need to "re-check" settings for the new URL
      if (currentInstance) {
        currentInstance.loadSettings().then(() => {
          if (!currentInstance.enabled) {
            console.log('Extension now disabled for this URL');
            // Minimal cleanup if needed, but the instance won't re-init
          } else {
             // If it was already enabled, the existing instance intervals might still work
             // but we might want to refresh platform-specific stuff
             if (currentInstance.platform === 'unknown') {
               const newPlatform = currentInstance.detectPlatform();
               if (newPlatform !== 'unknown') {
                 currentInstance.platform = newPlatform;
                 currentInstance.init();
               }
             }
          }
        });
      } else {
        initializeSubtitles();
      }
      navigationTimeout = null;
    }, 1500);
  }
};

// More polite MutationObserver - check periodically instead of on every single change
// The setInterval already does a fallback check every 2 seconds.
// We can use a simpler observer or just rely on popstate/setInterval for non-video sites.
const observer = new MutationObserver(() => {
  // Only trigger on significant changes like title or main structure if we are in an SPA
  handleNavigation();
});

// Start observing the body, but don't be too aggressive
if (document.body) {
  observer.observe(document.body, {
    childList: true,
    subtree: false // Don't watch every single nested element change
  });
} else {
  // Should have been initialized already if document.body didn't exist yet
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, {
      childList: true,
      subtree: false
    });
  });
}

// Also listen for history changes
window.addEventListener('popstate', handleNavigation);
window.addEventListener('pushstate', handleNavigation);
window.addEventListener('replacestate', handleNavigation);

// Periodically check for URL changes (fallback)
setInterval(() => {
  handleNavigation();
}, 2000);

console.log('Interactive Subtitles content script fully loaded');