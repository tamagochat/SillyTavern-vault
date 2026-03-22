import path from 'node:path';
import mime from 'mime-types';

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Creates the storage provider implementation backed by Postgres + S3.
 * @param {import('pg').Pool} db
 * @param {import('./s3.js').S3Handle} s3
 */
export function createProvider(db, s3) {
    return {
        // ─── Chats ───────────────────────────────────────────────

        async saveChat(userHandle, characterName, fileName, jsonlContent) {
            await db.query(
                `INSERT INTO chats (user_handle, character_name, file_name, content, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (user_handle, character_name, file_name)
                 DO UPDATE SET content = $4, updated_at = NOW()`,
                [userHandle, characterName, fileName, jsonlContent],
            );
        },

        async readChat(userHandle, characterName, fileName) {
            let result;
            if (userHandle) {
                result = await db.query(
                    'SELECT content FROM chats WHERE user_handle = $1 AND character_name = $2 AND file_name = $3',
                    [userHandle, characterName, fileName],
                );
            } else {
                result = await db.query(
                    'SELECT content FROM chats WHERE character_name = $1 AND file_name = $2',
                    [characterName, fileName],
                );
            }
            return result.rows.length > 0 ? result.rows[0].content : null;
        },

        async deleteChat(userHandle, characterName, fileName) {
            const result = await db.query(
                'DELETE FROM chats WHERE user_handle = $1 AND character_name = $2 AND file_name = $3',
                [userHandle, characterName, fileName],
            );
            return result.rowCount > 0;
        },

        async listChats(userHandle, characterName) {
            let query, params;
            if (characterName) {
                query = `SELECT file_name, updated_at, length(content) as content_length,
                         (SELECT count(*) FROM regexp_split_to_table(content, E'\\n') WHERE length(trim(regexp_split_to_table)) > 0) as message_count,
                         (SELECT x FROM unnest(regexp_split_to_array(content, E'\\n')) WITH ORDINALITY AS t(x, ord) WHERE length(trim(x)) > 0 ORDER BY ord DESC LIMIT 1) as last_line
                         FROM chats WHERE user_handle = $1 AND character_name = $2
                         ORDER BY updated_at DESC`;
                params = [userHandle, characterName];
            } else {
                query = `SELECT file_name, character_name, updated_at, length(content) as content_length,
                         (SELECT count(*) FROM regexp_split_to_table(content, E'\\n') WHERE length(trim(regexp_split_to_table)) > 0) as message_count,
                         (SELECT x FROM unnest(regexp_split_to_array(content, E'\\n')) WITH ORDINALITY AS t(x, ord) WHERE length(trim(x)) > 0 ORDER BY ord DESC LIMIT 1) as last_line
                         FROM chats WHERE user_handle = $1
                         ORDER BY updated_at DESC`;
                params = [userHandle];
            }
            const result = await db.query(query, params);
            return result.rows.map(row => {
                let previewMessage = '';
                try {
                    const lastLine = JSON.parse(row.last_line || '{}');
                    previewMessage = lastLine.mes || '';
                } catch { /* ignore parse errors */ }
                return {
                    file_name: row.file_name,
                    character_name: row.character_name,
                    file_size: formatBytes(parseInt(row.content_length, 10) || 0),
                    message_count: Math.max(0, parseInt(row.message_count, 10) - 1),
                    last_mes: row.updated_at,
                    preview_message: previewMessage.substring(0, 400),
                };
            });
        },

        async renameChat(userHandle, characterName, oldName, newName) {
            await db.query(
                `UPDATE chats SET file_name = $4, updated_at = NOW()
                 WHERE user_handle = $1 AND character_name = $2 AND file_name = $3`,
                [userHandle, characterName, oldName, newName],
            );
        },

        async searchChats(userHandle, query, characterName) {
            if (!query || query.trim().length === 0) {
                return this.listChats(userHandle, characterName);
            }

            const tsQuery = query.trim().split(/\s+/).join(' & ');
            let sql = `SELECT file_name, character_name, updated_at, length(content) as content_length,
                        (SELECT count(*) FROM regexp_split_to_table(content, E'\\n') WHERE length(trim(regexp_split_to_table)) > 0) as message_count,
                        (SELECT x FROM unnest(regexp_split_to_array(content, E'\\n')) WITH ORDINALITY AS t(x, ord) WHERE length(trim(x)) > 0 ORDER BY ord DESC LIMIT 1) as last_line
                        FROM chats
                        WHERE user_handle = $1 AND to_tsvector('simple', content) @@ to_tsquery('simple', $2)`;
            const params = [userHandle, tsQuery];

            if (characterName) {
                sql += ' AND character_name = $3';
                params.push(characterName);
            }
            sql += ' ORDER BY updated_at DESC';

            const result = await db.query(sql, params);
            return result.rows.map(row => {
                let previewMessage = '';
                try {
                    const lastLine = JSON.parse(row.last_line || '{}');
                    previewMessage = lastLine.mes || '';
                } catch { /* ignore parse errors */ }
                return {
                    file_name: row.file_name,
                    character_name: row.character_name,
                    file_size: formatBytes(parseInt(row.content_length, 10) || 0),
                    message_count: Math.max(0, parseInt(row.message_count, 10) - 1),
                    last_mes: row.updated_at,
                    preview_message: previewMessage.substring(0, 400),
                };
            });
        },

        // ─── Character-level operations ─────────────────────────

        async renameCharacterChats(userHandle, oldCharName, newCharName) {
            await db.query(
                `UPDATE chats SET character_name = $3, updated_at = NOW()
                 WHERE user_handle = $1 AND character_name = $2`,
                [userHandle, oldCharName, newCharName],
            );
        },

        async deleteCharacterChats(userHandle, characterName) {
            await db.query(
                'DELETE FROM chats WHERE user_handle = $1 AND character_name = $2',
                [userHandle, characterName],
            );
        },

        // ─── Groups (stored in S3) ──────────────────────────────

        async saveGroup(userHandle, groupId, jsonString) {
            const s3Key = `${userHandle}/groups/${groupId}.json`;
            await s3.put(s3Key, Buffer.from(jsonString, 'utf8'), 'application/json');
        },

        async readGroup(userHandle, groupId) {
            const s3Key = `${userHandle}/groups/${groupId}.json`;
            try {
                const obj = await s3.get(s3Key);
                const chunks = [];
                for await (const chunk of obj.Body) {
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks).toString('utf8');
            } catch (err) {
                if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                    return null;
                }
                throw err;
            }
        },

        async deleteGroup(userHandle, groupId) {
            const s3Key = `${userHandle}/groups/${groupId}.json`;
            await s3.del(s3Key);
        },

        async listGroups(userHandle) {
            const prefix = `${userHandle}/groups/`;
            const keys = await s3.list(prefix);
            const groups = [];
            for (const key of keys) {
                if (!key.endsWith('.json')) continue;
                try {
                    const obj = await s3.get(key);
                    const chunks = [];
                    for await (const chunk of obj.Body) {
                        chunks.push(chunk);
                    }
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    groups.push(data);
                } catch (err) {
                    console.warn(`[StorageProvider] Failed to read group ${key}:`, err.message);
                }
            }
            return groups;
        },

        // ─── Avatars ──────────────────────────────────────────────

        async listAvatars(userHandle) {
            const prefix = `${userHandle}/User Avatars/`;
            const keys = await s3.list(prefix);
            return keys.map(key => path.basename(key));
        },

        // ─── Backgrounds ─────────────────────────────────────────

        async listBackgrounds(userHandle) {
            const prefix = `${userHandle}/backgrounds/`;
            const keys = await s3.list(prefix);
            return keys.map(key => path.basename(key));
        },

        async renameBackground(userHandle, oldName, newName) {
            const oldKey = `${userHandle}/backgrounds/${oldName}`;
            const newKey = `${userHandle}/backgrounds/${newName}`;
            const obj = await s3.get(oldKey);
            const chunks = [];
            for await (const chunk of obj.Body) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);
            const contentType = obj.ContentType || 'application/octet-stream';
            await s3.put(newKey, buffer, contentType);
            await s3.del(oldKey);
        },

        // ─── Files (images, avatars, etc.) ───────────────────────

        async saveFile(userHandle, relativePath, buffer) {
            const cleanPath = relativePath.replace(/^\/+/, '');
            const s3Key = `${userHandle}/${cleanPath}`;
            const contentType = mime.lookup(cleanPath) || 'application/octet-stream';
            await s3.put(s3Key, buffer, contentType);
            return relativePath;
        },

        async deleteFile(userHandle, relativePath) {
            const cleanPath = relativePath.replace(/^\/+/, '');
            const s3Key = `${userHandle}/${cleanPath}`;
            await s3.del(s3Key);
            return true;
        },

        async listFiles(userHandle, directory, sort, type) {
            const prefix = `${userHandle}/user/images/${directory}/`;
            const keys = await s3.list(prefix);
            return keys.map(key => path.basename(key));
        },

        async readFile(userHandle, relativePath) {
            const cleanPath = relativePath.replace(/^\/+/, '');
            const s3Key = `${userHandle}/${cleanPath}`;
            try {
                const obj = await s3.get(s3Key);
                const chunks = [];
                for await (const chunk of obj.Body) {
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks);
            } catch (err) {
                if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                    return null;
                }
                throw err;
            }
        },

        async serveFile(userHandle, relativePath, res) {
            if (!userHandle) return false;

            const cleanPath = relativePath.replace(/^\/+/, '');
            const s3Key = `${userHandle}/${cleanPath}`;
            try {
                const obj = await s3.get(s3Key);
                const contentType = obj.ContentType || mime.lookup(relativePath) || 'application/octet-stream';
                res.setHeader('Content-Type', contentType);
                if (obj.ContentLength) {
                    res.setHeader('Content-Length', obj.ContentLength);
                }
                obj.Body.pipe(res);
                return true;
            } catch (err) {
                if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
                    return false;
                }
                throw err;
            }
        },
    };
}
