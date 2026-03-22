---
name: setup
description: "Set up SillyTavern with the SillyTavern-vault plugin from scratch. Clones SillyTavern into the current directory, installs dependencies, symlinks the plugin, starts Docker (Postgres + MinIO), and launches SillyTavern. Use when the user says /setup, wants to install SillyTavern with vault, or needs a fresh local environment."
---

# Setup SillyTavern + SillyTavern-vault

Sets up a complete local environment from scratch, all within the current directory.

## Steps

### 1. Clone SillyTavern

Clone into a `SillyTavern` subdirectory within the current directory:

```bash
git clone -b plugin https://github.com/tamagochat/SillyTavern.git
```

If `SillyTavern/` already exists, skip cloning and tell the user.

### 2. Install SillyTavern dependencies

```bash
cd SillyTavern && npm install
```

### 3. Install the plugin via symlink

```bash
mkdir -p SillyTavern/plugins
rm -rf SillyTavern/plugins/SillyTavern-vault
ln -s "$(pwd)" SillyTavern/plugins/SillyTavern-vault
```

Verify the symlink:

```bash
ls -la SillyTavern/plugins/SillyTavern-vault/package.json
```

### 4. Install plugin dependencies

```bash
npm install
```

### 5. Start Docker containers (Postgres + MinIO)

```bash
docker compose up -d
```

Wait for both containers to be healthy. If either fails, surface the error and stop.

### 6. Enable server plugins

Ensure `SillyTavern/config.yaml` has `enableServerPlugins: true`. If config.yaml doesn't exist, copy from `SillyTavern/default/config.yaml` and set the flag.

### 7. Start SillyTavern

```bash
pkill -f "node server.js" 2>/dev/null
sleep 1

cd SillyTavern && \
  VAULT_DB_URL=postgresql://vault:vault123@localhost:5432/vault \
  VAULT_S3_ENDPOINT=http://localhost:9000 \
  VAULT_S3_BUCKET=vault-media \
  VAULT_S3_ACCESS_KEY=vault \
  VAULT_S3_SECRET_KEY=vault123 \
  node server.js &
```

Check output for:
- `[sillytavern-vault] External storage provider registered successfully`
- `SillyTavern is listening on`

### 8. Start Drizzle Studio

```bash
npx drizzle-kit studio &
```

Check output for `Drizzle Studio is up and running on`.

### 9. Confirm

Tell the user:
- SillyTavern is running at http://127.0.0.1:8000
- Storage plugin is active (chats → PostgreSQL, media → MinIO/S3)
- MinIO console at http://localhost:9001 (user: vault, password: vault123)
- Drizzle Studio at https://local.drizzle.studio
