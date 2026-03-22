# SillyTavern-vault

External storage plugin for [SillyTavern](https://github.com/tamagochat/SillyTavern) — stores chat history in PostgreSQL and media assets (images, audio, video) in S3-compatible storage.

## Why

SillyTavern stores everything on the local filesystem — chats as `.jsonl` files, images as raw files. This works fine for a single machine, but breaks down when you redeploy, migrate, or scale.

SillyTavern-vault moves storage to PostgreSQL + S3 so your data lives independently of the instance. No backup scripts, no rsync, no lost chats.

| | Filesystem (default) | SillyTavern-vault |
|---|---|---|
| Data persistence | Tied to instance | Survives redeploys |
| Backup | Manual (rsync, tar, cron) | Built into Postgres/S3 |
| Sync across instances | Not supported | Shared database |
| Storage footprint | 100 MB | 23 MB (77% smaller) |
| Search | File scan | Full-text index (GIN) |

> Storage benchmark: 1,847 chats, ~104 messages each, 100 MB raw JSONL. PostgreSQL TOAST compression reduces storage to 23% of filesystem. Run `python benchmarks/storage_footprint.py` to reproduce.

## What it does

| Layer | Backend       | What's stored                                              |
| ----- | ------------- | ---------------------------------------------------------- |
| Chat  | PostgreSQL    | Chat history (JSONL), full-text searchable                 |
| Media | S3 (MinIO/R2) | Images, avatars, backgrounds, group definitions, files     |

When the plugin is active, SillyTavern reads/writes to these backends instead of the local filesystem. When disabled, everything falls through to the default filesystem storage — zero behavior change.

### Example

A chat with a character in SillyTavern, including an image shared in the conversation:

![SillyTavern chat](docs/vault_st.jpg)

The chat history is stored in PostgreSQL (viewed via Drizzle Studio):

![Chat rows in PostgreSQL](docs/vault_db.jpg)

The image from the conversation is stored in S3 (viewed via MinIO console):

![Image stored in S3](docs/vault_s3.jpg)

### Storage paths

**Chat (PostgreSQL)**

| Mode                     | Key                                                                          |
| ------------------------ | ---------------------------------------------------------------------------- |
| SillyTavern (filesystem) | `data/{user_handle}/chats/{character_name}/{file_name}.jsonl`                |
| SillyTavern-vault        | Postgres `chats` table, unique on `(user_handle, character_name, file_name)` |

**Files / Images (S3)**

| Mode                     | Key                                                          |
| ------------------------ | ------------------------------------------------------------ |
| SillyTavern (filesystem) | `data/{user_handle}/user/images/{character_name}/{filename}` |
| SillyTavern-vault        | `{user_handle}/user/images/{character_name}/{filename}`      |

**Groups (S3)**

| Mode                     | Key                                                       |
| ------------------------ | --------------------------------------------------------- |
| SillyTavern (filesystem) | `data/{user_handle}/groups/{group_id}.json`               |
| SillyTavern-vault        | `{user_handle}/groups/{group_id}.json`                    |

**Other SillyTavern paths (reference)**

| Resource          | Filesystem path                                      |
| ----------------- | ---------------------------------------------------- |
| Character avatars | `data/{user_handle}/characters/{character_name}.png` |
| User avatars      | `data/{user_handle}/User Avatars/{filename}`         |
| Backgrounds       | `data/{user_handle}/backgrounds/{filename}`          |
| Group chats       | `data/{user_handle}/group chats/{group_id}.jsonl`    |

## Quick start

### 1. Install the plugin

> **Note:** This plugin requires the [tamagochat/SillyTavern](https://github.com/tamagochat/SillyTavern) fork, which adds the storage provider registry hooks. When no provider is registered, behavior is identical to upstream.

```bash
# Clone tamagochat/SillyTavern fork (required for storage provider hooks)
git clone https://github.com/tamagochat/SillyTavern.git
cd SillyTavern/plugins
git clone https://github.com/tamagochat/SillyTavern-vault.git SillyTavern-vault
cd SillyTavern-vault && npm install
```

### 2. Start PostgreSQL and MinIO

```bash
docker compose up -d
```

This starts PostgreSQL and MinIO with default credentials. MinIO console is available at http://localhost:9001. If you'd like to use an external provider instead, see [PostgreSQL providers](#postgresql-providers) and [S3-compatible storage providers](#s3-compatible-storage-providers).

### 3. Configure environment variables

```bash
export VAULT_DB_URL=postgresql://vault:vault123@localhost:5432/vault
export VAULT_S3_ENDPOINT=http://localhost:9000
export VAULT_S3_BUCKET=vault-media
export VAULT_S3_ACCESS_KEY=vault
export VAULT_S3_SECRET_KEY=vault123
```

| Variable              | Required | Default       | Description                            |
| --------------------- | -------- | ------------- | -------------------------------------- |
| `VAULT_DB_URL`        | Yes      | —             | PostgreSQL connection string           |
| `VAULT_S3_ENDPOINT`   | Yes      | —             | S3-compatible endpoint URL             |
| `VAULT_S3_BUCKET`     | No       | `vault-media` | S3 bucket name (created automatically) |
| `VAULT_S3_ACCESS_KEY` | Yes      | —             | S3 access key                          |
| `VAULT_S3_SECRET_KEY` | Yes      | —             | S3 secret key                          |

If `VAULT_DB_URL` is not set, the plugin skips initialization and SillyTavern uses filesystem storage as usual.


### 4. Enable server plugins and start SillyTavern

In `config.yaml`, set:
```yaml
enableServerPlugins: true
```

Then start:
```bash
node server.js
```

You should see in the logs:
```
[sillytavern-vault] Initializing external storage provider...
[sillytavern-vault/db] Schema initialized
[sillytavern-vault] External storage provider registered successfully
```

### 5. Browse data with Drizzle Studio (optional)

```bash
cd SillyTavern-vault
npx drizzle-kit studio
```

Opens [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) at https://local.drizzle.studio to inspect PostgreSQL tables. Uses the connection string from `VAULT_DB_URL` (defaults to `postgresql://vault:vault123@localhost:5432/vault`).

## PostgreSQL providers

Any PostgreSQL-compatible database works. The plugin auto-creates tables and indexes on first start.

### Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **Settings → Database**
3. Copy the **Connection string (URI)** under "Connection pooling" (Transaction mode)
4. Use as `VAULT_DB_URL`

```
postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```

### Neon

1. Create a project at [neon.tech](https://neon.tech)
2. Go to **Dashboard → Connection Details**
3. Copy the connection string (pooled endpoint recommended)
4. Use as `VAULT_DB_URL`

```
postgresql://[user]:[password]@[endpoint].neon.tech/neondb?sslmode=require
```

### Self-hosted / Docker

The included `docker-compose.yml` starts PostgreSQL locally:

```bash
docker compose up -d postgres
```

```
postgresql://vault:vault123@localhost:5432/vault
```

### Database schema

The plugin auto-creates the required table and indexes on first start:

```sql
CREATE TABLE chats (
    id SERIAL PRIMARY KEY,
    user_handle TEXT NOT NULL,
    character_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_handle, character_name, file_name)
);
```

Full-text search is supported via a GIN index on chat content.

## S3-compatible storage providers

Any S3-compatible storage works. The plugin auto-creates the bucket on first start.

### AWS S3

1. Create a bucket in the [S3 console](https://s3.console.aws.amazon.com)
2. Create an IAM user with `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` permissions
3. Generate an access key under **IAM → Users → Security credentials**

```bash
export VAULT_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
export VAULT_S3_BUCKET=your-bucket-name
export VAULT_S3_ACCESS_KEY=AKIA...
export VAULT_S3_SECRET_KEY=...
```

### Cloudflare R2

1. Go to [Cloudflare Dashboard → R2](https://dash.cloudflare.com) and create a bucket
2. Go to **R2 → Manage R2 API Tokens** and create a token with Object Read & Write
3. Copy the S3 API endpoint from the bucket details page

```bash
export VAULT_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export VAULT_S3_BUCKET=your-bucket-name
export VAULT_S3_ACCESS_KEY=...
export VAULT_S3_SECRET_KEY=...
```

### Self-hosted / Docker (MinIO)

The included `docker-compose.yml` starts MinIO locally:

```bash
docker compose up -d minio
```

```bash
export VAULT_S3_ENDPOINT=http://localhost:9000
export VAULT_S3_BUCKET=vault-media
export VAULT_S3_ACCESS_KEY=vault
export VAULT_S3_SECRET_KEY=vault123
```

MinIO console is available at http://localhost:9001.

### S3 key layout

```
{user_handle}/user/images/{character}/{filename}
{user_handle}/backgrounds/{filename}
{user_handle}/User Avatars/{filename}
{user_handle}/groups/{group_id}.json
```

## Limitations

SillyTavern-vault covers the primary storage paths (1:1 chats, images, avatars, backgrounds). Some features still use the local filesystem:

| Feature | Status | Impact |
|---------|--------|--------|
| 1:1 chats | Stored in PostgreSQL | Full support |
| Group chats | Stored in PostgreSQL | Full support |
| Group definitions | Stored in S3 | Full support |
| Chat search | PostgreSQL full-text (GIN) | Full support |
| Character rename | Updates DB + S3 | Full support |
| Character delete | Deletes chats from DB | Full support |
| Chat integrity check | Provider fallback | Full support |
| Images / media | Stored in S3 | Full support |
| Avatars / thumbnails | Stored in S3 | Full support |
| Backgrounds | Stored in S3 | Full support |
| Vector/RAG embeddings | Uses own storage (vectra) | Full support (not affected) |
| Data Bank attachments | Fetched via API | Full support (not affected) |
| Image metadata | Cached on filesystem | Regeneratable cache, not critical data |
| Character stats | Reads filesystem directly | Stats may show empty |
| Data Maid (cleanup) | Scans filesystem | Won't detect externally stored data |

## Migration from filesystem

To migrate existing filesystem data to PostgreSQL + S3:

```bash
VAULT_DB_URL=postgresql://... \
VAULT_S3_ENDPOINT=http://... \
VAULT_S3_ACCESS_KEY=... \
VAULT_S3_SECRET_KEY=... \
node SillyTavern-vault/migrate.js [/path/to/data]
```

The script detects if the database already has data and skips migration to avoid duplicates.

## License

AGPL-3.0 — same as SillyTavern.
