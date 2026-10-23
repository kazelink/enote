const BASE = 'http://127.0.0.1:3100';

const login = await (await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpass' })
})).json();

const headers = {
    'X-Auth-Token': login.token,
    'X-Session-Nonce': login.nonce
};

const state = await (await fetch(`${BASE}/api/sync/state`, { headers })).json();
const pull = await (await fetch(`${BASE}/api/sync/pull?since=0&limit=50`, { headers })).json();

console.log(JSON.stringify({
    state,
    notes: pull.notes.map((n) => ({
        title: n.title,
        category: n.category,
        subcategory: n.subcategory,
        tags: n.tags,
        seq: n.seq
    }))
}, null, 2));
