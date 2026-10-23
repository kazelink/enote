import { loadScript } from './dom.js';

const SWAL_SRC = '/assets/sweetalert2.all.min.js';
const SWAL_TARGET_SELECTOR = '#swal-root';

const BASE_SWAL_OPTIONS = {
    scrollbarPadding: false,
    heightAuto: false,
    backdrop: false,
    returnFocus: false
};

function getSwalTarget() {
    return document.querySelector(SWAL_TARGET_SELECTOR) || document.body;
}

function ensureSwal() {
    if (typeof Swal !== 'undefined') return Promise.resolve();
    return loadScript(SWAL_SRC);
}

function fireSwal(options) {
    return Swal.fire({
        ...BASE_SWAL_OPTIONS,
        target: getSwalTarget(),
        ...options
    });
}

export async function swalAlert(title, text, icon = 'info') {
    try {
        await ensureSwal();
        return fireSwal({ title, text: text || '', icon });
    } catch (e) {
        console.error(e);
        window.alert(`${title}${text ? '\n' + text : ''}`);
        return { isConfirmed: true };
    }
}

export async function swalConfirm(title, text) {
    try {
        await ensureSwal();
        const result = await fireSwal({
            title,
            text: text || '',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel'
        });
        return result.isConfirmed;
    } catch (e) {
        console.error(e);
        return window.confirm(`${title}${text ? '\n' + text : ''}`);
    }
}

export async function swalPrompt(title, text, inputPlaceholder = '', inputValue = '', confirmButtonText = 'Create') {
    try {
        await ensureSwal();
        const result = await fireSwal({
            title,
            text: text || '',
            input: 'text',
            inputValue,
            inputPlaceholder,
            inputAttributes: {
                maxlength: '60',
                autocapitalize: 'off',
                autocorrect: 'off'
            },
            showCancelButton: true,
            confirmButtonText,
            cancelButtonText: 'Cancel',
            inputValidator: (value) => {
                if (!String(value || '').trim()) return 'This field is required.';
                return null;
            }
        });
        return result.isConfirmed ? String(result.value || '').trim() : null;
    } catch (e) {
        console.error(e);
        const value = window.prompt(`${title}${text ? '\n' + text : ''}`, inputValue);
        const trimmed = String(value || '').trim();
        return trimmed || null;
    }
}

export async function swalUnsaved(saveCallback) {
    try {
        await ensureSwal();
        const result = await fireSwal({
            title: 'Unsaved Changes',
            icon: 'warning',
            showDenyButton: true,
            showCancelButton: true,
            confirmButtonText: 'Save',
            denyButtonText: 'Discard',
            cancelButtonText: 'Cancel'
        });
        if (result.isConfirmed) return await saveCallback();
        if (result.isDenied) return true;   // discard
        return false;                       // cancel
    } catch (e) {
        console.error(e);
        const wantSave = window.confirm('Save changes? OK=Save, Cancel=Choose discard/stay');
        if (wantSave) return await saveCallback();
        return window.confirm('Discard changes? OK=Discard, Cancel=Stay');
    }
}
