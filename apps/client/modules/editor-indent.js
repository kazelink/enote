import { getBlockFromRange } from './dom.js';

function isAtBlockStart(range, block) {
    const r = range.cloneRange();
    r.selectNodeContents(block);
    r.setEnd(range.startContainer, range.startOffset);
    return r.toString().length === 0;
}

export const IndentPlugin = {
    init(sq) {
        const origBackspace = sq._keyHandlers['Backspace'];
        sq.setKeyHandler('Backspace', (editor, event, range) => {
            if (range.collapsed) {
                const block = getBlockFromRange(range, editor.getRoot());
                if (block && block.classList.contains('indent') && isAtBlockStart(range, block)) {
                    event.preventDefault();
                    editor.saveUndoState(range);
                    block.classList.remove('indent');
                    editor._docWasChanged();
                    return;
                }
            }
            if (origBackspace) origBackspace(editor, event, range);
        });
    },

    getSelectedBlocks(sq) {
        const blocks = [];
        sq.forEachBlock((block) => {
            blocks.push(block);
        }, false);
        return blocks;
    },

    toggle(sq) {
        const selection = sq.getSelection();
        const blocks = this.getSelectedBlocks(sq);
        if (!blocks.length) return;

        sq.saveUndoState(selection);
        const shouldIndent = !blocks.every((block) => block.classList.contains('indent'));
        sq.forEachBlock((block) => {
            block.classList.toggle('indent', shouldIndent);
        }, false);
        sq._docWasChanged();
        sq.setSelection(selection);
        sq._updatePath?.(selection, true);
        sq.focus();
    },

    isActive(sq) {
        const selection = sq.getSelection();
        if (selection && !selection.collapsed) {
            const blocks = this.getSelectedBlocks(sq);
            return blocks.length > 0 && blocks.every((block) => block.classList.contains('indent'));
        }

        const path = sq.getPath();
        return /\.indent(?:\.|>|\[|$)/.test(path);
    }
};
