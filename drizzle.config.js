/** @type {import('drizzle-kit').Config} */
export default {
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.VAULT_DB_URL || 'postgresql://vault:vault123@localhost:5432/vault',
  },
};
