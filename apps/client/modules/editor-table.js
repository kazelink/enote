const CELL_SELECTOR = 'td, th';

function getCell(sq, range = sq.getSelection()) {
    const root = sq.getRoot();
    let node = range?.startContainer;
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentNode;

    const cell = node?.closest?.(CELL_SELECTOR);
    return cell && root.contains(cell) ? cell : null;
}

function getRows(table) {
    return Array.from(table.querySelectorAll('tr'));
}

function getCells(table) {
    return Array.from(table.querySelectorAll(CELL_SELECTOR));
}

function getColumnCount(table) {
    return Math.max(1, ...getRows(table).map((row) => row.cells.length));
}

function makeCell(doc, tag = 'td') {
    const cell = doc.createElement(tag);
    cell.appendChild(doc.createElement('br'));
    return cell;
}

function makeRow(doc, cols, tag = 'td') {
    const row = doc.createElement('tr');
    for (let i = 0; i < cols; i += 1) {
        row.appendChild(makeCell(doc, tag));
    }
    return row;
}

function createTable(doc, rows = 3, cols = 3) {
    const table = doc.createElement('table');
    const tbody = doc.createElement('tbody');
    const safeRows = Math.max(1, Math.min(12, Number(rows) || 3));
    const safeCols = Math.max(1, Math.min(8, Number(cols) || 3));

    for (let r = 0; r < safeRows; r += 1) {
        tbody.appendChild(makeRow(doc, safeCols));
    }

    table.appendChild(tbody);
    return table;
}

function ensureCellContent(cell) {
    if (!cell.childNodes.length) {
        cell.appendChild(cell.ownerDocument.createElement('br'));
    }
}

function selectCell(sq, cell) {
    if (!cell) return false;
    ensureCellContent(cell);

    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(true);
    sq.focus();
    sq.setSelection(range);
    sq._updatePath?.(range, true);
    return true;
}

function selectBlockAfter(sq, table) {
    const doc = table.ownerDocument;
    let block = table.nextElementSibling;
    if (!block || !/^(P|DIV)$/i.test(block.nodeName)) {
        block = doc.createElement('p');
        block.appendChild(doc.createElement('br'));
        table.parentNode.insertBefore(block, table.nextSibling);
    }

    const range = document.createRange();
    range.setStart(block, 0);
    range.collapse(true);
    sq.focus();
    sq.setSelection(range);
    sq._updatePath?.(range, true);
}

function tableFromCell(cell) {
    return cell?.closest?.('table') || null;
}

function insertRowAfter(sq, cell) {
    const table = tableFromCell(cell);
    const row = cell?.closest?.('tr');
    if (!table || !row) return false;

    const range = sq.getSelection();
    const cellIndex = Math.max(0, cell.cellIndex);
    const newRow = makeRow(table.ownerDocument, getColumnCount(table));

    sq.saveUndoState(range);
    row.parentNode.insertBefore(newRow, row.nextSibling);
    sq._docWasChanged();
    return selectCell(sq, newRow.cells[Math.min(cellIndex, newRow.cells.length - 1)]);
}

function insertColumnAfter(sq, cell) {
    const table = tableFromCell(cell);
    const currentRow = cell?.closest?.('tr');
    if (!table || !currentRow) return false;

    const range = sq.getSelection();
    const cellIndex = Math.max(0, cell.cellIndex);
    let targetCell = null;

    sq.saveUndoState(range);
    getRows(table).forEach((row) => {
        const ref = row.cells[Math.min(cellIndex, row.cells.length - 1)];
        const tag = row.parentElement?.nodeName === 'THEAD' || ref?.nodeName === 'TH' ? 'th' : 'td';
        const newCell = makeCell(table.ownerDocument, tag);
        row.insertBefore(newCell, ref?.nextSibling || null);
        if (row === currentRow) targetCell = newCell;
    });
    sq._docWasChanged();
    return selectCell(sq, targetCell);
}

function removeRow(sq, cell) {
    const table = tableFromCell(cell);
    const row = cell?.closest?.('tr');
    if (!table || !row) return false;

    const rows = getRows(table);
    if (rows.length <= 1) return removeTable(sq, cell);

    const range = sq.getSelection();
    const rowIndex = rows.indexOf(row);
    const cellIndex = Math.max(0, cell.cellIndex);
    const nextRow = rows[rowIndex + 1] || rows[rowIndex - 1];

    sq.saveUndoState(range);
    row.remove();
    sq._docWasChanged();
    return selectCell(sq, nextRow?.cells[Math.min(cellIndex, nextRow.cells.length - 1)] || table.querySelector(CELL_SELECTOR));
}

function removeColumn(sq, cell) {
    const table = tableFromCell(cell);
    const currentRow = cell?.closest?.('tr');
    if (!table || !currentRow) return false;

    const rows = getRows(table);
    const maxCells = Math.max(0, ...rows.map((row) => row.cells.length));
    if (maxCells <= 1) return removeTable(sq, cell);

    const range = sq.getSelection();
    const cellIndex = Math.max(0, cell.cellIndex);

    sq.saveUndoState(range);
    rows.forEach((row) => row.cells[cellIndex]?.remove());
    sq._docWasChanged();

    const nextIndex = Math.max(0, Math.min(cellIndex, currentRow.cells.length - 1));
    return selectCell(sq, currentRow.cells[nextIndex] || table.querySelector(CELL_SELECTOR));
}

function removeTable(sq, cell) {
    const table = tableFromCell(cell);
    if (!table) return false;

    const range = sq.getSelection();
    sq.saveUndoState(range);
    selectBlockAfter(sq, table);
    table.remove();
    sq._docWasChanged();
    return true;
}

function moveByCell(sq, direction) {
    const cell = getCell(sq);
    const table = tableFromCell(cell);
    if (!cell || !table) return false;

    const cells = getCells(table);
    const index = cells.indexOf(cell);
    let target = cells[index + direction];

    if (!target && direction > 0) {
        const rows = getRows(table);
        const lastRow = rows[rows.length - 1];
        const newRow = makeRow(table.ownerDocument, getColumnCount(table));

        sq.saveUndoState(sq.getSelection());
        lastRow.parentNode.insertBefore(newRow, lastRow.nextSibling);
        sq._docWasChanged();
        target = newRow.cells[0];
    }

    if (target) selectCell(sq, target);
    return true;
}

export const TablePlugin = {
    init(sq) {
        const origTab = sq._keyHandlers.Tab;
        const origShiftTab = sq._keyHandlers['Shift-Tab'];

        sq.setKeyHandler('Tab', (editor, event, range) => {
            if (getCell(editor, range)) {
                event.preventDefault();
                moveByCell(editor, 1);
                return;
            }
            if (origTab) origTab(editor, event, range);
        });

        sq.setKeyHandler('Shift-Tab', (editor, event, range) => {
            if (getCell(editor, range)) {
                event.preventDefault();
                moveByCell(editor, -1);
                return;
            }
            if (origShiftTab) origShiftTab(editor, event, range);
        });
    },

    insertTable(sq, rows = 3, cols = 3) {
        const table = createTable(sq.getRoot().ownerDocument, rows, cols);
        sq.saveUndoState(sq.getSelection());
        sq.insertElement(table);
        sq._docWasChanged();
        return selectCell(sq, table.querySelector(CELL_SELECTOR));
    },

    insertRow(sq) {
        return insertRowAfter(sq, getCell(sq));
    },

    insertColumn(sq) {
        return insertColumnAfter(sq, getCell(sq));
    },

    deleteRow(sq) {
        return removeRow(sq, getCell(sq));
    },

    deleteColumn(sq) {
        return removeColumn(sq, getCell(sq));
    },

    deleteTable(sq) {
        return removeTable(sq, getCell(sq));
    },

    isActive(sq) {
        return !!getCell(sq);
    }
};
