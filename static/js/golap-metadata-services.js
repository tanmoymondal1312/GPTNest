window.MMConfig = {
    GEMINI_MODELS: ['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'],
    MAX_CONCURRENT: 1,
    RETRY_DELAYS: [2000, 4000],
    MAX_RETRY: 2,
    INTER_REQUEST_DELAY: 1000,
};

window.MMCache = (function () {
    const cache = new Map();
    return {
        get: function (hash) { return cache.get(hash); },
        set: function (hash, analysis, metadata) { cache.set(hash, { analysis: analysis, metadata: metadata, timestamp: Date.now() }); },
        has: function (hash) { return cache.has(hash); },
        clear: function () { cache.clear(); },
        size: function () { return cache.size; },
    };
})();

window.MMGeminiService = (function () {
    function formatApiError(err, statusCode) {
        var message = err && err.message ? err.message : String(err);
        var code = err && err.errorCode ? err.errorCode : (statusCode ? 'HTTP ' + statusCode : 'API_ERROR');
        var details = err && err.technicalDetails ? err.technicalDetails : message;
        var isRateLimit = statusCode === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota');
        var isUnavailable = statusCode === 503 || message.includes('503') || message.includes('UNAVAILABLE') || message.includes('overloaded');
        var isTimeout = statusCode === 504 || message.includes('504') || message.includes('TIMEOUT') || message.includes('timed out');

        if (isRateLimit) return { userMessage: 'API quota/rate limit reached.', reason: 'Gemini API requests exceeded quota.', errorCode: '429', statusCode: 429, technicalDetails: details, canRetry: true };
        if (isUnavailable) return { userMessage: 'AI service temporarily unavailable.', reason: 'Google Gemini servers overloaded.', errorCode: '503', statusCode: 503, technicalDetails: details, canRetry: true };
        if (isTimeout) return { userMessage: 'AI vision analysis timed out.', reason: 'Artwork took too long to analyze.', errorCode: '504', statusCode: 504, technicalDetails: details, canRetry: true };
        return { userMessage: 'AI generation failed.', reason: 'Model could not complete metadata generation.', errorCode: code, statusCode: statusCode || 500, technicalDetails: details, canRetry: true };
    }

    function _validateMetadata(meta) {
        if (!meta) return { valid: false, reason: 'No metadata returned' };
        if (!meta.title || meta.title.trim().length < 3) return { valid: false, reason: 'Title is empty or too short' };
        if (!meta.description || meta.description.trim().length < 10) return { valid: false, reason: 'Description is empty or too short' };
        if (!meta.keywords || !Array.isArray(meta.keywords) || meta.keywords.length === 0) return { valid: false, reason: 'No keywords' };
        if (!meta.primaryCategory && !meta.category) return { valid: false, reason: 'Missing category' };
        return { valid: true };
    }

    async function analyzeArtwork(item, settings, platform, forceFresh, generationVersion, model) {
        if (!item.base64Data) {
            var err = { userMessage: 'No artwork preview available.', errorCode: 'PREVIEW_MISSING', canRetry: false };
            return { success: false, item: Object.assign({}, item, { status: 'error', errorMessage: err.userMessage, apiError: err }), error: err };
        }

        if (!forceFresh && item.fileHash && MMCache.has(item.fileHash)) {
            var cached = MMCache.get(item.fileHash);
            var adapted = MMUI.adaptMetadataForPlatform(cached.analysis, cached.metadata, platform, settings);
            return {
                success: true,
                fromCache: true,
                item: Object.assign({}, item, {
                    analysis: cached.analysis, confidence: cached.analysis.confidence || 90,
                    title: adapted.title, description: adapted.description, keywords: adapted.keywords,
                    primaryCategory: adapted.primaryCategory || 'Graphic Resources',
                    secondaryCategory: adapted.secondaryCategory || 'Design',
                    contentType: cached.analysis.content_type || 'Vector',
                    visualStyle: cached.analysis.style || 'Vector Graphic',
                    dominantColors: cached.analysis.colors || [],
                    backgroundType: cached.analysis.background || 'Transparent',
                    mainSubject: cached.analysis.main_subject || 'Artwork',
                    qualityScore: adapted.qualityScore, validation: adapted.validation,
                    status: 'completed', errorMessage: undefined, apiError: undefined,
                }),
            };
        }

        var attempt = 0, lastError = null, lastStatus = 500;
        while (attempt <= MMConfig.MAX_RETRY) {
            try {
                var res = await fetch('/api/analyze-metadata/', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: item.base64Data, mimeType: item.mimeType || 'image/png',
                        fileName: item.fileName, fileType: item.fileType,
                        platform: platform, settings: settings, fileHash: item.fileHash,
                        model: model || '',
                    }),
                });
                lastStatus = res.status;
                if (!res.ok) {
                    console.error('[API] analyze-metadata error:', item.fileName, 'status:', res.status);
                    var errorData = await res.json().catch(function () { return {}; });
                    var e = new Error(errorData.error || 'HTTP ' + res.status);
                    e.errorCode = errorData.errorCode; e.technicalDetails = errorData.technicalDetails || errorData.error;
                    throw e;
                }
                var data = await res.json();
                console.log('[API] analyze-metadata response:', item.fileName, 'keys:', Object.keys(data).join(', '));
                var analysisData = data.analysis || data.visual_analysis || {
                    main_subject: 'Artwork', objects: [], visible_text: [], style: 'Graphic',
                    theme: 'Design', colors: [], background: 'Transparent', composition: 'Centered',
                    content_type: 'Vector', confidence: 90,
                };

                var aiMetadata = data.metadata || {};
                var adapted2 = MMUI.adaptMetadataForPlatform(analysisData, aiMetadata, platform, settings);

                var metaValidation = _validateMetadata(adapted2);
                if (!metaValidation.valid) {
                    var ve = new Error('Metadata validation failed: ' + metaValidation.reason);
                    ve.errorCode = 'METADATA_INVALID';
                    throw ve;
                }

                if (item.fileHash) MMCache.set(item.fileHash, analysisData, aiMetadata);

                return {
                    success: true,
                    item: Object.assign({}, item, {
                        analysis: analysisData, confidence: analysisData.confidence || 90,
                        title: adapted2.title, description: adapted2.description, keywords: adapted2.keywords,
                        primaryCategory: adapted2.primaryCategory || aiMetadata.category || 'Graphic Resources',
                        secondaryCategory: adapted2.secondaryCategory || aiMetadata.secondary_category || 'Design',
                        contentType: analysisData.content_type || 'Vector',
                        visualStyle: analysisData.style || 'Graphic',
                        dominantColors: analysisData.colors || [],
                        backgroundType: analysisData.background || 'Transparent',
                        mainSubject: analysisData.main_subject || 'Artwork',
                        qualityScore: adapted2.qualityScore, validation: adapted2.validation,
                        status: 'completed', errorMessage: undefined, apiError: undefined,
                    }),
                };
            } catch (err2) {
                lastError = err2; attempt++;
                var isRetryable = lastStatus === 429 || lastStatus === 503 || lastStatus === 504 || (err2.message && (err2.message.includes('429') || err2.message.includes('RESOURCE_EXHAUSTED') || err2.message.includes('TIMEOUT')));
                if (isRetryable && attempt <= MMConfig.MAX_RETRY) {
                    var delay = MMConfig.RETRY_DELAYS[attempt - 1] || 5000;
                    await new Promise(function (r) { setTimeout(r, delay); });
                } else { break; }
            }
        }
        var apiError = formatApiError(lastError, lastStatus);
        return { success: false, item: Object.assign({}, item, { status: 'error', errorMessage: apiError.userMessage, apiError: apiError }), error: apiError };
    }

    async function reverseEngineerPrompt(item) {
        if (!item.base64Data) {
            var err = { userMessage: 'No preview available.', errorCode: 'PREVIEW_MISSING', canRetry: false };
            return { success: false, item: Object.assign({}, item, { status: 'error', errorMessage: err.userMessage }), error: err };
        }
        try {
            var res = await fetch('/api/image-to-prompt/', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: item.base64Data, mimeType: item.mimeType || 'image/png', fileName: item.fileName }),
            });
            if (!res.ok) { var d = await res.json().catch(function () { return {}; }); throw new Error(d.error || 'HTTP ' + res.status); }
            var promptData = await res.json();
            return { success: true, item: Object.assign({}, item, { status: 'completed', promptResult: promptData, errorMessage: undefined }) };
        } catch (e) {
            var apiError = formatApiError(e);
            return { success: false, item: Object.assign({}, item, { status: 'error', errorMessage: apiError.userMessage, apiError: apiError }), error: apiError };
        }
    }

    return { formatApiError: formatApiError, analyzeArtwork: analyzeArtwork, reverseEngineerPrompt: reverseEngineerPrompt };
})();

window.MMQueue = (function () {
    var queue = [], activeCount = 0, isPaused = false, isCancelled = false, isProcessing = false;
    var rateLimitWaiting = false, rateLimitTimer = null;
    var totalCount = 0, completedCount = 0, failedCount = 0;
    var settings = {}, platform = 'adobe-stock', selectedModel = '';
    var onProgress, onItemUpdated, onBatchComplete;
    var generationVersionCounter = 0;

    function getProgress() {
        return { total: totalCount, completed: completedCount, processing: activeCount, pending: queue.length, failed: failedCount, isPaused: isPaused, isProcessing: isProcessing, rateLimitWaiting: rateLimitWaiting };
    }
    function emitProgress() { if (onProgress) onProgress(getProgress()); }
    function cancel() { isCancelled = true; isProcessing = false; isPaused = false; rateLimitWaiting = false; if (rateLimitTimer) { clearTimeout(rateLimitTimer); rateLimitTimer = null; } queue = []; activeCount = 0; }

    function pump() {
        if (isCancelled) return;
        if (queue.length === 0 && activeCount === 0) { isProcessing = false; rateLimitWaiting = false; emitProgress(); if (onBatchComplete) onBatchComplete(); return; }
        if (isPaused || rateLimitWaiting) { emitProgress(); return; }
        while (activeCount < MMConfig.MAX_CONCURRENT && queue.length > 0 && !isPaused && !rateLimitWaiting && !isCancelled) {
            var item = queue.shift(); activeCount++; processItem(item);
        }
        emitProgress();
    }

    async function processItem(item) {
        if (isCancelled) { activeCount--; return; }
        generationVersionCounter++;
        var myVersion = generationVersionCounter;
        item.generationVersion = myVersion;
        console.log('[QUEUE] processItem start:', item.fileName, 'id:', item.id);
        if (onItemUpdated) onItemUpdated(Object.assign({}, item, { status: 'analyzing', statusMessage: 'AI Vision Analysis...' }));
        emitProgress();
        try {
            var result = await MMGeminiService.analyzeArtwork(item, settings, platform, false, myVersion, selectedModel);
            console.log('[QUEUE] analyzeArtwork result:', item.fileName, 'success:', result.success, 'status:', result.item ? result.item.status : 'no-item');
            if (isCancelled) { activeCount--; return; }
            if (result.item && result.item.generationVersion && result.item.generationVersion < myVersion) {
                activeCount--;
                pump();
                return;
            }
            if (result.success) { completedCount++; } else { failedCount++; if (result.error && result.error.statusCode === 429) handleRateLimit(); }
            if (onItemUpdated) onItemUpdated(result.item);
        } catch (e) {
            console.error('[QUEUE] processItem error:', item.fileName, e.message);
            failedCount++;
            if (onItemUpdated) onItemUpdated(Object.assign({}, item, { status: 'error', errorMessage: e.message || 'Failed.' }));
        } finally {
            activeCount--;
            if (!rateLimitWaiting && !isPaused && queue.length > 0) { setTimeout(pump, MMConfig.INTER_REQUEST_DELAY); } else { pump(); }
        }
    }

    function handleRateLimit() {
        if (rateLimitWaiting) return;
        rateLimitWaiting = true; emitProgress();
        if (rateLimitTimer) clearTimeout(rateLimitTimer);
        rateLimitTimer = setTimeout(function () { rateLimitWaiting = false; emitProgress(); pump(); }, 4000);
    }

    return {
        startBatch: function (items, s, p, cbs, model) {
            cancel(); settings = s; platform = p; onProgress = cbs.onProgress; onItemUpdated = cbs.onItemUpdated; onBatchComplete = cbs.onBatchComplete;
            selectedModel = model || '';
            var pending = items.filter(function (i) { return (i.status === 'idle' || i.status === 'error' || i.status === 'preview_ready') && i.base64Data; });
            if (pending.length === 0) { emitProgress(); if (onBatchComplete) onBatchComplete(); return; }
            queue = pending.slice(); totalCount = pending.length;
            completedCount = 0;
            failedCount = 0;
            activeCount = 0; isPaused = false; isCancelled = false; isProcessing = true; rateLimitWaiting = false;
            emitProgress(); pump();
        },
        pause: function () { isPaused = true; emitProgress(); },
        resume: function () { if (!isPaused) return; isPaused = false; emitProgress(); pump(); },
        cancel: function () { isCancelled = true; isProcessing = false; isPaused = false; rateLimitWaiting = false; if (rateLimitTimer) { clearTimeout(rateLimitTimer); rateLimitTimer = null; } queue = []; activeCount = 0; },
        getProgress: getProgress,
    };
})();

window.MMExport = (function () {
    function downloadBlob(content, filename, type) {
        var blob = new Blob([content], { type: type });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a'); link.href = url; link.download = filename;
        document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
    }

    function escapeCsvField(val) {
        if (val == null) return '';
        var s = String(val);
        if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return '"' + s + '"';
    }

    return {
        toCsv: function (items, filename) {
            if (!items || !items.length) return;

            var readyItems = items.filter(function (item) {
                return item.status === 'completed' &&
                    item.title && item.title.trim().length > 0 &&
                    item.description && item.description.trim().length > 0 &&
                    item.keywords && Array.isArray(item.keywords) && item.keywords.length > 0;
            });

            if (readyItems.length === 0) {
                MMUI.showToast('Export', 'No completed metadata to export', 'error');
                return;
            }

            var excludedCount = items.length - readyItems.length;
            if (excludedCount > 0) {
                MMUI.showToast('Export', excludedCount + ' file(s) excluded (incomplete/failed)', 'info');
            }

            var headers = ['Filename', 'Title', 'Description', 'Keywords'];
            var rows = readyItems.map(function (item) {
                var kwString = Array.isArray(item.keywords) ? item.keywords.join(', ') : '';
                return [
                    escapeCsvField(item.fileName),
                    escapeCsvField(item.title),
                    escapeCsvField(item.description),
                    escapeCsvField(kwString),
                ].join(',');
            });

            var csvContent = '\uFEFF' + headers.join(',') + '\r\n' + rows.join('\r\n');
            downloadBlob(csvContent, filename || 'csvgpt_stock_metadata.csv', 'text/csv;charset=utf-8;');
            MMUI.showToast('Export', readyItems.length + ' file(s) exported as CSV for Adobe Stock', 'success');
        },
        toJson: function (items, filename) {
            if (!items || !items.length) return;

            var readyItems = items.filter(function (item) {
                return item.status === 'completed' &&
                    item.title && item.title.trim().length > 0 &&
                    item.keywords && Array.isArray(item.keywords) && item.keywords.length > 0;
            });

            if (readyItems.length === 0) {
                MMUI.showToast('Export', 'No completed metadata to export', 'error');
                return;
            }

            var data = readyItems.map(function (item) {
                return {
                    filename: item.fileName,
                    title: item.title || '',
                    description: item.description || '',
                    keywords: item.keywords || [],
                    category: item.primaryCategory || '',
                    secondaryCategory: item.secondaryCategory || '',
                };
            });
            downloadBlob(JSON.stringify(data, null, 2), filename || 'golap_metadata.json', 'application/json;charset=utf-8;');
            MMUI.showToast('Export', readyItems.length + ' file(s) exported as JSON', 'success');
        },
    };
})();

window.MMSamples = [
    { id: 'botanical', name: 'tropical_monstera_botanical_leaves.svg', category: 'Plants and Flowers', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#064e3b"/><stop offset="100%" stop-color="#022c22"/></linearGradient><linearGradient id="l1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#047857"/></linearGradient><linearGradient id="l2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#059669"/></linearGradient><linearGradient id="fl" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#be123c"/></linearGradient></defs><rect width="800" height="600" fill="url(#bg)"/><g transform="translate(150,300) scale(1.4)"><path d="M0,0 Q60,-120 180,-100 Q100,-40 0,0" fill="url(#l1)" opacity="0.9"/><path d="M0,0 Q-60,-120 -180,-100 Q-100,-40 0,0" fill="url(#l2)" opacity="0.9"/><path d="M0,0 Q10,-160 80,-200 Q20,-100 0,0" fill="url(#l1)"/><path d="M0,0 Q-10,-160 -80,-200 Q-20,-100 0,0" fill="url(#l2)"/></g><g transform="translate(600,260) scale(1.2)"><path d="M0,0 C80,-60 140,-20 160,80 C180,180 80,240 0,260 C-80,240 -180,180 -160,80 C-140,-20 -80,-60 0,0 Z" fill="url(#l2)"/><path d="M0,10 L0,250" stroke="#064e3b" stroke-width="6"/><ellipse cx="60" cy="80" rx="30" ry="12" transform="rotate(30 60 80)" fill="#022c22"/><ellipse cx="-60" cy="80" rx="30" ry="12" transform="rotate(-30 -60 80)" fill="#022c22"/></g><g transform="translate(380,420)"><circle cx="0" cy="0" r="45" fill="url(#fl)"/><circle cx="0" cy="0" r="16" fill="#facc15"/></g></svg>' },
    { id: 'cloud-ai', name: 'isometric_ai_cloud_computing.svg', category: 'Technology', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#0b0f19"/><stop offset="100%" stop-color="#1e1b4b"/></linearGradient><linearGradient id="cg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#06b6d4"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect width="800" height="600" fill="url(#bg)"/><g transform="translate(400,360)"><polygon points="0,-120 240,0 0,120 -240,0" fill="#1e293b" stroke="#0ea5e9" stroke-width="2"/><g transform="translate(-100,-30)"><polygon points="0,-80 50,-55 0,-30 -50,-55" fill="#38bdf8" opacity="0.8"/><polygon points="-50,-55 0,-30 0,50 -50,25" fill="#0284c7"/><polygon points="0,-30 50,-55 50,25 0,50" fill="#0369a1"/></g><g transform="translate(100,-30)"><polygon points="0,-80 50,-55 0,-30 -50,-55" fill="#a855f7" opacity="0.8"/><polygon points="-50,-55 0,-30 0,50 -50,25" fill="#7e22ce"/><polygon points="0,-30 50,-55 50,25 0,50" fill="#6b21a8"/></g><g transform="translate(0,-110)"><circle cx="0" cy="0" r="45" fill="none" stroke="#38bdf8" stroke-width="3" opacity="0.7" stroke-dasharray="6,4"/><polygon points="0,-40 30,-15 0,10 -30,-15" fill="url(#cg)" opacity="0.9"/><line x1="0" y1="-40" x2="0" y2="-120" stroke="#38bdf8" stroke-width="4" stroke-linecap="round"/></g></g></svg>' },
    { id: 'business', name: 'corporate_business_team.svg', category: 'Business', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs><linearGradient id="sky" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#f97316"/><stop offset="100%" stop-color="#ffedd5"/></linearGradient></defs><rect width="800" height="600" fill="url(#sky)"/><circle cx="400" cy="300" r="180" fill="#fef08a" opacity="0.7"/><path d="M100,500 L250,420 L400,340 L550,220 L700,100" stroke="#ea580c" stroke-width="8" stroke-dasharray="10,8" fill="none" opacity="0.5"/><path d="M0,600 L0,480 L180,440 L340,380 L520,320 L680,260 L800,260 L800,600 Z" fill="#0f172a"/><g transform="translate(640,160)"><circle cx="0" cy="0" r="10" fill="#0f172a"/><path d="M-8,14 L8,14 L6,50 L-6,50 Z" fill="#0f172a"/><line x1="0" y1="20" x2="25" y2="-10" stroke="#0f172a" stroke-width="5" stroke-linecap="round"/><line x1="25" y1="-10" x2="25" y2="70" stroke="#0f172a" stroke-width="4"/><polygon points="25,-10 65,5 25,20" fill="#dc2626"/></g></svg>' },
    { id: 'coffee', name: 'vintage_coffee_roasters_badge.svg', category: 'Food', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#1c1917"/><stop offset="100%" stop-color="#292524"/></linearGradient></defs><rect width="800" height="600" fill="url(#bg)"/><g transform="translate(400,300)"><circle cx="0" cy="0" r="220" fill="none" stroke="#d97706" stroke-width="4" stroke-dasharray="8,6"/><circle cx="0" cy="0" r="200" fill="#451a03" stroke="#f59e0b" stroke-width="6"/><path d="M-140,-120 Q0,-100 140,-120 L150,-80 Q0,-60 -150,-80 Z" fill="#b45309" stroke="#fef3c7" stroke-width="2"/><text x="0" y="-88" fill="#fef3c7" font-size="18" font-weight="bold" font-family="serif" text-anchor="middle" letter-spacing="4">PREMIUM QUALITY</text><g transform="translate(0,10)"><path d="M-20,-60 Q-30,-80 -15,-100" stroke="#fde68a" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M0,-65 Q10,-85 0,-105" stroke="#fde68a" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M20,-60 Q30,-80 15,-100" stroke="#fde68a" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M-45,-40 L45,-40 L35,25 C30,50 -30,50 -35,25 Z" fill="#fef3c7" stroke="#78350f" stroke-width="3"/><path d="M42,-30 C65,-30 65,10 37,15" fill="none" stroke="#fef3c7" stroke-width="7" stroke-linecap="round"/><ellipse cx="0" cy="40" rx="65" ry="10" fill="#fef3c7" stroke="#78350f" stroke-width="3"/></g><text x="0" y="105" fill="#fbbf24" font-size="28" font-weight="900" font-family="sans-serif" text-anchor="middle" letter-spacing="3">COFFEE ROASTERS</text><text x="0" y="135" fill="#fef3c7" font-size="13" font-weight="600" font-family="sans-serif" text-anchor="middle" letter-spacing="5">ESTD 1984 ORGANIC</text></g></svg>' },
];
