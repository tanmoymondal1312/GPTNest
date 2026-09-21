window.MMUI = (function () {
    var PLATFORMS = {
        'adobe-stock': { name: 'Adobe Stock', maxKeywords: 49, recommended: 45, maxTitle: 200, requiresDesc: true, firstPriority: true },
        'general': { name: 'General Stock', maxKeywords: 49, recommended: 40, maxTitle: 200, requiresDesc: true, firstPriority: false },
        'magnific': { name: 'Magnific AI', maxKeywords: 40, recommended: 35, maxTitle: 220, requiresDesc: true, firstPriority: true },
        'shutterstock': { name: 'Shutterstock', maxKeywords: 50, recommended: 45, maxTitle: 200, requiresDesc: true, firstPriority: false },
        'vecteezy': { name: 'Vecteezy', maxKeywords: 45, recommended: 35, maxTitle: 180, requiresDesc: false, firstPriority: true },
        'depositphotos': { name: 'Depositphotos', maxKeywords: 50, recommended: 40, maxTitle: 200, requiresDesc: true, firstPriority: false },
        '123rf': { name: '123RF', maxKeywords: 50, recommended: 40, maxTitle: 160, requiresDesc: true, firstPriority: false },
        'dreamstime': { name: 'Dreamstime', maxKeywords: 50, recommended: 45, maxTitle: 200, requiresDesc: true, firstPriority: false },
    };

    function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
    function formatSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }
    function nameWithoutExt(n) { return n.replace(/\.[^/.]+$/, '') || 'file'; }

    function showToast(title, message, type) {
        var container = document.getElementById('gp-toast-container');
        if (!container) return;
        var t = document.createElement('div');
        t.className = 'gp-toast ' + (type || 'info');
        t.innerHTML = '<strong>' + escapeHtml(title) + '</strong> ' + escapeHtml(message);
        container.appendChild(t);
        setTimeout(function () { t.remove(); }, 3500);
    }

    function renderPlatformTabs(container, active, onSelect) {
        container.innerHTML = '';
        Object.keys(PLATFORMS).forEach(function (id) {
            var p = PLATFORMS[id];
            var btn = document.createElement('button');
            btn.className = 'gp-platform-tab' + (id === active ? ' active' : '');
            btn.innerHTML = p.name + '<span class="gp-platform-kw">(' + p.maxKeywords + ' kw)</span>';
            btn.addEventListener('click', function () { onSelect(id); });
            container.appendChild(btn);
        });
    }

    function adaptMetadataForPlatform(analysis, baseMetadata, platformId, settings) {
        var pc = PLATFORMS[platformId] || PLATFORMS['adobe-stock'];
        var maxKw = Math.min(settings.maxKeywords || 49, pc.maxKeywords);

        var aiKeywords = (baseMetadata && baseMetadata.keywords) ? baseMetadata.keywords.slice() : [];

        if (aiKeywords.length < 8) {
            var supplementary = [];
            if (analysis && analysis.main_subject) {
                analysis.main_subject.toLowerCase().split(/\s+/).forEach(function (w) { if (w.length > 2) supplementary.push(w); });
            }
            if (analysis && analysis.objects) {
                analysis.objects.forEach(function (o) { supplementary.push(o.toLowerCase()); });
            }
            if (analysis && analysis.style) supplementary.push(analysis.style.toLowerCase());
            if (analysis && analysis.content_type) supplementary.push(analysis.content_type.toLowerCase());
            if (analysis && analysis.theme) supplementary.push(analysis.theme.toLowerCase());

            var existingLower = aiKeywords.map(function (k) { return k.toLowerCase(); });
            supplementary.forEach(function (s) {
                var sl = s.trim().toLowerCase().replace(/^[,\.\-_:;]+|[,\.\-_:;]+$/g, '');
                if (sl && sl.length > 2 && existingLower.indexOf(sl) === -1) {
                    aiKeywords.push(sl);
                    existingLower.push(sl);
                }
            });
        }

        var finalKw = aiKeywords.slice(0, maxKw);

        var title = (baseMetadata && baseMetadata.title) ? baseMetadata.title.trim() : '';
        var desc = (baseMetadata && baseMetadata.description) ? baseMetadata.description.trim() : '';

        var titleWords = title.split(/\s+/).filter(Boolean);
        var minTitle = settings.minTitleWords || 8;
        var maxTitle = settings.maxTitleWords || 22;
        var minDesc = settings.minDescriptionWords || 18;

        var accuracy = Math.min(99, Math.max(60, 96 - (titleWords.length < minTitle ? 8 : titleWords.length > maxTitle ? 4 : 0) - (finalKw.length < 15 ? 6 : 0)));
        var relevance = Math.min(99, Math.max(60, 94 + (titleWords.length >= minTitle && titleWords.length <= maxTitle ? 2 : -4) + (desc.split(/\s+/).length >= minDesc ? 2 : -3)));
        var kwRatio = Math.min(1, finalKw.length / Math.min(49, settings.maxKeywords || 49));
        var seo = Math.round(75 + kwRatio * 23);
        if (finalKw.length >= 40) seo = Math.min(99, seo + 2);
        seo = Math.max(60, Math.min(99, seo));

        return {
            title: title,
            description: desc,
            keywords: finalKw,
            primaryCategory: (baseMetadata && baseMetadata.category) || 'Graphic Resources',
            secondaryCategory: (baseMetadata && baseMetadata.secondary_category) || 'Illustration',
            qualityScore: { accuracy: accuracy, relevance: relevance, seoPotential: seo },
            validation: { keywordCount: finalKw.length, titleWordCount: titleWords.length },
        };
    }

    function renderDetailView(container, item, platform, callbacks) {
        var a = item.analysis || {};
        var conf = item.confidence || 90;
        var confClass = conf >= 80 ? 'high' : conf >= 60 ? 'medium' : 'low';
        var kw = item.keywords || [];
        var qs = item.qualityScore || { accuracy: 90, relevance: 90, seoPotential: 85 };

        container.innerHTML =
            '<div class="gp-detail">' +
            '<div class="gp-col-left">' +
            '<div class="gp-preview-card">' +
            '<div class="gp-card-title" style="margin-bottom:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> File Preview</div>' +
            '<img class="gp-preview-img checkerboard" src="' + (item.previewUrl || '') + '" alt="Preview">' +
            '<div class="gp-tech-specs">' +
            (item.technicalDetails ? '<span class="gp-tech-badge">' + (item.technicalDetails.width || '?') + 'x' + (item.technicalDetails.height || '?') + '</span><span class="gp-tech-badge">' + (item.technicalDetails.orientation || '') + '</span>' : '') +
            '<span class="gp-tech-badge">' + escapeHtml(item.mimeType || '') + '</span>' +
            '<span class="gp-tech-badge">' + (a.background || 'Transparent') + '</span>' +
            '</div></div>' +
            '<div class="gp-preview-card">' +
            '<div class="gp-card-title" style="margin-bottom:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg> AI Visual Inventory</div>' +
            '<p style="font-size:0.82rem;color:var(--text-muted);margin:0 0 8px"><strong style="color:var(--text-primary)">Main Subject:</strong> ' + escapeHtml(a.main_subject || item.mainSubject || 'Not analyzed') + '</p>' +
            (a.objects && a.objects.length ? '<div class="gp-tag-list">' + a.objects.map(function (o) { return '<span class="gp-tag">' + escapeHtml(o) + '</span>'; }).join('') + '</div>' : '') +
            (a.visible_text && a.visible_text.length ? '<p style="font-size:0.75rem;margin:10px 0 6px;color:var(--text-muted)">Visible Text:</p><div class="gp-tag-list">' + a.visible_text.map(function (t) { return '<span class="gp-tag amber">' + escapeHtml(t) + '</span>'; }).join('') + '</div>' : '') +
            '<p style="font-size:0.75rem;margin:10px 0 4px;color:var(--text-muted)"><strong>Style:</strong> ' + escapeHtml(a.style || 'N/A') + ' | <strong>Type:</strong> ' + escapeHtml(a.content_type || 'N/A') + '</p>' +
            (item.dominantColors && item.dominantColors.length ? '<div style="margin-top:8px">' + item.dominantColors.map(function (c) { return '<span class="gp-color-chip" style="background:' + escapeHtml(c) + '" title="' + escapeHtml(c) + '"></span>'; }).join(' ') + '</div>' : '') +
            '<div style="margin-top:10px"><span class="gp-confidence ' + confClass + '">' + conf + '% confidence</span></div>' +
            '</div>' +
            '<div class="gp-preview-card">' +
            '<div class="gp-card-title" style="margin-bottom:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg> Quality Score</div>' +
            '<div class="gp-score-row"><span class="gp-score-label">Visual Accuracy</span><div class="gp-score-track"><div class="gp-score-fill" style="width:' + qs.accuracy + '%"></div></div><span class="gp-score-val">' + qs.accuracy + '</span></div>' +
            '<div class="gp-score-row"><span class="gp-score-label">Keyword Relevance</span><div class="gp-score-track"><div class="gp-score-fill" style="width:' + qs.relevance + '%"></div></div><span class="gp-score-val">' + qs.relevance + '</span></div>' +
            '<div class="gp-score-row"><span class="gp-score-label">SEO Potential</span><div class="gp-score-track"><div class="gp-score-fill" style="width:' + qs.seoPotential + '%"></div></div><span class="gp-score-val">' + qs.seoPotential + '</span></div>' +
            '</div></div>' +
            '<div class="gp-col-right">' +
            '<div class="gp-preview-card">' +
            '<div class="gp-field"><label class="gp-field-label">Title <span class="gp-field-count">' + (item.title || '').split(/\s+/).filter(Boolean).length + ' words</span></label>' +
            '<input type="text" id="gp-edit-title" value="' + escapeHtml(item.title || '') + '" placeholder="Enter title...">' +
            '<div class="gp-field-actions"><button class="gp-field-btn" data-action="regen-title" type="button">↻ Regenerate</button><button class="gp-field-btn" data-action="copy-title" type="button">📋 Copy</button></div></div>' +
            '<div class="gp-field"><label class="gp-field-label">Description <span class="gp-field-count">' + (item.description || '').split(/\s+/).filter(Boolean).length + ' words</span></label>' +
            '<textarea id="gp-edit-desc" placeholder="Enter description...">' + escapeHtml(item.description || '') + '</textarea>' +
            '<div class="gp-field-actions"><button class="gp-field-btn" data-action="regen-desc" type="button">↻ Regenerate</button><button class="gp-field-btn" data-action="copy-desc" type="button">📋 Copy</button></div></div>' +
            '<div class="gp-field"><div class="gp-keywords-header"><label class="gp-field-label" style="margin:0">Keywords <span class="gp-keywords-count">' + kw.length + ' / ' + (PLATFORMS[platform] ? PLATFORMS[platform].maxKeywords : 49) + '</span></label>' +
            '<div class="gp-keywords-toolbar"><button class="gp-field-btn" data-action="sort-kw" type="button">A-Z</button><button class="gp-field-btn" data-action="regen-kw" type="button">↻ Regenerate</button><button class="gp-field-btn" data-action="copy-kw" type="button">📋 Copy All</button></div></div>' +
            '<div class="gp-keyword-tags" id="gp-keyword-tags">' +
            kw.map(function (k, i) {
                return '<span class="gp-kw-tag' + (i < 10 ? ' top-10' : '') + '">' +
                    (i < 10 ? '<span class="gp-kw-rank">#' + (i + 1) + '</span> ' : '') +
                    escapeHtml(k) +
                    (i < 10 ? '<button class="gp-kw-move" data-dir="left" data-idx="' + i + '" aria-label="Move left">&#9664;</button>' : '') +
                    (i < kw.length - 1 && i < 10 ? '<button class="gp-kw-move" data-dir="right" data-idx="' + i + '" aria-label="Move right">&#9654;</button>' : '') +
                    '<button class="gp-kw-remove" data-idx="' + i + '" aria-label="Remove keyword">&times;</button></span>';
            }).join('') +
            '</div>' +
            '<div class="gp-add-kw"><input type="text" id="gp-add-kw-input" placeholder="Add keyword..."><button id="gp-add-kw-btn" type="button">Add</button></div>' +
            '</div></div></div>';

        if (callbacks.onBind) callbacks.onBind();
    }

    function renderBatchView(container, items, platform, callbacks) {
        var done = items.filter(function (i) { return i.status === 'completed'; }).length;
        var failed = items.filter(function (i) { return i.status === 'error'; }).length;
        var analyzing = items.filter(function (i) { return i.status === 'analyzing'; }).length;
        var pending = items.filter(function (i) { return i.status === 'idle' || i.status === 'preview_ready'; }).length;
        var renderEps = items.filter(function (i) { return i.status === 'rendering_eps'; }).length;

        container.innerHTML =
            '<div class="gp-batch-header">' +
            '<div class="gp-batch-stats"><strong>' + items.length + '</strong> files' +
            ' &middot; <strong style="color:var(--success)">' + done + '</strong> done' +
            ' &middot; <strong style="color:#06b6d4">' + (analyzing + renderEps) + '</strong> processing' +
            ' &middot; <strong style="color:var(--text-muted)">' + pending + '</strong> pending' +
            (failed > 0 ? ' &middot; <strong style="color:var(--error)">' + failed + '</strong> failed' : '') +
            '</div>' +
            '<div class="gp-batch-actions">' +
            '<button class="gp-field-btn primary" id="gp-batch-export-csv" type="button">📥 Download CSV</button>' +
            '<button class="gp-field-btn" id="gp-batch-export-json" type="button">📥 JSON</button>' +
            '</div></div>' +
            '<table class="gp-table"><thead><tr><th>Preview</th><th>Filename</th><th>Title</th><th>Keywords</th><th>Status</th><th></th></tr></thead><tbody>' +
            items.map(function (item, idx) {
                var statusClass = item.status === 'completed' ? 'done' : item.status === 'analyzing' ? 'analyzing' : item.status === 'error' ? 'failed' : 'ready';
                var statusText = item.status === 'completed' ? 'Done' : item.status === 'analyzing' ? 'Analyzing...' : item.status === 'rendering_eps' ? 'Rendering...' : item.status === 'error' ? 'Failed' : 'Ready';
                var errorTip = item.status === 'error' && item.errorMessage ? ' title="' + escapeHtml(item.errorMessage) + '"' : '';
                return '<tr data-idx="' + idx + '">' +
                    '<td><img class="gp-table-thumb" src="' + (item.previewUrl || '') + '" alt=""></td>' +
                    '<td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtml(item.fileName) + '">' + escapeHtml(item.fileName) + '</td>' +
                    '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(item.title || (item.status === 'error' ? (item.errorMessage || '—') : '—')) + '</td>' +
                    '<td>' + (item.keywords ? item.keywords.length : 0) + '</td>' +
                    '<td><span class="gp-status-badge ' + statusClass + '"' + errorTip + '>' + statusText + '</span></td>' +
                    '<td class="gp-view-hint">View →</td></tr>';
            }).join('') +
            '</tbody></table>';

        if (callbacks.onBind) callbacks.onBind();
    }

    function renderPromptView(container, item) {
        var pr = item.promptResult || {};
        container.innerHTML =
            '<div class="gp-detail">' +
            '<div class="gp-col-left"><div class="gp-preview-card"><div class="gp-card-title" style="margin-bottom:12px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg> Source Artwork</div>' +
            '<img class="gp-preview-img" src="' + (item.previewUrl || '') + '" alt="Preview">' +
            '<div class="gp-prompt-section"><h4>Style & Medium</h4><p style="font-size:0.85rem;margin:0;color:var(--text-primary)">' + escapeHtml(pr.style || 'N/A') + '</p></div>' +
            '<div class="gp-prompt-section"><h4>Lighting</h4><p style="font-size:0.85rem;margin:0;color:var(--text-primary)">' + escapeHtml(pr.lighting || 'N/A') + '</p></div>' +
            '<div class="gp-prompt-section"><h4>Composition</h4><p style="font-size:0.85rem;margin:0;color:var(--text-primary)">' + escapeHtml(pr.composition || 'N/A') + '</p></div>' +
            '<div class="gp-prompt-section"><h4>Camera</h4><p style="font-size:0.85rem;margin:0;color:var(--text-primary)">' + escapeHtml(pr.camera || 'N/A') + '</p></div>' +
            (pr.colors ? '<div class="gp-prompt-section"><h4>Colors</h4><div>' + pr.colors.map(function (c) { return '<span class="gp-tag">' + escapeHtml(c) + '</span>'; }).join(' ') + '</div></div>' : '') +
            '</div></div>' +
            '<div class="gp-col-right">' +
            '<div class="gp-preview-card"><div class="gp-prompt-section"><h4>Positive Prompt</h4><div class="gp-prompt-box">' + escapeHtml(pr.prompt || '') + '</div><button class="gp-field-btn" style="margin-top:8px" onclick="navigator.clipboard.writeText(\'' + escapeHtml((pr.prompt || '').replace(/'/g, "\\'")) + '\')">📋 Copy Prompt</button></div></div>' +
            '<div class="gp-preview-card"><div class="gp-prompt-section"><h4>Negative Prompt</h4><div class="gp-prompt-box gp-prompt-negative">' + escapeHtml(pr.negativePrompt || '') + '</div><button class="gp-field-btn" style="margin-top:8px" onclick="navigator.clipboard.writeText(\'' + escapeHtml((pr.negativePrompt || '').replace(/'/g, "\\'")) + '\')">📋 Copy Negative</button></div></div>' +
            '<div class="gp-preview-card"><div class="gp-prompt-section"><h4>Parameters</h4><div class="gp-prompt-box gp-prompt-params">' + escapeHtml(pr.parameters || '') + '</div></div></div>' +
            '</div></div>';
    }

    return {
        PLATFORMS: PLATFORMS,
        escapeHtml: escapeHtml,
        formatSize: formatSize,
        nameWithoutExt: nameWithoutExt,
        showToast: showToast,
        renderPlatformTabs: renderPlatformTabs,
        adaptMetadataForPlatform: adaptMetadataForPlatform,
        renderDetailView: renderDetailView,
        renderBatchView: renderBatchView,
        renderPromptView: renderPromptView,
    };
})();
