<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

### Services

This is a single Next.js app (not a monorepo) backed by PostgreSQL. All external integrations (Groq, Shopify, Klaviyo, Firecrawl) are optional and degrade gracefully when API keys are absent.

### PostgreSQL

PostgreSQL must be running before starting the dev server or running seeds. Start it with:

```bash
sudo pg_ctlcluster 16 main start
```

The default connection string is in `.env.example`. The `.env` file is already configured with it.

### Running the app

The seed script and Prisma commands require `DATABASE_URL` to be set in the environment (the `.env` file is loaded by Next.js but **not** by standalone `tsx` scripts like `prisma/seed.ts`). Export `DATABASE_URL` from `.env` before running `npm run db:seed` or pass it inline.

Standard commands are documented in `README.md` (`npm run dev`, `npm run build`, `npm run lint`, `npm run db:generate`, `npm run db:push`, `npm run db:seed`).

### Lint

`npm run lint` exits with code 1 due to pre-existing warnings/errors in the codebase (1 error in `components/layout-shell.tsx` related to `setState` in effect, plus several unused-variable warnings). These are not introduced by environment setup.

### Gotchas

- `pg_hba.conf` must use `md5` auth (not `peer`) for the local `postgres` user to allow password-based connections. This is already configured in the VM snapshot.
- The app redirects `/` to `/dashboard`, so always test against `http://localhost:3000/dashboard`.
