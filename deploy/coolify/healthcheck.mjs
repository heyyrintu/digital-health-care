// Also used by CI against the built backend, without a container-side curl dependency.
import { createRequire } from 'node:module';
import { access, constants } from 'node:fs/promises';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = require('pg');
const { Redis } = require('ioredis');
const mode = process.argv[2];
const deadline = setTimeout(() => process.exit(1), 8000);
let db;
let redis;
try {
  db = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
  });
  await db.connect();
  await db.query('SELECT 1');
  redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on('error', () => {});
  await redis.connect();
  if ((await redis.ping()) !== 'PONG') throw new Error('Redis unavailable');
  if (mode === 'api') {
    await access(process.env.FILE_STORE_DIR, constants.R_OK | constants.W_OK);
    const response = await fetch('http://127.0.0.1:4000/v1/ready', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('API unavailable');
  } else if (mode !== 'workers') throw new Error('Unknown health check');
} catch {
  // Do not print connection strings or credentials on probe failures.
  process.exitCode = 1;
} finally {
  redis?.disconnect();
  await db?.end().catch(() => {});
  clearTimeout(deadline);
}
