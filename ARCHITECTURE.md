# VidVerba Architecture

VidVerba is a Tauri desktop app. There is no supported browser, website, HTTP API, or local dev-server runtime.

## Runtime Boundary

- `src-tauri/src/lib.rs` owns filesystem access, dependency detection, transcription orchestration, analysis, and rendering through Tauri commands.
- `public/` contains bundled frontend assets loaded by Tauri through `src-tauri/tauri.conf.json` `frontendDist`.
- `public/app.js` must call Tauri commands through `window.__TAURI__`. Absence of Tauri is a fatal runtime error, not a reason to provide a fallback.
- `src-tauri/resources/transcribe_video.py` is embedded by the Rust desktop backend and is not a server endpoint.

## Forbidden Paths

Do not add or restore:

- `server.js`, Express, `http.createServer`, or any other Node/browser preview server.
- `fetch` or XHR calls to local HTTP APIs for app behavior.
- `localhost`, `127.0.0.1`, Vite, or other website links as a default testing path.
- npm scripts that launch or validate a browser/server runtime.
- alternate browser-compatible data shapes to keep a removed web path alive.

## Development Commands

Use only the desktop app path:

- `npm start`, `npm run dev`, or `npm run desktop` for Tauri desktop development.
- `npm run desktop:build` for production desktop builds.
- `npm run check` for frontend syntax checks.
- `npm run check:desktop` for Tauri environment checks.

Any future command that opens a URL or tells a builder to test in a browser is out of bounds.
