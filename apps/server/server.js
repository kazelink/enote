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
import { maintenanceTask } from './lib/maintenance.js';
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

    const IMMUTABLE_RE = /\.(woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico)$/i;
    const JS_MODULE_RE = /\.(js|mjs)$/i;
    const CSS_RE = /\.css$/i;

    mainApp.use('/*', async (c, next) => {
        await next();
        const p = c.req.path;

        // 失败响应绝不能被长效缓存（一次瞬时的 404 不该留下一年）。
        if (c.res.status >= 400) {
            c.header('Cache-Control', 'no-store');
            return;
        }

        // 认证媒体由 images.js 自己声明 private，API 由各路由声明，不覆盖。
        if (p.startsWith('/api/') || p.startsWith('/img/') || p.startsWith('/video/')) return;

        // 静态层已经给过策略就不要动它。
        if (c.res.headers.get('Cache-Control')) return;

        if (IMMUTABLE_RE.test(p) || p.startsWith('/assets/')) {
            c.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
        else if (JS_MODULE_RE.test(p) || CSS_RE.test(p)) {
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
        mainApp.use('/*', serveStatic({ root: clientRoot, index: 'index.html', precompressed: true }));
    } else {
        mainApp.get('/', (c) => c.text(
            'eNote API server\n\n'
            + 'This instance serves data only; the note UI ships with the desktop app.\n'
            + 'Start with SERVE_WEB=true to also serve the web UI.\n'
        ));
    }

    // 备份恢复期间独占写通道。better-sqlite3 只有一个连接，恢复会长时间持有
    // 写事务，其他写请求在这一刻进来要么撞锁超时，要么混进同一个事务。
    mainApp.use('/api/*', async (c, next) => {
        const task = maintenanceTask();
        if (!task) return next();

        const p = c.req.path;
        if (p.startsWith('/api/backup') || p === '/api/login') return next();

        const isWrite = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(c.req.method);
        if (isWrite) {
            return c.json({ error: `Server busy: ${task} in progress, retry shortly.` }, 503);
        }

        return next();
    });

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

