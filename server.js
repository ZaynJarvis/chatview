import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const publicDir = path.join(root, 'public');
const uploadsDir = process.env.UPLOAD_DIR || path.join('/tmp', 'chatview-uploads');
const port = Number(process.env.PORT || 3000);
const maxUploadBytes = Number(process.env.MAX_IMAGE_UPLOAD_BYTES || 10 * 1024 * 1024);
const allowedPriorities = new Set(['high', 'normal', 'low', 'ignore']);
const messageFields = 'external_id, channel_id, channel, username, content, image_url, timestamp, priority';
const imageTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif']
]);

let memoryMessages = [];
let pool = null;
let dbReady = false;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, x-filename'
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

function writeKeys() {
  return String(process.env.CHATVIEW_API_KEY || process.env.API_KEY || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

function isAuthorized(req) {
  const keys = writeKeys();
  if (keys.length === 0) return false;

  const headerKey = req.headers['x-api-key'];
  const auth = req.headers.authorization || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return [headerKey, bearer].some((candidate) => keys.includes(String(candidate || '').trim()));
}

async function readBuffer(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) chunks.push(chunk);
  for (const chunk of chunks) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`request body must be <= ${maxBytes} bytes`);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buffer = await readBuffer(req);
  if (buffer.length === 0) return {};
  return JSON.parse(buffer.toString('utf8'));
}

function normalizeMessage(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('message must be an object');
  }

  const externalId = String(input.external_id || '').trim();
  const channelId = String(input.channel_id || '').trim();
  const channel = String(input.channel || '').trim();
  const username = String(input.username || '').trim();
  const timestamp = Number(input.timestamp);
  const priority = String(input.priority || 'normal').trim().toLowerCase();

  if (!externalId) throw new Error('external_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (!channel) throw new Error('channel is required');
  if (!username) throw new Error('username is required');
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('timestamp must be Unix seconds');
  if (!allowedPriorities.has(priority)) throw new Error('priority must be one of high, normal, low, ignore');

  return {
    external_id: externalId,
    channel_id: channelId,
    channel,
    username,
    content: input.content == null ? '' : String(input.content),
    image_url: input.image_url == null || input.image_url === '' ? null : String(input.image_url),
    timestamp: Math.floor(timestamp),
    priority
  };
}

function normalizeMessageBatch(body) {
  const raw = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : body.message ? [body.message] : [body];
  if (raw.length === 0) throw new Error('at least one message is required');
  if (raw.length > 500) throw new Error('batch size must be <= 500');
  return raw.map(normalizeMessage);
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
  const channels = new Map();
  for (const message of memoryMessages) {
    const current = channels.get(message.channel_id);
    if (current) current.message_count += 1;
    else channels.set(message.channel_id, {
      channel_id: message.channel_id,
      channel: message.channel,
      message_count: 1
    });
  }
  return [...channels.values()].sort((a, b) => b.message_count - a.message_count || a.channel.localeCompare(b.channel));
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

  let list = memoryMessages;
  if (channelId) list = list.filter((message) => message.channel_id === channelId);
  if (priority) list = list.filter((message) => message.priority === priority);
  list = [...list].sort((a, b) => b.timestamp - a.timestamp || b.external_id.localeCompare(a.external_id));
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
  return memoryMessages.find((message) => message.external_id === externalId) || null;
}

async function upsertMessages(messages) {
  if (dbReady) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const message of messages) {
        await client.query(
          `insert into messages
           (external_id, channel_id, channel, username, content, image_url, timestamp, priority)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (external_id) do update set
             channel_id = excluded.channel_id,
             channel = excluded.channel,
             username = excluded.username,
             content = excluded.content,
             image_url = excluded.image_url,
             timestamp = excluded.timestamp,
             priority = excluded.priority`,
          [
            message.external_id,
            message.channel_id,
            message.channel,
            message.username,
            message.content,
            message.image_url,
            message.timestamp,
            message.priority
          ]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    return;
  }

  const byId = new Map(memoryMessages.map((message) => [message.external_id, message]));
  for (const message of messages) byId.set(message.external_id, message);
  memoryMessages = [...byId.values()];
}

function extForImage(contentType, filename = '') {
  const cleanType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (imageTypes.has(cleanType)) return imageTypes.get(cleanType);

  const ext = path.extname(String(filename || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'].includes(ext)) {
    return ext === '.jpeg' ? '.jpg' : ext;
  }
  return '';
}

async function receiveImage(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let filename = String(req.headers['x-filename'] || '');
  let type = contentType;
  let buffer;

  if (contentType === 'application/json') {
    const bodyBuffer = await readBuffer(req, maxUploadBytes + 1024);
    const body = JSON.parse(bodyBuffer.toString('utf8'));
    filename = body.filename || filename;
    type = String(body.content_type || '').split(';')[0].trim().toLowerCase();
    if (!body.data_base64) throw new Error('data_base64 is required');
    buffer = Buffer.from(String(body.data_base64), 'base64');
  } else {
    buffer = await readBuffer(req, maxUploadBytes);
  }

  if (buffer.length === 0) throw new Error('image body is empty');
  if (buffer.length > maxUploadBytes) throw new Error(`image must be <= ${maxUploadBytes} bytes`);

  const ext = extForImage(type, filename);
  if (!ext) throw new Error('content type must be an image: jpeg, png, gif, webp, heic, or heif');

  await fs.mkdir(uploadsDir, { recursive: true });
  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const filePath = path.join(uploadsDir, storedName);
  await fs.writeFile(filePath, buffer, { flag: 'wx' });
  return storedName;
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif']
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

async function serveUpload(res, pathname) {
  const basename = path.basename(decodeURIComponent(pathname.slice('/uploads/'.length)));
  if (!basename || basename.includes('/') || basename.includes('\\')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  try {
    const filePath = path.join(uploadsDir, basename);
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': mime.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
      'cache-control': 'public, max-age=86400'
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
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-api-key, x-filename'
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
        auth_configured: writeKeys().length > 0,
        messages: dbReady ? undefined : memoryMessages.length
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

    if (req.method === 'POST' && pathname === '/api/messages') {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const body = await readJson(req);
      const messages = normalizeMessageBatch(body);
      await upsertMessages(messages);
      json(res, 200, { ok: true, upserted: messages.length });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/images') {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const storedName = await receiveImage(req);
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const host = req.headers.host || `localhost:${port}`;
      json(res, 200, { image_url: `${proto}://${host}/uploads/${storedName}` });
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
      badRequest(res, 'unknown API route or method');
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
      await serveUpload(res, pathname);
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'internal server error' });
  }
}

try {
  await initDb();
} catch (error) {
  console.error('Postgres unavailable, falling back to empty in-memory store:', error.message);
  dbReady = false;
}

http.createServer(handler).listen(port, () => {
  console.log(`ChatView listening on http://localhost:${port}`);
  console.log(`Storage: ${dbReady ? 'postgres' : 'memory'}`);
  console.log(`Write auth: ${writeKeys().length > 0 ? 'configured' : 'missing'}`);
});
