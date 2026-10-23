# eNote

A lightweight note-taking application containerized for easy deployment.

👉 **[Try the Live Demo](https://op09090-enote-test.hf.space/app.html)**
Password: LINUX

## Preview

| Website View | Mobile View |
| :---: | :---: |
| ![Website](assets/screenshots/website.PNG) | ![Mobile](assets/screenshots/mobile.PNG) |

*(Note: The demo resets periodically, please do not store sensitive information.)*

## Desktop App (recommended)

The desktop client is a ~1.4 MB native app that keeps every note in a local
IndexedDB store: it opens instantly, works offline, and syncs in the background.

1. Run the server — the app is only a client and stores nothing itself:

   ```bash
   npm install
   APP_PASSWORD=your_password JWT_SECRET=your_secret npm start
   ```

2. Install `eNote_1.0.0_x64-setup.exe`.
3. On first launch the app asks for the server address, e.g. `http://192.168.1.20:3000`.

By default the server now serves **API only** — opening the port in a browser
returns a short text notice instead of the UI. Add `SERVE_WEB=true` to the
environment to keep the web interface available as well.

## Quick Start (Docker Compose)

Create a `docker-compose.yml` file and run `docker compose up -d`.

```yaml
version: '3.8'

services:
  enote:
    image: op09090/enote:latest
    container_name: enote
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - APP_PASSWORD=your_secure_password # Access password
      - JWT_SECRET=your_jwt_secret        # Secret for session tokens
      - DB_PATH=/app/data/enote.db        # (Optional)
      - STORAGE_PATH=/app/data/storage    # (Optional)
    restart: unless-stopped
```

## Configuration

- **APP_PASSWORD**: Set this to your desired password to access the app.
- **JWT_SECRET**: Set a random string for token generation.
- **SERVE_WEB**: Defaults to `false` (API only). Set to `true` to also serve the browser UI.
- **Data Persistence**: All notes and files are stored in the `./data` folder on your host machine.

## Project Layout

```
server/     Hono API — notes, media, sync. Serves no UI unless SERVE_WEB=true.
client/     Front-end source (vanilla JS + htmx + Squire). Shared with the desktop shell.
src-tauri/  Tauri desktop shell (Rust). Packages `dist/` into a ~1.4 MB installer.
scripts/    build-web.mjs — produces dist/ from client/ for packaging.
dist/       Packaged asset tree (generated; not edited by hand).
data/       SQLite database + uploaded media.
```

`client/` is the single source of truth for the UI. The same files run in a
browser (when `SERVE_WEB=true`) and inside the desktop app, so a future mobile
build can reuse them unchanged.

