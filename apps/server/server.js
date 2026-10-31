import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { existsSync } from 'node:fs';
import cron from 'node-cron';
import app from './index.js';
import { scheduledGc } from './lib/scheduled.js';
import { ensureSchema } from './lib/schema.js';
import { ensureSyncSchema } from './lib/sync.js';
import { db } from './lib/core.js';

async function startup() {
    await ensureSchema();
    await ensureSyncSchema();

    cron.schedule('0 2 * * *', () => {
        console.log('Running scheduled garbage collection...');
        scheduledGc().catch(console.error);
    });

    const mainApp = new Hono();

    mainApp.use('/*', compress());

    mainApp.use('*', cors({
        origin: (origin) => origin || '*',
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
            'Content-Type',
            'X-Auth-Token',
            'X-Session-Nonce',
            'X-Backup-Upload',
            'X-Backup-Size',
            'HX-Request',
            'HX-Trigger',
            'HX-Trigger-Name',
            'HX-Target',
            'HX-Current-URL'
        ],
        exposeHeaders: ['Content-Length', 'Content-Type', 'HX-Trigger', 'HX-Trigger-After-Swap', 'HX-Redirect', 'HX-Location'],
        credentials: true,
        maxAge: 300
    }));

    const IMMUTABLE_RE = /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|css)$/i;
    const JS_MODULE_RE = /\.(js|mjs)$/i;

    mainApp.use('/*', async (c, next) => {
        await next();
        const p = c.req.path;
        if (IMMUTABLE_RE.test(p) || p.startsWith('/assets/')) {
            c.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
        else if (JS_MODULE_RE.test(p)) {
            c.header('Cache-Control', 'no-cache');
        }
        else if (p.endsWith('.html') || p === '/') {
            c.header('Cache-Control', 'no-cache');
        }
        else {
            c.header('Cache-Control', 'no-store');
        }
    });

    const serveWeb = process.env.SERVE_WEB === 'true';

    // The Docker image copies apps/client to /app/client, while a checkout keeps
    // it at apps/client. Pick whichever exists so SERVE_WEB works in both.
    const clientRoot = existsSync('./client') ? './client' : './apps/client';

    if (serveWeb) {
        mainApp.use('/*', serveStatic({ root: clientRoot, index: 'app.html', precompressed: true }));
    } else {
        mainApp.get('/', (c) => c.text(
            'eNote API server\n\n'
            + 'This instance serves data only; the note UI ships with the desktop app.\n'
            + 'Start with SERVE_WEB=true to also serve the web UI.\n'
        ));
    }

    mainApp.route('/', app);

    const port = process.env.PORT || 3000;
    const server = serve({
        fetch: mainApp.fetch,
        port
    }, (info) => {
        console.log(`Server is running on http://localhost:${info.port}`);
    });

    const shutdown = () => {
        console.log('Shutting down server gracefully...');
        server.close(async () => {
            console.log('HTTP server closed.');
            if (db && typeof db.db?.close === 'function') {
                try {
                    db.db.close();
                    console.log('SQLite database connection closed safely.');
                } catch (err) {
                    console.error('Error closing SQLite database:', err);
                }
            }
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

startup().catch(console.error);

