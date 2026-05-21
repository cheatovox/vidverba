# VidVerba Architecture

VidVerba's production target is the Tauri desktop app.

- `src-tauri/src/lib.rs` owns production filesystem, dependency, transcription, analysis, and render behavior through Tauri commands.
- `public/` contains bundled frontend assets loaded by Tauri via `src-tauri/tauri.conf.json` `frontendDist`.
- `public/app.js` expects `window.__TAURI__` and calls Tauri commands directly. It does not use an HTTP API fallback for production.
- `server.js` is a legacy/dev-only static preview helper. It is not part of production architecture, and its old browser API is disabled unless explicitly launched with the legacy API flag.

Use `npm start`, `npm run dev`, or `npm run desktop` for desktop development. Use `npm run desktop:build` for production builds.
