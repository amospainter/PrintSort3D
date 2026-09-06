# PrintSort3D

A local web app for cataloging, browsing, and searching your STL / 3MF / OBJ print files. Scans folders you point it at, generates a thumbnail for each model (extracted directly from Bambu Lab `.3mf` files, or rendered in-browser for everything else), and lets you tag and take notes on each file.

See [docs/architecture.md](docs/architecture.md) for how it's built, [docs/api.md](docs/api.md) for the HTTP API, and [docs/testing.md](docs/testing.md) for the test suites.

## Requirements

- Node.js 22.5+ (the server uses the built-in `node:sqlite` module — no native build tools needed)
- Windows, macOS, or Linux

## Setup

From the repo root:

```sh
npm run install:all
```

This installs dependencies for the root, `server/`, and `client/` packages.

## Running it

```sh
npm run dev
```

This starts both halves of the app together:

- **Server** — Express API on `http://localhost:3001`
- **Client** — Vite dev server on `http://localhost:5173` (proxies `/api` to the server)

Open `http://localhost:5173` in your browser.

On first run, the server creates `server/config.json` (empty root list) and `server/catalog.db` (SQLite). Go to the **Settings** page in the app to add folders you want scanned, then click **Rescan now**.

## Building for production

```sh
npm run build --prefix server
npm run build --prefix client
```

- `server/dist/index.js` — compiled server; run with `node server/dist/index.js` (serves the API only; put a static file server or reverse proxy in front for the built client if you want a single deployable unit)
- `client/dist/` — static client build

## Running tests

```sh
npm test
```

Runs the server test suite (Vitest + Supertest) and the client test suite (Vitest) back to back. See [docs/testing.md](docs/testing.md) for details, or run each package's tests individually with `npm test --prefix server` / `npm test --prefix client`.

## Project layout

```
server/   Express + TypeScript API, SQLite catalog, filesystem scanner
client/   React + TypeScript frontend (Vite), three.js viewer/thumbnails
docs/     Architecture, API reference, and testing docs
```
