#!/usr/bin/env node

/**
 * Migration script: reads existing SillyTavern filesystem data and populates
 * PostgreSQL (chats) and S3 (images/media).
 *
 * Usage:
 *   VAULT_DB_URL=postgresql://... VAULT_S3_ENDPOINT=http://... node migrate.js [data-root]
 *
 * If data-root is not specified, defaults to ../../data (SillyTavern's default data directory).
 */

import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';

import { initDb } from './db.js';
import { initS3 } from './s3.js';

const DATA_ROOT = process.argv[2] || path.resolve(import.meta.dirname, '../../data');

async function main() {
    const dbUrl = process.env.VAULT_DB_URL;
    if (!dbUrl) {
        console.error('VAULT_DB_URL is required');
        process.exit(1);
    }

    const db = await initDb(dbUrl);
    const s3 = initS3({
        endpoint: process.env.VAULT_S3_ENDPOINT,
        bucket: process.env.VAULT_S3_BUCKET || 'vault-media',
        accessKey: process.env.VAULT_S3_ACCESS_KEY,
        secretKey: process.env.VAULT_S3_SECRET_KEY,
    });

    // Check if DB already has data
    const { rows } = await db.query('SELECT COUNT(*) as count FROM chats');
    if (parseInt(rows[0].count, 10) > 0) {
        console.log('Database already contains chat data. Skipping migration.');
        console.log('To force re-migration, truncate the chats table first.');
        await db.end();
        return;
    }

    console.log(`Migrating from data root: ${DATA_ROOT}`);

    if (!fs.existsSync(DATA_ROOT)) {
        console.error(`Data root not found: ${DATA_ROOT}`);
        await db.end();
        process.exit(1);
    }

    const userDirs = fs.readdirSync(DATA_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory());

    let chatCount = 0;
    let fileCount = 0;

    for (const userDir of userDirs) {
        const userHandle = userDir.name;
        const userPath = path.join(DATA_ROOT, userHandle);

        // Migrate chats
        const chatsPath = path.join(userPath, 'chats');
        if (fs.existsSync(chatsPath)) {
            const characterDirs = fs.readdirSync(chatsPath, { withFileTypes: true })
                .filter(d => d.isDirectory());

            for (const charDir of characterDirs) {
                const characterName = charDir.name;
                const charChatPath = path.join(chatsPath, characterName);
                const chatFiles = fs.readdirSync(charChatPath)
                    .filter(f => f.endsWith('.jsonl'));

                for (const chatFile of chatFiles) {
                    const content = fs.readFileSync(path.join(charChatPath, chatFile), 'utf-8');
                    await db.query(
                        `INSERT INTO chats (user_handle, character_name, file_name, content)
                         VALUES ($1, $2, $3, $4)
                         ON CONFLICT (user_handle, character_name, file_name) DO NOTHING`,
                        [userHandle, characterName, chatFile, content],
                    );
                    chatCount++;
                }
            }
        }

        // Migrate user images
        const imagesPath = path.join(userPath, 'user', 'images');
        if (fs.existsSync(imagesPath)) {
            fileCount += await migrateDirectory(s3, userHandle, imagesPath, 'user/images');
        }

        // Migrate backgrounds
        const bgPath = path.join(userPath, 'backgrounds');
        if (fs.existsSync(bgPath)) {
            fileCount += await migrateDirectory(s3, userHandle, bgPath, 'backgrounds');
        }

        // Migrate avatars
        const avatarsPath = path.join(userPath, 'User Avatars');
        if (fs.existsSync(avatarsPath)) {
            fileCount += await migrateDirectory(s3, userHandle, avatarsPath, 'User Avatars');
        }
    }

    console.log(`Migration complete: ${chatCount} chats, ${fileCount} files`);
    await db.end();
}

async function migrateDirectory(s3, userHandle, localDir, s3Prefix) {
    let count = 0;
    const entries = fs.readdirSync(localDir, { withFileTypes: true });

    for (const entry of entries) {
        const localPath = path.join(localDir, entry.name);
        const s3RelPath = `${s3Prefix}/${entry.name}`;

        if (entry.isDirectory()) {
            count += await migrateDirectory(s3, userHandle, localPath, s3RelPath);
        } else if (entry.isFile()) {
            const buffer = fs.readFileSync(localPath);
            const contentType = mime.lookup(entry.name) || 'application/octet-stream';
            const s3Key = `${userHandle}/${s3RelPath}`;
            await s3.put(s3Key, buffer, contentType);
            count++;
        }
    }

    return count;
}

main().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
