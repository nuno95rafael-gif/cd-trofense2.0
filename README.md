# CD Trofense

Backend (FastAPI) + frontend (React/CRA) deployed as a single Vercel project.
Database and file storage on Supabase.

## Required environment variables (Vercel → Project Settings → Environment Variables)

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret key (Project Settings → API) |
| `JWT_SECRET` | Random secret used to sign session tokens |
| `ADMIN_EMAIL` | Login email for the seeded editor account |
| `ADMIN_PASSWORD` | Login password for the seeded editor account |
| `RESEND_API_KEY` | Optional — enables emailing PDF reports |
| `RESEND_FROM_EMAIL` | Optional — sender address for report emails |

Changing any of these requires a new deployment to take effect (Vercel Functions
read environment variables at deploy time, not from a running instance).

The admin account is created/updated automatically on the backend's next cold
start after `ADMIN_EMAIL`/`ADMIN_PASSWORD` change.
