import { Hono } from 'hono';
import { escapeHtml, respondError } from './lib/utils.js';

import { createImagesRouter } from './api/images.js';
import loginRouter from './api/login.js';
import tagsRouter from './api/tags.js';
import foldersRouter from './api/folders.js';
import listRouter from './api/list.js';
import saveRouter from './api/save.js';
import deleteRouter from './api/delete.js';
import uploadRouter from './api/upload.js';
import backupRouter from './api/backup.js';
import syncRouter from './api/sync.js';

const app = new Hono();

app.onError((error, c) => {
    console.error(`Unhandled error on ${c.req.method} ${c.req.path}:`, error);
    const message = escapeHtml(error?.message || 'Internal Server Error');

    if (c.req.path.startsWith('/api/')) {
        return respondError(c, message, 500);
    }

    return c.text('Internal Server Error', 500);
});

app.get('/', (c) => c.redirect('/app.html'));
app.get('/index.html', (c) => c.redirect('/app.html'));
app.get('/backup', (c) => c.redirect('/app.html?view=backup'));

app.route('/img', createImagesRouter('img'));
app.route('/video', createImagesRouter('video'));

app.route('/api/login', loginRouter);
app.route('/api/tags', tagsRouter);
app.route('/api/folders', foldersRouter);
app.route('/api/list', listRouter);
app.route('/api/save', saveRouter);
app.route('/api/delete', deleteRouter);
app.route('/api/upload', uploadRouter);
app.route('/api/backup', backupRouter);
app.route('/api/sync', syncRouter);

app.all('*', (c) => c.json({ error: 'Not Found' }, 404));

export default app;
