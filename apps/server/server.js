import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import cron from 'node-cron';
import app from './index.js';
import { scheduledGc } from './lib/scheduled.js';
import { ensureSchema } from './lib/schema.js';
import { ensureSyncSchema } from './lib/sync.js';
import { db } from './lib/core.js';

async function startup() {
    await ensureSchema();
    // Depends on notes/folders existing (the change triggers reference them).
    await ensureSyncSchema();

    // Schedule cron job
    cron.schedule('0 2 * * *', () => {
        console.log('Running scheduled garbage collection...');
        scheduledGc().catch(console.error);
    });

    const mainApp = new Hono();

    // Compress text responses (HTML/JSON/JS/CSS). Media streams are skipped by
    // the middleware's compressible content-type check. Registered first so it
    // wraps both API routes and static files.
    mainApp.use('/*', compress());

    // The packaged desktop/mobile shells load the UI from the app bundle
    // (origin `http://tauri.localhost`), so API and media calls are cross-
    // origin. Credentials are carried in the X-Auth-Token header rather than a
    // cookie, so the origin is echoed back verbatim; `credentials: true` is
    // still needed for the cookie-based media path.
    mainApp.use('*', cors({
        origin: (origin) => origin || '*',
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
            'Content-Type',
            'X-Auth-Token',
            'X-Session-Nonce',
            'X-Backup-Upload',
            'X-Backup-Size',
            // htmx attaches all of these on every request; a single missing
            // entry fails the preflight and the request never leaves the shell.
            'HX-Request',
            'HX-Trigger',
            'HX-Trigger-Name',
            'HX-Target',
            'HX-Current-URL'
        ],
        // htmx drives the login flow through response headers; without exposing
        // them the cross-origin client never sees the event and stays on the
        // login screen even though authentication succeeded.
        exposeHeaders: ['Content-Length', 'Content-Type', 'HX-Trigger', 'HX-Trigger-After-Swap', 'HX-Redirect', 'HX-Location'],
        credentials: true,
        // Kept short during development: a long-lived preflight cache makes a
        // corrected header list appear to have no effect.
        maxAge: 300
    }));

    // Cache-Control middleware
    const IMMUTABLE_RE = /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|css)$/i;
    const JS_MODULE_RE = /\.(js|mjs)$/i;

    mainApp.use('/*', async (c, next) => {
        await next();
        const p = c.req.path;
        // Long-immutable for fonts/images/css that are versioned via filename or rarely change.
        if (IMMUTABLE_RE.test(p) || p.startsWith('/assets/')) {
            c.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
        // JS modules: never immutable. ES module graphs share state by URL, and stale cached
        // modules cause hard-to-debug "missing export" failures when any module's shape changes.
        // Allow short caching with mandatory revalidation so updates roll out reliably.
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

    // index: serve app.html for "/" directly (saves the /app.html redirect round trip).
    // precompressed: serve build-time .gz files with zero runtime CPU when present.
    //
    // Serving the UI from the server is now opt-in. The packaged desktop app is
    // the primary client and carries its own copy of the assets, so a deployed
    // server should only move data. Set SERVE_WEB=true to keep the old
    // behaviour (browser access, or during UI development).
    const serveWeb = process.env.SERVE_WEB === 'true';

    if (serveWeb) {
        mainApp.use('/*', serveStatic({ root: './apps/client', index: 'app.html', precompressed: true }));
    } else {
        // A bare response keeps the port obviously "API only" instead of
        // returning a confusing 404 when someone opens it in a browser.
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

    // Graceful shutdown handling
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
