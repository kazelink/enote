import { UI } from './ui.js';
import { Nonce } from './api.js';
import { swalAlert } from './swal.js';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function normalizeMime(v) {
    const base = String(v || '').split(';')[0].trim().toLowerCase();
    return base === 'image/jpg' ? 'image/jpeg' : base;
}

function showUploadError(msg) {
    UI.setStatus('err');
    swalAlert('Upload Error', msg, 'error');
    setTimeout(() => UI.setStatus(''), 2000);
}

function createProgressWidget(editorWrapper, mime, cancelCb) {
    if (!editorWrapper) return null;

    const container = document.createElement('div');
    container.className = 'upload-widget';

    container.innerHTML = `
        <div class="upload-info-row">
            <span class="upload-title">
                <i class="${mime.startsWith('video/') ? 'ri-film-line' : 'ri-image-add-line'}"></i> Uploading...
            </span>
            <span class="upload-stats">
                <span class="upload-size">0 / 0 MB</span>
                <span class="upload-speed">0 B/s</span>
                <span class="upload-percent">0%</span>
                <button class="upload-cancel" title="Cancel Upload"><i class="ri-close-line"></i></button>
            </span>
        </div>
        <div class="upload-bar-wrapper">
            <div class="upload-progress-bar-inner"></div>
        </div>
    `;

    const els = {
        container,
        cancelBtn: container.querySelector('.upload-cancel'),
        progressText: container.querySelector('.upload-percent'),
        speedText: container.querySelector('.upload-speed'),
        sizeText: container.querySelector('.upload-size'),
        progressBar: container.querySelector('.upload-progress-bar-inner')
    };

    els.cancelBtn.onclick = cancelCb;
    editorWrapper.appendChild(container);
    return els;
}

export const Upload = {
    file(file, editorWrapper, onSuccess, onFinally) {
        const mime = normalizeMime(file?.type);
        if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
            showUploadError('Unsupported file type.');
            return null;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
            showUploadError('File too large (max 100MB).');
            return null;
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);
        xhr.setRequestHeader('Content-Type', mime);
        
        const authNonce = Nonce.get();
        if (authNonce) xhr.setRequestHeader('X-Session-Nonce', authNonce);

        const startTime = Date.now();
        
        const widget = createProgressWidget(editorWrapper, mime, () => {
            xhr.abort();
            if (widget?.container) widget.container.remove();
            UI.setStatus('');
        });

        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable || !widget) return;
            
            const percent = (e.loaded / e.total) * 100;
            widget.progressBar.style.width = percent + '%';
            widget.progressText.innerText = Math.round(percent) + '%';

            const timeElapsed = (Date.now() - startTime) / 1000;
            if (timeElapsed > 0.1) {
                let speedBytes = e.loaded / timeElapsed;
                let speedStr = speedBytes < 1024 * 1024
                    ? (speedBytes / 1024).toFixed(1) + ' KB/s'
                    : (speedBytes / (1024 * 1024)).toFixed(1) + ' MB/s';
                widget.speedText.innerText = speedStr;
            }

            const loadedMB = (e.loaded / (1024 * 1024)).toFixed(2);
            const totalMB = (e.total / (1024 * 1024)).toFixed(2);
            widget.sizeText.innerText = `${loadedMB} / ${totalMB} MB`;
        };

        const cleanup = () => {
            if (widget?.container) widget.container.remove();
            if (onFinally) onFinally();
        };

        xhr.onload = () => {
            cleanup();
            if (xhr.status === 401) {
                Nonce.clear();
                UI.showAuth();
                return;
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.url && onSuccess) onSuccess(data.url);
                } catch {
                    showUploadError('Upload failed: invalid server response.');
                }
            } else {
                let errMsg = `Upload failed (${xhr.status})`;
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data?.error) errMsg = `Upload failed: ${data.error}`;
                } catch { }
                showUploadError(errMsg);
            }
        };

        xhr.onerror = () => {
            cleanup();
            showUploadError('Upload failed: network error.');
        };

        xhr.onabort = cleanup;

        xhr.send(file);
        return xhr;
    }
};
