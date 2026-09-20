window.ToolCommon = (function () {
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : str;
        return div.innerHTML;
    }

    function nameWithoutExt(name) {
        return name.replace(/\.[^/.]+$/, '') || 'file';
    }

    function extOf(name) {
        const m = /\.[^/.]+$/.exec(name);
        return m ? m[0] : '';
    }

    function base64Size(dataUrlOrB64) {
        const clean = dataUrlOrB64.split(',').pop();
        const padding = (clean.match(/=+$/) || [''])[0].length;
        return Math.floor((clean.length * 3) / 4) - padding;
    }

    function setupDropzone(opts) {
        const { dropzone, fileInput, fileList, submitBtn, maxFiles, accept, extraChip, onChange } = opts;
        let selectedFiles = [];

        function render() {
            fileList.innerHTML = '';
            selectedFiles.forEach((file, i) => {
                const li = document.createElement('li');
                li.className = 'file-chip';
                li.innerHTML =
                    '<span class="file-chip-name">' + escapeHtml(file.name) + '</span>' +
                    '<span class="file-chip-size">' + formatSize(file.size) + '</span>' +
                    (extraChip ? extraChip(file, i) : '') +
                    '<button type="button" class="file-chip-remove" data-index="' + i +
                    '" aria-label="Remove ' + escapeHtml(file.name) + '">&times;</button>';
                fileList.appendChild(li);
            });
            submitBtn.disabled = selectedFiles.length === 0;
            if (onChange) onChange(selectedFiles);
        }

        function addFiles(fileArray) {
            for (const file of fileArray) {
                if (accept && !accept(file)) continue;
                if (selectedFiles.length >= maxFiles) break;
                if (selectedFiles.some((f) => f.name === file.name && f.size === file.size)) continue;
                selectedFiles.push(file);
            }
            render();
        }

        fileInput.addEventListener('change', (e) => {
            addFiles(Array.from(e.target.files));
            fileInput.value = '';
        });

        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInput.click();
            }
        });
        ['dragenter', 'dragover'].forEach((evt) =>
            dropzone.addEventListener(evt, (e) => {
                e.preventDefault();
                dropzone.classList.add('is-dragover');
            })
        );
        ['dragleave', 'drop'].forEach((evt) =>
            dropzone.addEventListener(evt, (e) => {
                e.preventDefault();
                dropzone.classList.remove('is-dragover');
            })
        );
        dropzone.addEventListener('drop', (e) => addFiles(Array.from(e.dataTransfer.files)));

        fileList.addEventListener('click', (e) => {
            const btn = e.target.closest('.file-chip-remove');
            if (!btn) return;
            selectedFiles.splice(Number(btn.dataset.index), 1);
            render();
        });

        return {
            getFiles: () => selectedFiles,
            reset: () => {
                selectedFiles = [];
                render();
            },
        };
    }

    function setupProgress({ progress, fill, text }) {
        return {
            show() {
                progress.hidden = false;
            },
            set(fraction, message) {
                fill.style.width = Math.round(fraction * 100) + '%';
                text.textContent = message;
            },
        };
    }

    return {
        formatSize,
        escapeHtml,
        nameWithoutExt,
        extOf,
        base64Size,
        setupDropzone,
        setupProgress,
    };
})();
