import { Utils } from './dom.js';

export const ImagePlugin = {
    wrapper: null,
    currImg: null,
    _imgToolbar: null,
    _raf: null,
    _onChange: null,
    isResizing: false,

    init(sq, wrapper, imgToolbar, onChange) {
        this.wrapper = wrapper;
        this._imgToolbar = imgToolbar;
        this._onChange = onChange;

        const root = sq.getRoot();

        root.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'IMG') {
                this.select(e.target);
            } else {
                this.deselect();
            }
        });

        root.addEventListener('scroll', () => this._schedulePosition());

        if (imgToolbar) {
            imgToolbar.addEventListener('mousedown', (e) => {
                if (e.target.classList.contains('it-btn') && this.currImg) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.currImg.style.width = e.target.dataset.w + '%';
                    this._schedulePosition();

                    this.isResizing = true;
                    if (this._onChange) this._onChange();
                    setTimeout(() => { this.isResizing = false; }, 0);
                }
            });
        }
    },

    select(img) {
        if (this.currImg === img) return;
        this.deselect();
        this.currImg = img;
        img.classList.add('img-selected');
        if (this._imgToolbar) this._imgToolbar.classList.add('show');

        const parent = img.parentElement;
        Utils.$('btn-center')?.classList.toggle('active', parent?.style.textAlign === 'center');
        this._schedulePosition();
    },

    deselect() {
        if (!this.currImg) return;
        this.currImg.classList.remove('img-selected');
        this.currImg = null;
        if (this._imgToolbar) this._imgToolbar.classList.remove('show');
    },

    toggleCenter() {
        const parent = this.currImg?.parentElement;
        if (!parent) return;
        parent.style.textAlign = parent.style.textAlign === 'center' ? 'left' : 'center';
        this._schedulePosition();
        Utils.$('btn-center')?.classList.toggle('active', parent.style.textAlign === 'center');
        if (this._onChange) {
            this.isResizing = true;
            this._onChange();
            setTimeout(() => { this.isResizing = false; }, 0);
        }
    },

    _schedulePosition() {
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
            this._raf = null;
            if (!this.currImg || !this.wrapper || !this._imgToolbar) return;

            const er = this.wrapper.getBoundingClientRect();
            const ir = this.currImg.getBoundingClientRect();

            const visibleTop = Math.max(ir.top, er.top);
            const visibleBottom = Math.min(ir.bottom, er.bottom);

            let topPos = (visibleTop + visibleBottom) / 2 - er.top - 15;

            this._imgToolbar.style.top = `${topPos}px`;
            this._imgToolbar.style.left = `${(ir.left + ir.width / 2) - er.left}px`;
        });
    },

    cancelRaf() {
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    }
};
