(function () {
    var state = {
        mode: 'metadata',
        platform: 'adobe-stock',
        items: [],
        selectedItem: null,
        view: 'upload',
        settings: loadSettings(),
        selectedModel: '',
    };

    var DEFAULT_SETTINGS = {
        minTitleWords: 8, maxTitleWords: 22, minKeywords: 25, maxKeywords: 49,
        minDescriptionWords: 18, maxDescriptionWords: 32,
        singleWordKeywords: true, silhouette: false, transparent: false,
        customPromptEnabled: false, customPromptText: '',
        prohibitedWordsEnabled: false, prohibitedWordsText: '',
    };

    function loadSettings() {
        try { var s = JSON.parse(localStorage.getItem('gp_settings')); return s ? Object.assign({}, DEFAULT_SETTINGS, s) : Object.assign({}, DEFAULT_SETTINGS); } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
    }
    function saveSettings() { try { localStorage.setItem('gp_settings', JSON.stringify(state.settings)); } catch (e) { } }

    function $(id) { return document.getElementById(id); }

    function _validateItemForReady(item) {
        if (!item || item.status === 'error') return false;
        if (!item.base64Data) return false;
        if (!item.title || item.title.trim().length < 3) return false;
        if (!item.description || item.description.trim().length < 10) return false;
        if (!item.keywords || !Array.isArray(item.keywords) || item.keywords.length === 0) return false;
        if (!item.primaryCategory) return false;
        return true;
    }

    function _markReady(item) {
        if (_validateItemForReady(item)) {
            item.status = 'completed';
        } else {
            item.status = 'error';
            if (!item.errorMessage) item.errorMessage = 'Metadata validation failed: incomplete fields';
        }
        return item;
    }

    function updateView() {
        var uploadView = $('gp-upload-view');
        var detailView = $('gp-detail-view');
        var batchView = $('gp-batch-view');
        var promptView = $('gp-prompt-view');
        var header = $('gp-header');
        var platforms = $('gp-platforms');

        uploadView.style.display = 'none';
        detailView.style.display = 'none';
        batchView.style.display = 'none';
        promptView.style.display = 'none';
        header.style.display = 'none';
        platforms.style.display = 'none';

        if (state.items.length === 0) {
            uploadView.style.display = '';
            return;
        }

        header.style.display = '';
        platforms.style.display = '';
        MMUI.renderPlatformTabs(platforms, state.platform, function (id) {
            state.platform = id;
            if (state.selectedItem && state.selectedItem.analysis) {
                handlePlatformChange();
            }
            updateView();
        });

        if (state.mode === 'prompt' && state.selectedItem) {
            promptView.style.display = '';
            MMUI.renderPromptView(promptView, state.selectedItem);
        } else if (state.view === 'detail' && state.selectedItem) {
            detailView.style.display = '';
            MMUI.renderDetailView(detailView, state.selectedItem, state.platform, { onBind: bindDetailViewEvents });
        } else if (state.items.length >= 1) {
            batchView.style.display = '';
            MMUI.renderBatchView(batchView, state.items, state.platform, { onBind: bindBatchViewEvents });
        } else {
            uploadView.style.display = '';
        }
    }

    function _findItemById(id) {
        for (var i = 0; i < state.items.length; i++) {
            if (state.items[i].id === id) return state.items[i];
        }
        return null;
    }

    function handlePlatformChange() {
        if (!state.selectedItem || !state.selectedItem.analysis) return;
        var adapted = MMUI.adaptMetadataForPlatform(
            state.selectedItem.analysis,
            { title: state.selectedItem.title, description: state.selectedItem.description, keywords: state.selectedItem.keywords, category: state.selectedItem.primaryCategory, secondary_category: state.selectedItem.secondaryCategory },
            state.platform, state.settings
        );
        state.selectedItem.title = adapted.title;
        state.selectedItem.description = adapted.description;
        state.selectedItem.keywords = adapted.keywords;
        state.selectedItem.qualityScore = adapted.qualityScore;
        MMUI.showToast('Platform Changed', 'Metadata adapted for ' + (MMUI.PLATFORMS[state.platform] ? MMUI.PLATFORMS[state.platform].name : state.platform), 'info');
    }

    async function processFile(file) {
        var item = {
            id: Date.now() + '_' + Math.random().toString(36).substr(2, 6),
            fileName: file.name, fileType: file.type, mimeType: file.type || 'image/png',
            status: 'idle', base64Data: null, previewUrl: null, fileHash: null,
            analysis: null, title: '', description: '', keywords: [], primaryCategory: '', secondaryCategory: '',
            contentType: '', visualStyle: '', dominantColors: [], backgroundType: 'Transparent',
            mainSubject: '', confidence: 90, qualityScore: null, validation: null,
            apiError: null, errorMessage: null, promptResult: null,
            technicalDetails: null, generationVersion: 0,
        };

        if (file.name.toLowerCase().endsWith('.eps')) {
            item.status = 'rendering_eps';
            try {
                var b64 = await readFileAsBase64(file);
                var res = await fetch('/api/render-eps/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileData: b64, fileName: file.name }),
                });
                var data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'EPS render failed');
                item.base64Data = data.base64Data;
                item.previewUrl = data.previewUrl;
                item.technicalDetails = { width: data.width, height: data.height, orientation: data.orientation, hasTransparency: data.hasTransparency };
                item.status = 'preview_ready';
            } catch (e) {
                item.status = 'error';
                item.errorMessage = 'EPS render failed: ' + e.message;
            }
        } else {
            try {
                var result = await processImageFile(file);
                item.base64Data = result.base64Data;
                item.previewUrl = result.previewUrl;
                item.technicalDetails = result.technicalDetails;
                item.fileHash = result.fileHash;
                item.status = 'preview_ready';
            } catch (e) {
                item.status = 'error';
                item.errorMessage = 'File processing failed: ' + e.message;
            }
        }
        return item;
    }

    function processImageFile(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function (e) {
                var dataUrl = e.target.result;
                var img = new Image();
                img.onload = function () {
                    var maxPx = 1800;
                    var w = img.width, h = img.height;
                    if (Math.max(w, h) > maxPx) { var r = maxPx / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
                    var canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    var fmt = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                    var b64Full = canvas.toDataURL(fmt, 0.85);
                    var b64Data = b64Full.split(',')[1];
                    var hash = b64Data.substring(0, 10000);
                    var hasher = 0;
                    for (var i = 0; i < hash.length; i++) { hasher = ((hasher << 5) - hash.charCodeAt(i)) | 0; }
                    var fileHash = Math.abs(hasher).toString(36);
                    var orient = Math.abs(w / h - 1) < 0.08 ? 'Square' : (w / h < 0.92 ? 'Portrait' : 'Landscape');
                    resolve({
                        base64Data: b64Data, previewUrl: b64Full, fileHash: fileHash,
                        technicalDetails: { width: w, height: h, orientation: orient, hasTransparency: file.type === 'image/png' },
                    });
                };
                img.onerror = function () { reject(new Error('Failed to load image')); };
                img.src = dataUrl;
            };
            reader.onerror = function () { reject(new Error('Failed to read file')); };
            reader.readAsDataURL(file);
        });
    }

    function readFileAsBase64(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function (e) { resolve(e.target.result.split(',')[1]); };
            reader.onerror = function () { reject(new Error('Failed to read file')); };
            reader.readAsDataURL(file);
        });
    }

    async function generateSingle(item) {
        item.status = 'analyzing';
        updateView();
        var result = await MMGeminiService.analyzeArtwork(item, state.settings, state.platform, false, null, state.selectedModel);
        var target = _findItemById(result.item.id);
        if (target) {
            Object.assign(target, result.item);
            _markReady(target);
        }
        if (state.selectedItem && state.selectedItem.id === item.id) {
            state.selectedItem = target || result.item;
        }
        if (result.success) { MMUI.showToast('Done', result.fromCache ? 'Loaded from cache' : 'AI analysis complete', 'success'); }
        else { MMUI.showToast('Error', result.error ? result.error.userMessage : 'Analysis failed', 'error'); }
        updateView();
    }

    async function generateAllBatch() {
        var checkedBoxes = document.querySelectorAll('.gp-batch-check:checked');
        var checkedIndices = Array.from(checkedBoxes).map(function (cb) { return parseInt(cb.dataset.idx); });

        var pending;
        if (checkedIndices.length > 0) {
            pending = state.items.filter(function (item, idx) {
                return checkedIndices.indexOf(idx) !== -1 && (item.status === 'idle' || item.status === 'error' || item.status === 'preview_ready') && item.base64Data;
            });
        } else {
            pending = state.items.filter(function (i) { return (i.status === 'idle' || i.status === 'error' || i.status === 'preview_ready') && i.base64Data; });
        }
        if (pending.length === 0) { MMUI.showToast('Info', checkedIndices.length > 0 ? 'Selected files already processed or no artwork' : 'No files to process', 'info'); return; }

        var progressEl = $('gp-progress');
        var fillEl = $('gp-progress-fill');
        var textEl = $('gp-progress-text');
        progressEl.style.display = '';
        fillEl.style.width = '0%';
        textEl.textContent = 'Starting batch processing...';

        MMQueue.startBatch(state.items, state.settings, state.platform, {
            onProgress: function (p) {
                var pct = p.total > 0 ? (p.completed / p.total * 100) : 0;
                fillEl.style.width = pct + '%';
                textEl.textContent = p.completed + '/' + p.total + ' completed' + (p.rateLimitWaiting ? ' (rate limit cooldown...)' : '') + (p.isPaused ? ' (paused)' : '');
                if (p.rateLimitWaiting) $('gp-rate-limit').style.display = ''; else $('gp-rate-limit').style.display = 'none';
            },
            onItemUpdated: function (updatedItem) {
                var target = _findItemById(updatedItem.id);
                if (target) {
                    Object.assign(target, updatedItem);
                    if (target.status !== 'analyzing') {
                        _markReady(target);
                    }
                }
                if (state.selectedItem && state.selectedItem.id === updatedItem.id) {
                    state.selectedItem = target || updatedItem;
                }
                updateView();
            },
            onBatchComplete: function () {
                progressEl.style.display = 'none';
                $('gp-rate-limit').style.display = 'none';
                var failed = state.items.filter(function (i) { return i.status === 'error'; }).length;
                var succeeded = state.items.filter(function (i) { return i.status === 'completed'; }).length;
                if (failed > 0 && succeeded === 0) {
                    MMUI.showToast('Generation Failed', 'All files failed. Check API key and try again.', 'error');
                } else if (failed > 0) {
                    MMUI.showToast('Partial Success', succeeded + ' completed, ' + failed + ' failed. Exporting CSV for completed files...', 'warning');
                } else {
                    MMUI.showToast('Batch Complete', 'All ' + succeeded + ' files processed successfully.', 'success');
                }
                updateView();
                setTimeout(function () {
                    MMExport.toCsv(state.items);
                }, 800);
            },
        }, state.selectedModel);
    }

    function bindDetailViewEvents() {
        var titleInput = $('gp-edit-title');
        var descInput = $('gp-edit-desc');
        if (titleInput) titleInput.addEventListener('input', function () {
            if (state.selectedItem) { state.selectedItem.title = titleInput.value; }
        });
        if (descInput) descInput.addEventListener('input', function () {
            if (state.selectedItem) { state.selectedItem.description = descInput.value; }
        });

        document.querySelectorAll('[data-action="copy-title"]').forEach(function (btn) {
            btn.addEventListener('click', function () { navigator.clipboard.writeText(state.selectedItem ? state.selectedItem.title : ''); MMUI.showToast('Copied', 'Title copied', 'success'); });
        });
        document.querySelectorAll('[data-action="copy-desc"]').forEach(function (btn) {
            btn.addEventListener('click', function () { navigator.clipboard.writeText(state.selectedItem ? state.selectedItem.description : ''); MMUI.showToast('Copied', 'Description copied', 'success'); });
        });
        document.querySelectorAll('[data-action="copy-kw"]').forEach(function (btn) {
            btn.addEventListener('click', function () { navigator.clipboard.writeText(state.selectedItem ? (state.selectedItem.keywords || []).join(', ') : ''); MMUI.showToast('Copied', 'Keywords copied', 'success'); });
        });
        document.querySelectorAll('[data-action="regen-title"]').forEach(function (btn) {
            btn.addEventListener('click', function () { if (state.selectedItem) generateSingle(state.selectedItem); });
        });
        document.querySelectorAll('[data-action="regen-desc"]').forEach(function (btn) {
            btn.addEventListener('click', function () { if (state.selectedItem) generateSingle(state.selectedItem); });
        });
        document.querySelectorAll('[data-action="regen-kw"]').forEach(function (btn) {
            btn.addEventListener('click', function () { if (state.selectedItem) generateSingle(state.selectedItem); });
        });
        document.querySelectorAll('[data-action="sort-kw"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                if (state.selectedItem && state.selectedItem.keywords) {
                    state.selectedItem.keywords.sort();
                    updateView();
                }
            });
        });

        document.querySelectorAll('.gp-kw-remove').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var idx = parseInt(btn.dataset.idx);
                if (state.selectedItem && state.selectedItem.keywords) {
                    state.selectedItem.keywords.splice(idx, 1);
                    updateView();
                }
            });
        });

        document.querySelectorAll('.gp-kw-move').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var idx = parseInt(btn.dataset.idx);
                var dir = btn.dataset.dir;
                if (!state.selectedItem || !state.selectedItem.keywords) return;
                var kw = state.selectedItem.keywords;
                var newIdx = dir === 'left' ? idx - 1 : idx + 1;
                if (newIdx < 0 || newIdx >= kw.length) return;
                var tmp = kw[idx]; kw[idx] = kw[newIdx]; kw[newIdx] = tmp;
                updateView();
            });
        });

        var addKwInput = $('gp-add-kw-input');
        var addKwBtn = $('gp-add-kw-btn');
        if (addKwBtn && addKwInput) {
            addKwBtn.addEventListener('click', function () {
                var val = addKwInput.value.trim();
                if (val && state.selectedItem) {
                    val.split(',').forEach(function (k) { var trimmed = k.trim().toLowerCase(); if (trimmed) state.selectedItem.keywords.push(trimmed); });
                    addKwInput.value = '';
                    updateView();
                }
            });
            addKwInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') addKwBtn.click(); });
        }
    }

    function bindBatchViewEvents() {
        var checkAll = $('gp-check-all');
        if (checkAll) {
            checkAll.addEventListener('change', function () {
                document.querySelectorAll('.gp-batch-check').forEach(function (cb) { cb.checked = checkAll.checked; });
            });
        }

        document.querySelectorAll('.gp-table tbody tr').forEach(function (row) {
            row.addEventListener('click', function (e) {
                if (e.target.closest('.gp-batch-check') || e.target.closest('button')) return;
                var idx = parseInt(row.dataset.idx);
                state.selectedItem = state.items[idx];
                state.view = 'detail';
                updateView();
            });
        });

        var genBtn = $('gp-batch-generate');
        if (genBtn) genBtn.addEventListener('click', generateAllBatch);

        var csvBtn = $('gp-batch-export-csv');
        if (csvBtn) csvBtn.addEventListener('click', function () { MMExport.toCsv(state.items); });

        var jsonBtn = $('gp-batch-export-json');
        if (jsonBtn) jsonBtn.addEventListener('click', function () { MMExport.toJson(state.items); });

        var clearBtn = $('gp-batch-clear');
        if (clearBtn) clearBtn.addEventListener('click', function () {
            state.items = []; state.selectedItem = null; state.view = 'upload';
            updateView();
        });

        var addBtn = $('gp-batch-add');
        if (addBtn) addBtn.addEventListener('click', function () { $('gp-file-input').click(); });
    }

    function checkAndRenderModels() {
        var container = $('gp-model-selector');
        if (!container) return;

        fetch('/api/check-models/')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var models = data.models || [];
                container.innerHTML = '';

                models.forEach(function (m) {
                    var div = document.createElement('div');
                    div.className = 'gp-model-option' + (!m.available ? ' unavailable' : '') + (state.selectedModel === m.id ? ' selected' : '');

                    var badgeClass = m.available ? (m.latency_ms > 5000 ? 'slow' : 'online') : 'offline';
                    var badgeText = m.available ? (m.latency_ms > 5000 ? 'Slow' : 'Online') : 'Offline';
                    var latencyText = m.available ? m.latency_ms + 'ms' : (m.status === 404 ? 'N/A' : 'Overloaded');

                    div.innerHTML = '<div><span class="gp-model-name">' + m.name + '</span>' +
                        '<span class="gp-model-latency">' + latencyText + '</span></div>' +
                        '<span class="gp-model-badge ' + badgeClass + '">' + badgeText + '</span>';

                    if (m.available) {
                        div.addEventListener('click', function () {
                            state.selectedModel = m.id;
                            $('gp-selected-model').value = m.id;
                            container.querySelectorAll('.gp-model-option').forEach(function (el) { el.classList.remove('selected'); });
                            div.classList.add('selected');
                        });
                    }
                    container.appendChild(div);
                });

                if (!state.selectedModel) {
                    var firstAvailable = models.find(function (m) { return m.available; });
                    if (firstAvailable) {
                        state.selectedModel = firstAvailable.id;
                        $('gp-selected-model').value = firstAvailable.id;
                        container.querySelector('.gp-model-option:not(.unavailable)')?.classList.add('selected');
                    }
                }
            })
            .catch(function () {
                container.innerHTML = '<div class="gp-model-loading">Could not check models</div>';
            });
    }

    function init() {
        var dropzone = $('gp-dropzone');
        var fileInput = $('gp-file-input');
        var sidebar = $('gp-sidebar');
        var sidebarToggle = $('gp-sidebar-toggle');

        if (sidebarToggle) sidebarToggle.addEventListener('click', function () {
            sidebar.classList.toggle('open');
            var overlay = $('gp-sidebar-overlay');
            if (overlay) {
                if (sidebar.classList.contains('open')) {
                    overlay.classList.add('visible');
                } else {
                    overlay.classList.remove('visible');
                }
            }
        });

        var sidebarOverlay = $('gp-sidebar-overlay');
        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', function () {
                sidebar.classList.remove('open');
                sidebarOverlay.classList.remove('visible');
            });
        }

        dropzone.addEventListener('click', function () { fileInput.click(); });
        dropzone.addEventListener('dragover', function (e) { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('dragover'); });
        dropzone.addEventListener('drop', function (e) {
            e.preventDefault(); dropzone.classList.remove('dragover');
            handleFiles(Array.from(e.dataTransfer.files));
        });
        fileInput.addEventListener('change', function (e) { handleFiles(Array.from(e.target.files)); fileInput.value = ''; });

        document.querySelectorAll('.gp-sample-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var sampleId = btn.dataset.sample;
                var sample = MMSamples.find(function (s) { return s.id === sampleId; });
                if (sample) {
                    var blob = new Blob([sample.svg], { type: 'image/svg+xml' });
                    var file = new File([blob], sample.name, { type: 'image/svg+xml' });
                    handleFiles([file]);
                }
            });
        });

        document.querySelectorAll('.gp-mode-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.gp-mode-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                state.mode = btn.dataset.mode;
                var metaSettings = $('gp-sidebar-settings');
                if (metaSettings) metaSettings.style.display = state.mode === 'metadata' ? '' : 'none';
                updateView();
            });
        });

        $('gp-btn-back').addEventListener('click', function () {
            state.selectedItem = null;
            state.view = 'batch';
            updateView();
        });
        $('gp-btn-regen-all').addEventListener('click', function () {
            if (state.selectedItem) generateSingle(state.selectedItem);
        });
        $('gp-btn-copy-all').addEventListener('click', function () {
            if (!state.selectedItem) return;
            var text = 'Title: ' + (state.selectedItem.title || '') + '\n\nDescription: ' + (state.selectedItem.description || '') + '\n\nKeywords: ' + (state.selectedItem.keywords || []).join(', ');
            navigator.clipboard.writeText(text); MMUI.showToast('Copied', 'All metadata copied', 'success');
        });
        $('gp-btn-csv').addEventListener('click', function () { MMExport.toCsv(state.items); });
        $('gp-btn-json').addEventListener('click', function () { MMExport.toJson(state.items); });

        // Sidebar sliders
        ['gp-min-title', 'gp-max-title', 'gp-min-kw', 'gp-max-kw', 'gp-min-desc', 'gp-max-desc'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('input', function () {
                state.settings.minTitleWords = parseInt($('gp-min-title').value);
                state.settings.maxTitleWords = parseInt($('gp-max-title').value);
                state.settings.minKeywords = parseInt($('gp-min-kw').value);
                state.settings.maxKeywords = parseInt($('gp-max-kw').value);
                state.settings.minDescriptionWords = parseInt($('gp-min-desc').value);
                state.settings.maxDescriptionWords = parseInt($('gp-max-desc').value);
                $('gp-title-val').textContent = state.settings.minTitleWords + ' – ' + state.settings.maxTitleWords;
                $('gp-kw-val').textContent = state.settings.minKeywords + ' – ' + state.settings.maxKeywords;
                $('gp-desc-val').textContent = state.settings.minDescriptionWords + ' – ' + state.settings.maxDescriptionWords;
                syncMetaSliders();
                saveSettings();
            });
        });

        // Main content sliders (sync with sidebar)
        ['gp-meta-min-title', 'gp-meta-max-title', 'gp-meta-min-kw', 'gp-meta-max-kw', 'gp-meta-min-desc', 'gp-meta-max-desc'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('input', function () {
                state.settings.minTitleWords = parseInt($('gp-meta-min-title').value);
                state.settings.maxTitleWords = parseInt($('gp-meta-max-title').value);
                state.settings.minKeywords = parseInt($('gp-meta-min-kw').value);
                state.settings.maxKeywords = parseInt($('gp-meta-max-kw').value);
                state.settings.minDescriptionWords = parseInt($('gp-meta-min-desc').value);
                state.settings.maxDescriptionWords = parseInt($('gp-meta-max-desc').value);
                $('gp-meta-title-val').textContent = state.settings.minTitleWords + ' – ' + state.settings.maxTitleWords;
                $('gp-meta-kw-val').textContent = state.settings.minKeywords + ' – ' + state.settings.maxKeywords;
                $('gp-meta-desc-val').textContent = state.settings.minDescriptionWords + ' – ' + state.settings.maxDescriptionWords;
                syncSidebarSliders();
                saveSettings();
            });
        });

        function syncMetaSliders() {
            var s = state.settings;
            $('gp-meta-min-title').value = s.minTitleWords; $('gp-meta-max-title').value = s.maxTitleWords;
            $('gp-meta-min-kw').value = s.minKeywords; $('gp-meta-max-kw').value = s.maxKeywords;
            $('gp-meta-min-desc').value = s.minDescriptionWords; $('gp-meta-max-desc').value = s.maxDescriptionWords;
            $('gp-meta-title-val').textContent = s.minTitleWords + ' – ' + s.maxTitleWords;
            $('gp-meta-kw-val').textContent = s.minKeywords + ' – ' + s.maxKeywords;
            $('gp-meta-desc-val').textContent = s.minDescriptionWords + ' – ' + s.maxDescriptionWords;
        }

        function syncSidebarSliders() {
            var s = state.settings;
            $('gp-min-title').value = s.minTitleWords; $('gp-max-title').value = s.maxTitleWords;
            $('gp-min-kw').value = s.minKeywords; $('gp-max-kw').value = s.maxKeywords;
            $('gp-min-desc').value = s.minDescriptionWords; $('gp-max-desc').value = s.maxDescriptionWords;
            $('gp-title-val').textContent = s.minTitleWords + ' – ' + s.maxTitleWords;
            $('gp-kw-val').textContent = s.minKeywords + ' – ' + s.maxKeywords;
            $('gp-desc-val').textContent = s.minDescriptionWords + ' – ' + s.maxDescriptionWords;
        }

        ['gp-single-kw', 'gp-silhouette', 'gp-transparent'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('change', function () {
                state.settings.singleWordKeywords = $('gp-single-kw').checked;
                state.settings.silhouette = $('gp-silhouette').checked;
                state.settings.transparent = $('gp-transparent').checked;
                saveSettings();
            });
        });

        $('gp-custom-prompt').addEventListener('change', function () {
            state.settings.customPromptEnabled = $('gp-custom-prompt').checked;
            $('gp-custom-prompt-text').hidden = !state.settings.customPromptEnabled;
            saveSettings();
        });
        $('gp-custom-prompt-text').addEventListener('input', function () {
            state.settings.customPromptText = $('gp-custom-prompt-text').value; saveSettings();
        });
        $('gp-prohibited').addEventListener('change', function () {
            state.settings.prohibitedWordsEnabled = $('gp-prohibited').checked;
            $('gp-prohibited-text').hidden = !state.settings.prohibitedWordsEnabled;
            saveSettings();
        });
        $('gp-prohibited-text').addEventListener('input', function () {
            state.settings.prohibitedWordsText = $('gp-prohibited-text').value; saveSettings();
        });

        function resetToDefaults() {
            state.settings = Object.assign({}, DEFAULT_SETTINGS);
            saveSettings(); applySettingsToUI(); syncMetaSliders(); updateView();
            MMUI.showToast('Reset', 'Settings reset to defaults', 'info');
        }

        $('gp-reset-btn').addEventListener('click', resetToDefaults);
        $('gp-meta-reset-btn').addEventListener('click', resetToDefaults);

        applySettingsToUI();
        syncMetaSliders();
        updateView();
        checkAndRenderModels();
    }

    function applySettingsToUI() {
        var s = state.settings;
        $('gp-min-title').value = s.minTitleWords; $('gp-max-title').value = s.maxTitleWords;
        $('gp-min-kw').value = s.minKeywords; $('gp-max-kw').value = s.maxKeywords;
        $('gp-min-desc').value = s.minDescriptionWords; $('gp-max-desc').value = s.maxDescriptionWords;
        $('gp-title-val').textContent = s.minTitleWords + ' – ' + s.maxTitleWords;
        $('gp-kw-val').textContent = s.minKeywords + ' – ' + s.maxKeywords;
        $('gp-desc-val').textContent = s.minDescriptionWords + ' – ' + s.maxDescriptionWords;
        $('gp-single-kw').checked = s.singleWordKeywords;
        $('gp-silhouette').checked = s.silhouette;
        $('gp-transparent').checked = s.transparent;
        $('gp-custom-prompt').checked = s.customPromptEnabled;
        $('gp-custom-prompt-text').hidden = !s.customPromptEnabled;
        $('gp-custom-prompt-text').value = s.customPromptText;
        $('gp-prohibited').checked = s.prohibitedWordsEnabled;
        $('gp-prohibited-text').hidden = !s.prohibitedWordsEnabled;
        $('gp-prohibited-text').value = s.prohibitedWordsText;
    }

    async function handleFiles(files) {
        if (!files || files.length === 0) return;

        var MAX_FILES = 500;
        if (files.length > MAX_FILES) {
            MMUI.showToast('Limit', 'Maximum ' + MAX_FILES + ' files allowed at once', 'error');
            files = Array.prototype.slice.call(files, 0, MAX_FILES);
        }

        try {
            $('gp-progress').style.display = '';
            $('gp-progress-fill').style.width = '0%';
            $('gp-progress-text').textContent = 'Processing files...';

            for (var i = 0; i < files.length; i++) {
                var pct = (i / files.length) * 100;
                $('gp-progress-fill').style.width = pct + '%';
                $('gp-progress-text').textContent = 'Processing ' + (i + 1) + '/' + files.length + ': ' + files[i].name;
                var item = await processFile(files[i]);
                state.items.push(item);
            }

            $('gp-progress').style.display = 'none';
            updateView();
        } catch (e) {
            console.error('[GP] handleFiles error:', e);
            $('gp-progress').style.display = 'none';
            updateView();
        }
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
