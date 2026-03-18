import pg from 'pg';

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_handle TEXT NOT NULL,
    character_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_handle, character_name, file_name)
);

CREATE INDEX IF NOT EXISTS idx_chats_lookup ON chats(user_handle, character_name);
CREATE INDEX IF NOT EXISTS idx_chats_search ON chats USING gin(to_tsvector('simple', content));
`;

/**
 * Initialize the database connection and ensure schema exists.
 * @param {string} connectionString PostgreSQL connection URL
 * @returns {Promise<pg.Pool>}
 */
export async function initDb(connectionString) {
    const pool = new pg.Pool({ connectionString });

    const client = await pool.connect();
    try {
        await client.query(SCHEMA_SQL);
        console.log('[sillytavern-vault/db] Schema initialized');
    } finally {
        client.release();
    }

    return pool;
}
