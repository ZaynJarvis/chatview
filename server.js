import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const publicDir = path.join(root, 'public');
const seedPath = path.join(root, 'data', 'seed-messages.json');
const port = Number(process.env.PORT || 3000);
const allowedPriorities = new Set(['high', 'normal', 'low', 'ignore']);
const messageFields = 'external_id, channel_id, channel, username, content, image_url, timestamp, priority';

let seed = { channels: [], messages: [] };
let pool = null;
let dbReady = false;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(payload);
}

function badRequest(res, message) {
  json(res, 400, { error: message });
}

function clampLimit(value) {
  const n = Number(value || 50);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function parseCursor(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizePriority(value) {
  if (!value) return '';
  const priority = String(value).trim().toLowerCase();
  return allowedPriorities.has(priority) ? priority : null;
}

async function loadSeed() {
  const text = await fs.readFile(seedPath, 'utf8');
  seed = JSON.parse(text);
}

async function initDb() {
  if (!process.env.DATABASE_URL) return;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists messages (
        external_id text primary key,
        channel_id text not null,
        channel text not null,
        username text not null,
        content text not null default '',
        image_url text,
        timestamp bigint not null,
        priority text not null default 'normal'
          check (priority in ('high', 'normal', 'low', 'ignore'))
      )
    `);
    await client.query('create index if not exists messages_channel_timestamp_idx on messages (channel_id, timestamp desc, external_id desc)');
    await client.query('create index if not exists messages_priority_idx on messages (priority)');

    const count = Number((await client.query('select count(*)::int as count from messages')).rows[0].count);
    if (count === 0 && seed.messages.length > 0) {
      await client.query('begin');
      try {
        for (const message of seed.messages) {
          await client.query(
            `insert into messages
             (external_id, channel_id, channel, username, content, image_url, timestamp, priority)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             on conflict (external_id) do nothing`,
            [
              message.external_id,
              message.channel_id,
              message.channel,
              message.username,
              message.content || '',
              message.image_url || null,
              message.timestamp,
              message.priority || 'normal'
            ]
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
    dbReady = true;
  } finally {
    client.release();
  }
}

async function getChannels() {
  if (dbReady) {
    const result = await pool.query(`
      select channel_id, max(channel) as channel, count(*)::int as message_count
      from messages
      group by channel_id
      order by message_count desc, channel asc
    `);
    return result.rows;
  }
  return seed.channels;
}

async function getMessages(params) {
  const limit = clampLimit(params.get('limit'));
  const offset = parseCursor(params.get('cursor'));
  const channelId = params.get('channel_id') || '';
  const priority = normalizePriority(params.get('priority'));

  if (priority === null) {
    return { status: 400, body: { error: 'priority must be one of high, normal, low, ignore' } };
  }

  if (dbReady) {
    const where = [];
    const values = [];
    if (channelId) {
      values.push(channelId);
      where.push(`channel_id = $${values.length}`);
    }
    if (priority) {
      values.push(priority);
      where.push(`priority = $${values.length}`);
    }
    values.push(limit + 1);
    const limitParam = `$${values.length}`;
    values.push(offset);
    const offsetParam = `$${values.length}`;
    const result = await pool.query(
      `select ${messageFields}
       from messages
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by timestamp desc, external_id desc
       limit ${limitParam} offset ${offsetParam}`,
      values
    );
    const rows = result.rows.slice(0, limit);
    return {
      status: 200,
      body: { messages: rows, next_cursor: result.rows.length > limit ? String(offset + limit) : null }
    };
  }

  let list = seed.messages;
  if (channelId) list = list.filter((message) => message.channel_id === channelId);
  if (priority) list = list.filter((message) => message.priority === priority);
  const page = list.slice(offset, offset + limit + 1);
  return {
    status: 200,
    body: {
      messages: page.slice(0, limit),
      next_cursor: page.length > limit ? String(offset + limit) : null
    }
  };
}

async function getMessage(externalId) {
  if (!externalId) return null;
  if (dbReady) {
    const result = await pool.query(
      `select ${messageFields} from messages where external_id = $1 limit 1`,
      [externalId]
    );
    return result.rows[0] || null;
  }
  return seed.messages.find((message) => message.external_id === externalId) || null;
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

async function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/ChatLens.html' : pathname;
  const safePath = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': mime.get(path.extname(filePath)) || 'application/octet-stream',
      'cache-control': 'public, max-age=60'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      json(res, 200, {
        ok: true,
        storage: dbReady ? 'postgres' : 'memory',
        messages: dbReady ? undefined : seed.messages.length
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/channels') {
      json(res, 200, { channels: await getChannels() });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/messages') {
      const result = await getMessages(url.searchParams);
      json(res, result.status, result.body);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/messages/')) {
      const externalId = decodeURIComponent(pathname.slice('/api/messages/'.length));
      const message = await getMessage(externalId);
      if (!message) {
        json(res, 404, { error: 'message not found' });
        return;
      }
      json(res, 200, { message });
      return;
    }

    if (pathname.startsWith('/api/')) {
      badRequest(res, 'unknown API route');
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'internal server error' });
  }
}

await loadSeed();
try {
  await initDb();
} catch (error) {
  console.error('Postgres unavailable, falling back to in-memory seed:', error.message);
  dbReady = false;
}

http.createServer(handler).listen(port, () => {
  console.log(`ChatView listening on http://localhost:${port}`);
  console.log(`Storage: ${dbReady ? 'postgres' : 'memory seed'}`);
});
