# Deployment

| | Staging | Production |
|---|---|---|
| Branch | `Dev` (backend), `staging` (admin app) | `main` |
| Backend | Render service `resolv-hq-backend-staging` | Render service `resolv-hq-backend` |
| Admin app | Vercel preview deployment | Vercel production deployment |

Pushing to the branch deploys. Pull requests only run checks.

## One-time setup

### Backend (Render)

1. Render dashboard > New > Blueprint, pick this repo. `render.yaml` creates `resolv-hq-backend` (branch `main`) and `resolv-hq-backend-staging` (branch `Dev`).
2. Fill in the `sync: false` values on each service (names are in `.env.example`):
   `DATABASE_URL`, `DIRECT_URL`, `ALLOWED_ORIGINS`, `REDIS_URL`, `RABBITMQ_URL`, and in the shared group `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWKS_URL`.
3. Redis is optional (rate limiting and caching fail open); create a Render Key Value instance and use its internal URL if you want it. RabbitMQ is optional too, but the `localhost` default will not work on Render, so leave it unset or point it at a hosted broker.

`DIRECT_URL` must be the non-pooled connection: the pre-deploy command (`prisma migrate deploy`) needs it.
`ALLOWED_ORIGINS` must list the real frontend origins or the browser blocks every API call.
`preDeployCommand` needs a paid instance type (the blueprint uses `starter`). On a free instance, remove it and run `npm run migrate:deploy` yourself.

Deploys: Render deploys a branch once the GitHub Actions checks pass on it (`autoDeployTrigger: checksPass`).

### Admin app (Vercel)

Import `resolv-hq`, production branch `main`. Set these for Production and Preview:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_API_BASE_URL` — the backend's public URL (`https://resolv-hq-backend.onrender.com` or a custom domain)

`vercel.json` already rewrites client-side routes to `index.html`. `VITE_*` values are inlined at build time, so changing one needs a redeploy.

### Supabase

Add each frontend origin under Authentication > URL Configuration (site URL and redirect URLs).

## Local / self-hosted stack

`docker compose build && docker compose up -d` in this directory runs the backend, Redis, RabbitMQ, the admin app and the customer web app. See the header of `docker-compose.yml`.

## Rollback

Render dashboard > service > Events > Rollback on a previous deploy. Migrations are not rolled back; write forward-only, backward-compatible migrations.
