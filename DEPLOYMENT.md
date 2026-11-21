# DeepContext: free deployment without a card

This guide deploys DeepContext using only free tiers that do not require card
details:

- **Frontend:** Vercel Hobby
- **API:** one Render Free Docker web service
- **Database and vectors:** Neon Free PostgreSQL with `pgvector`
- **Upload storage:** Neon Object Storage (S3-compatible)
- **Redis:** Upstash Redis Free

Do not create a Render database, Key Value service, worker, private service, or
persistent disk. Those are either temporary or paid. The included
[`render.yaml`](./render.yaml) creates only one free API service.

> This is a hobby/demo deployment. Render sleeps after 15 idle minutes and the
> next request can take about a minute. It has 512 MB RAM, an ephemeral disk,
> and no free background worker. DeepContext therefore runs ingestion inside
> the API request (`CELERY_TASK_ALWAYS_EAGER=true`). Upload small documents and
> wait for each upload to finish.

## 1. Push the project to GitHub

From the project root:

```bash
git status
git add .
git commit -m "Configure free Render and Vercel deployment"
git push origin main
```

Confirm that `backend/.env` and `frontend/.env` are not present on GitHub.
Only the `.env.example` files should be committed. Rotate any credential that
has appeared in a screenshot, terminal output, or Git history.

## 2. Create the Neon Free database

1. Open <https://console.neon.tech> and sign up.
2. Select **New project** and keep the **Free** plan.
3. Open **Project dashboard → Connect**.
4. Enable **Connection pooling** and copy the `postgresql://...` connection
   string. This is your `DATABASE_URL`.
5. Keep `sslmode=require` in the URL.

DeepContext creates its relational tables, enables the `vector` extension, and
creates the pgvector table on first startup. Every vector retains `team_id` and
`access_level` metadata, so retrieval remains isolated by workspace and role.

### Create private upload storage in Neon

Uploads must not stay on Render's filesystem because it is erased when the
free service sleeps, restarts, or redeploys.

The repository includes [`neon.ts`](./neon.ts), which declares a private
`deepcontext-uploads` bucket. From the project root run:

```bash
npx neon@latest init
npx neon@latest deploy
npx neon@latest env pull --file .env.neon
```

Follow the browser prompt to link the Neon project created above. Do not commit
`.env.neon`; use it only to copy the generated values into Render. If your Neon
Console exposes the same feature under **Project → Object Storage**, you can
also inspect the private bucket and credentials there.

Map the generated values as follows:

| Neon value | Render variable |
|---|---|
| `AWS_ENDPOINT_URL_S3` | `S3_ENDPOINT_URL` |
| bucket name | `S3_BUCKET` |
| `AWS_ACCESS_KEY_ID` | `S3_ACCESS_KEY_ID` |
| `AWS_SECRET_ACCESS_KEY` | `S3_SECRET_ACCESS_KEY` |
| `AWS_REGION` | `S3_REGION` |

If your Neon account does not yet show Storage, use any private,
S3-compatible, no-card object-storage account available to you. Do not leave
`S3_BUCKET` blank in the cloud: pending uploads would otherwise disappear.

## 3. Create Upstash Redis Free

1. Open <https://console.upstash.com> and sign up.
2. Select **Create database → Redis**.
3. Choose the **Free** plan, a region close to the Neon/Render region, and
   enable TLS.
4. Open the database and find **Connect → Redis URL**.
5. Copy the full TLS URL beginning with `rediss://`. This is `REDIS_URL`.

The free deployment uses Redis for ingestion progress and Celery result state;
it does not run a separate worker.

## 4. Create the free Render API

1. Open <https://dashboard.render.com>.
2. Select **New + → Blueprint**.
3. Connect the GitHub repository and choose the deployment branch.
4. Render detects `/render.yaml`.
5. Verify that it shows exactly one resource named `deepcontext-api` with the
   **Free** plan in the **Ohio** region. Do not continue if it shows a worker, database, Key Value,
   private service, disk, or paid instance.
6. Enter the secret values when Render asks for them:

```ini
GROQ_API_KEY=your-groq-key
GROQ_VISION_MODEL=your-current-groq-vision-model
DATABASE_URL=your-neon-pooled-postgresql-url
REDIS_URL=your-upstash-rediss-url
S3_ENDPOINT_URL=your-neon-s3-endpoint
S3_BUCKET=deepcontext-uploads
S3_ACCESS_KEY_ID=your-neon-storage-access-key
S3_SECRET_ACCESS_KEY=your-neon-storage-secret
S3_REGION=the-region-from-neon
AUTH_ALLOWED_ORIGINS=https://example.invalid
NEXCONN_API_BASE_URL=https://api.sg-light-api.com
NEXCONN_APP_KEY=your-nexconn-app-key
NEXCONN_APP_SECRET=your-nexconn-app-secret
```

Nexconn values are optional if you do not use chat/huddles. The Blueprint
already sets these important values:

```ini
VECTOR_STORE_BACKEND=postgres
CELERY_TASK_ALWAYS_EAGER=true
AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SAMESITE=none
APP_ENV=production
RERANK_ENABLED=false
HUGGINGFACE_LOCAL_FILES_ONLY=true
```

7. Select **Apply** and wait for the Docker build.
8. Open **Render → deepcontext-api → Logs**. A successful startup reports the
   pgvector store as healthy.
9. Copy the API URL from the service page, for example:

```text
https://deepcontext-api.onrender.com
```

Test it:

```bash
curl https://YOUR-API.onrender.com/health
curl https://YOUR-API.onrender.com/health/chroma
```

The second route keeps its old name for frontend compatibility, but its
`endpoint` should be `postgresql+pgvector` in this deployment.

## 5. Deploy the frontend on Vercel Hobby

1. Open <https://vercel.com/new> and import the same GitHub repository.
2. Keep the **Hobby** plan. Do not start a Pro trial.
3. Set **Root Directory** to `frontend`.
4. Confirm:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Output directory: `dist`
5. Open **Environment Variables** and add:

```ini
VITE_API_BASE_URL=https://YOUR-API.onrender.com
```

6. Select **Deploy**.
7. Copy the production origin, for example
   `https://deepcontext-yourname.vercel.app` (without a trailing slash).

Only `VITE_API_BASE_URL` belongs on Vercel. Never add database, Groq, Nexconn,
S3, Redis, or JWT secrets to a `VITE_*` variable because Vite exposes those
values to browsers.

## 6. Allow the Vercel site in Render

1. Open **Render → deepcontext-api → Environment**.
2. Set `AUTH_ALLOWED_ORIGINS` to the exact Vercel production origin:

```ini
AUTH_ALLOWED_ORIGINS=https://deepcontext-yourname.vercel.app
```

For multiple trusted origins, separate them with commas and do not use `*`.
3. Save the change and redeploy the API.

## 7. End-to-end test

1. Open the Vercel URL in a private browser window.
2. Create a workspace and sign in.
3. Upload one small `.txt` or text PDF (start below 3 MB).
4. Wait for ingestion to finish; free mode performs it synchronously.
5. Ask a question whose answer is clearly present in that file.
6. Confirm the citation uses the real uploaded filename.
7. Create a second workspace and confirm its documents/citations are not
   visible in the first workspace.
8. If using Nexconn, test chat and huddle only after Chat and Call
   subscriptions are activated in the Nexconn Console.

## 8. Optional local SQLite migration

For a new deployment, skip this section. To copy existing users, workspaces,
chat sessions, and document registry metadata:

```bash
cd backend
source .venv/bin/activate
export DATABASE_URL='PASTE_NEON_POOLED_DATABASE_URL'
python migrate_sqlite_to_postgres.py --sqlite ./data/users.db
unset DATABASE_URL
```

This does not migrate local Chroma vectors. Re-upload the original documents
so Neon pgvector receives clean, workspace-scoped embeddings.

## Updating the deployment

Push a new commit to the connected branch. Render and Vercel redeploy
automatically. Database and vector data remain in Neon, staged files remain in
Neon Object Storage, and progress data remains in Upstash.

## Free-tier limitations and troubleshooting

### The first request is slow

Render sleeps after 15 idle minutes. The first request can take about a minute
while the container and embedding model start. Retry after the service wakes.

### Upload times out or the API restarts

The free API has limited memory and runs ingestion in the request process.
Start with one small file, avoid large scanned PDFs/Office files, and keep
`RERANK_ENABLED=false`. A paid worker is required for reliable heavy ingestion.

### `vector extension` or pgvector startup error

- Confirm `DATABASE_URL` is the Neon PostgreSQL URL, not an HTTP URL.
- Use the pooled URL and retain `sslmode=require`.
- In Neon SQL Editor, run `CREATE EXTENSION IF NOT EXISTS vector;`, then
  redeploy Render.

### Login works in the API but not from Vercel

- `AUTH_ALLOWED_ORIGINS` must exactly match the Vercel origin.
- Keep `AUTH_COOKIE_SECURE=true` and `AUTH_COOKIE_SAMESITE=none`.
- Do not include a trailing slash in either URL.

### Pending upload disappears

Confirm all five `S3_*` values are filled and that the bucket is private. Local
Render storage is intentionally not used for cloud persistence.

### Upstash connection error

Use the full `rediss://` URL, including password and port. Do not use the REST
URL as `REDIS_URL`.

## Final no-card checklist

- [ ] Vercel project is **Hobby**, not Pro/trial.
- [ ] Render Blueprint contains one **Free Web Service** only.
- [ ] Neon project is Free and the pooled database URL is configured.
- [ ] pgvector health reports `postgresql+pgvector`.
- [ ] Upstash database is Free and `REDIS_URL` begins with `rediss://`.
- [ ] Private S3-compatible storage is configured; uploads are not local.
- [ ] Vercel has only `VITE_API_BASE_URL`.
- [ ] Render has the exact Vercel origin in `AUTH_ALLOWED_ORIGINS`.
- [ ] A small upload, cited answer, and second-workspace isolation test pass.

## Official plan references

- Render Free: <https://render.com/docs/free>
- Render Docker without a card: <https://render.com/hosting/docker>
- Vercel Hobby: <https://vercel.com/docs/plans/hobby>
- Neon Free: <https://neon.com/pricing>
- Upstash Redis Free: <https://upstash.com/pricing/redis>
