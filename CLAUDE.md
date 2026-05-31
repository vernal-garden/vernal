# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Vernal is a garden planning web app. This repo is the Node.js/Express/TypeScript backend API. The frontend (React + Konva.js) lives separately. Database is PostgreSQL via Neon. Hosted on DigitalOcean.

The project is in early development, structured around numbered phases. The `.env.example` comments indicate what's coming: Phase 02 adds DB, Phase 05 adds sessions/auth, Phase 07 adds OAuth, Phase 09 adds R2 storage.

## Commands

```bash
npm run dev          # Start dev server with nodemon (tsx, watches src/)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run type-check   # tsc --noEmit
npm test             # vitest run (single pass)
npm run test:watch   # vitest (watch mode)
npm run test:coverage
```

Run a single test file:
```bash
npx vitest run src/routes/health.test.ts
```

## Architecture

`src/index.ts` is the Express app entry point — sets up helmet, CORS (restricted to `FRONTEND_URL`), body parsing, mounts routers, and exports `app` for tests. The server only starts (`app.listen`) when `NODE_ENV !== 'test'`, so supertest can import the app directly.

**Directory layout (current + planned):**
- `src/routes/` — Express routers, one file per domain (e.g. `health.ts`)
- `src/middleware/` — Auth and other middleware (empty, Phase 05+)
- `src/services/` — Business logic layer (empty, future phases)
- `src/lib/` — Shared utilities, DB client (empty, Phase 02+)
- `src/types/index.ts` — Shared types; also extends `Express.Request` with `req.account` (populated by auth middleware, Phase 05+)
- `src/test/helpers.ts` — Test utilities (empty, Phase 05+)

**Response shape:** Use `ApiResponse<T>` from `src/types/index.ts` for all route responses (`{ data?, error? }`).

**Tests:** Colocated as `*.test.ts` alongside source files. Use `supertest` against the exported `app`. Test helpers will live in `src/test/helpers.ts`.

## Code conventions

- Unused function parameters prefixed with `_` (ESLint enforces this)
- `no-explicit-any` is a warning, not an error
- Prettier handles formatting; ESLint + Prettier are integrated via `eslint-config-prettier`
- Node >= 24 required
