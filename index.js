import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve relative to SillyTavern's server directory (process.cwd), not this file's real path,
// so the import works whether the plugin is symlinked or copied into the plugins folder.
const storageProviderPath = path.join(process.cwd(), 'src', 'storage-provider.js');
const { registerStorageProvider } = await import(pathToFileURL(storageProviderPath).href);
import { createProvider } from './provider.js';
import { initDb } from './db.js';
import { initS3 } from './s3.js';

export const info = {
    id: 'sillytavern-vault',
    name: 'SillyTavern Vault',
    description: 'External storage provider using PostgreSQL for chats and S3 for media files',
};

export async function init(router) {
    const dbUrl = process.env.VAULT_DB_URL;
    if (!dbUrl) {
        console.log('[sillytavern-vault] No VAULT_DB_URL set, skipping initialization');
        return;
    }

    const s3Config = {
        endpoint: process.env.VAULT_S3_ENDPOINT,
        bucket: process.env.VAULT_S3_BUCKET || 'vault-media',
        accessKey: process.env.VAULT_S3_ACCESS_KEY,
        secretKey: process.env.VAULT_S3_SECRET_KEY,
    };

    console.log('[sillytavern-vault] Initializing external storage provider...');

    const db = await initDb(dbUrl);
    const s3 = await initS3(s3Config);

    const provider = createProvider(db, s3);
    registerStorageProvider(provider);

    router.get('/health', async (_req, res) => {
        try {
            await db.query('SELECT 1');
            res.json({ status: 'ok', db: 'connected', s3: 'configured' });
        } catch (err) {
            res.status(500).json({ status: 'error', error: err.message });
        }
    });

    console.log('[sillytavern-vault] External storage provider registered successfully');
}

export async function exit() {
    console.log('[sillytavern-vault] Shutting down...');
}
