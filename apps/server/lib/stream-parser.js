const SEARCH_BUFFER_TAIL = 128;
const ROOT_ARRAY_RE = /^\s*\[/;
const ROOT_OBJECT_RE = /^\s*\{/;
const ARRAY_MARKERS = [
  { kind: 'folders', regex: /"folders"\s*:\s*\[/ },
  { kind: 'notes', regex: /"(?:notes|diaries|entries|list)"\s*:\s*\[/ }
];

export function createStreamingBackupParser({ onFolder, onNote }) {
  let mode = 'detectRoot', rootType = '', currentArrayKind = '', searchBuffer = '';
  let itemBuffer = '', itemDepth = 0, itemStarted = false, inString = false, escapeNext = false;
  let sawRelevantArray = false, sawNoteArray = false;

  const resetItemState = () => {
    itemBuffer = ''; itemDepth = 0; itemStarted = false; inString = false; escapeNext = false;
  };

  const activateArray = (kind) => {
    currentArrayKind = kind;
    mode = 'array';
    sawRelevantArray = true;
    if (kind === 'notes') sawNoteArray = true;
  };

  const emitCurrentItem = async () => {
    const raw = itemBuffer.trim();
    resetItemState();
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (currentArrayKind === 'folders') await onFolder(parsed);
    else if (currentArrayKind === 'notes') await onNote(parsed);
    else throw new Error('Invalid backup format');
  };

  const closeCurrentArray = () => {
    resetItemState();
    currentArrayKind = '';
    mode = rootType === 'array' ? 'done' : 'seekArrays';
  };

  const processArrayChar = async (char) => {
    if (!itemStarted) {
      if (/\s/.test(char) || char === ',') return;
      if (char === ']') return closeCurrentArray();

      itemStarted = true;
      itemBuffer = char;
      itemDepth = char === '{' || char === '[' ? 1 : 0;
      inString = char === '"';
      escapeNext = false;

      if (itemDepth === 0 && !inString) await emitCurrentItem();
      return;
    }

    itemBuffer += char;

    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (char === '\\') escapeNext = true;
      else if (char === '"') inString = false;
      return;
    }

    if (char === '"') inString = true;
    else if (char === '{' || char === '[') itemDepth += 1;
    else if (char === '}' || char === ']') {
      itemDepth -= 1;
      if (itemDepth === 0) await emitCurrentItem();
    }
  };

  const keepSearchTail = () => { searchBuffer = searchBuffer.slice(-SEARCH_BUFFER_TAIL); };

  const detectRoot = () => {
    searchBuffer = searchBuffer.replace(/^\uFEFF/, '');
    const arrayMatch = searchBuffer.match(ROOT_ARRAY_RE);
    if (arrayMatch) {
      rootType = 'array';
      const remainder = searchBuffer.slice((arrayMatch.index ?? 0) + arrayMatch[0].length);
      searchBuffer = '';
      activateArray('notes');
      return remainder;
    }

    const objectMatch = searchBuffer.match(ROOT_OBJECT_RE);
    if (objectMatch) {
      rootType = 'object';
      const remainder = searchBuffer.slice((objectMatch.index ?? 0) + objectMatch[0].length);
      searchBuffer = '';
      mode = 'seekArrays';
      return remainder;
    }

    if (/\S/.test(searchBuffer)) throw new Error('Invalid backup format');
    keepSearchTail();
    return null;
  };

  const searchForNextArray = () => {
    let found = null;
    for (const marker of ARRAY_MARKERS) {
      const match = searchBuffer.match(marker.regex);
      if (match && (!found || (match.index ?? 0) < found.index)) {
        found = { kind: marker.kind, index: match.index ?? 0, length: match[0].length };
      }
    }

    if (!found) { keepSearchTail(); return null; }
    const remainder = searchBuffer.slice(found.index + found.length);
    searchBuffer = '';
    activateArray(found.kind);
    return remainder;
  };

  return {
    async push(text) {
      let remaining = text;
      while (remaining) {
        if (mode === 'done') return;

        if (mode === 'detectRoot') {
          searchBuffer += remaining;
          const next = detectRoot();
          if (next == null) return;
          remaining = next;
          continue;
        }

        if (mode === 'seekArrays') {
          searchBuffer += remaining;
          const next = searchForNextArray();
          if (next == null) return;
          remaining = next;
          continue;
        }

        for (let i = 0; i < remaining.length; i += 1) {
          await processArrayChar(remaining[i]);
          if (mode !== 'array') {
            remaining = remaining.slice(i + 1);
            break;
          }
          if (i === remaining.length - 1) remaining = '';
        }
      }
    },
    async finish() {
      if (!rootType || mode === 'detectRoot' || mode === 'array' || itemStarted || inString || itemDepth !== 0) {
        throw new Error('Invalid backup format');
      }
      if (!sawRelevantArray || !sawNoteArray) throw new Error('Invalid data format');
    }
  };
}
