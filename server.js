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
const allowedLevels = new Set(['L0', 'L1']);
const messageFields = 'external_id, channel_id, channel, username, content, image_url, timestamp, priority';
const channelStateFields = [
  'state_id',
  'channel_id',
  'level',
  'markdown',
  'cards',
  'window_start',
  'window_end',
  'source_message_ids',
  'previous_state_id',
  'created_at',
  'updated_at'
].join(', ');
const reportFields = [
  'report_id',
  'level',
  'channel_id',
  'title',
  'summary',
  'markdown',
  'topics',
  'reference_items as "references"',
  'window_start',
  'window_end',
  'source_state_ids',
  'source_message_ids',
  'created_at',
  'updated_at'
].join(', ');
const imageTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif']
]);

let memoryMessages = [];
let memoryChannelStates = [];
let memoryReports = [];
let memoryUploads = new Map();
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

function clampReportLimit(value) {
  const n = Number(value || 20);
  if (!Number.isFinite(n)) return 20;
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

function normalizeLevel(value) {
  const level = String(value || '').trim().toUpperCase();
  return allowedLevels.has(level) ? level : null;
}

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
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

function normalizeStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > 1000) throw new Error(`${field} must contain <= 1000 items`);
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function normalizeWindow(input) {
  const windowStart = Number(input.window_start);
  const windowEnd = Number(input.window_end);
  if (!Number.isFinite(windowStart) || windowStart <= 0) throw new Error('window_start must be Unix seconds');
  if (!Number.isFinite(windowEnd) || windowEnd <= 0) throw new Error('window_end must be Unix seconds');
  if (windowEnd < windowStart) throw new Error('window_end must be >= window_start');
  return {
    window_start: Math.floor(windowStart),
    window_end: Math.floor(windowEnd)
  };
}

function normalizeCards(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('cards must be an array');
  if (value.length > 200) throw new Error('cards must contain <= 200 items');
  return value.map((card, index) => {
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new Error(`cards[${index}] must be an object`);
    }
    const priority = String(card.priority || 'normal').trim().toLowerCase();
    if (!allowedPriorities.has(priority)) {
      throw new Error(`cards[${index}].priority must be one of high, normal, low, ignore`);
    }
    return {
      title: String(card.title || '').trim(),
      body: card.body == null ? '' : String(card.body),
      priority,
      message_ids: normalizeStringArray(card.message_ids, `cards[${index}].message_ids`)
    };
  });
}

function normalizeReferences(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('references must be an array');
  if (value.length > 500) throw new Error('references must contain <= 500 items');
  return value.map((reference, index) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
      throw new Error(`references[${index}] must be an object`);
    }
    return {
      title: String(reference.title || '').trim(),
      url: String(reference.url || '').trim()
    };
  }).filter((reference) => reference.title || reference.url);
}

function normalizeChannelState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('channel state must be an object');
  }

  const stateId = String(input.state_id || generateId('st')).trim();
  const channelId = String(input.channel_id || '').trim();
  const level = normalizeLevel(input.level || 'L1');
  const window = normalizeWindow(input);

  if (!stateId) throw new Error('state_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (level !== 'L1') throw new Error('level must be L1');

  return {
    state_id: stateId,
    channel_id: channelId,
    level,
    markdown: input.markdown == null ? '' : String(input.markdown),
    cards: normalizeCards(input.cards),
    ...window,
    source_message_ids: normalizeStringArray(input.source_message_ids, 'source_message_ids'),
    previous_state_id: input.previous_state_id == null || input.previous_state_id === ''
      ? null
      : String(input.previous_state_id).trim()
  };
}

function normalizeReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('report must be an object');
  }

  const reportId = String(input.report_id || generateId('rp')).trim();
  const channelId = String(input.channel_id || '').trim();
  const level = normalizeLevel(input.level || 'L0');
  const window = normalizeWindow(input);

  if (!reportId) throw new Error('report_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (level !== 'L0') throw new Error('level must be L0');

  return {
    report_id: reportId,
    level,
    channel_id: channelId,
    title: String(input.title || '').trim(),
    summary: input.summary == null ? '' : String(input.summary),
    markdown: input.markdown == null ? '' : String(input.markdown),
    topics: normalizeStringArray(input.topics, 'topics'),
    references: normalizeReferences(input.references),
    ...window,
    source_state_ids: normalizeStringArray(input.source_state_ids, 'source_state_ids'),
    source_message_ids: normalizeStringArray(input.source_message_ids, 'source_message_ids')
  };
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
    await client.query(`
      create table if not exists channel_states (
        state_id text primary key,
        channel_id text not null,
        level text not null
          check (level in ('L1')),
        markdown text not null default '',
        cards jsonb not null default '[]'::jsonb,
        window_start bigint not null,
        window_end bigint not null,
        source_message_ids jsonb not null default '[]'::jsonb,
        previous_state_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (channel_id, level, window_start, window_end)
      )
    `);
    await client.query('create index if not exists channel_states_latest_idx on channel_states (channel_id, level, window_end desc, updated_at desc)');
    await client.query(`
      create table if not exists reports (
        report_id text primary key,
        level text not null
          check (level in ('L0')),
        channel_id text not null,
        title text not null default '',
        summary text not null default '',
        markdown text not null default '',
        topics jsonb not null default '[]'::jsonb,
        reference_items jsonb not null default '[]'::jsonb,
        window_start bigint not null,
        window_end bigint not null,
        source_state_ids jsonb not null default '[]'::jsonb,
        source_message_ids jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await client.query('create index if not exists reports_latest_idx on reports (level, channel_id, window_end desc, updated_at desc)');
    await client.query(`
      create table if not exists uploaded_images (
        stored_name text primary key,
        content_type text not null,
        data bytea not null,
        created_at timestamptz not null default now()
      )
    `);
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

async function getChannelState(params) {
  const channelId = String(params.get('channel_id') || '').trim();
  const level = normalizeLevel(params.get('level') || 'L1');

  if (!channelId) return { status: 400, body: { error: 'channel_id is required' } };
  if (level !== 'L1') return { status: 400, body: { error: 'level must be L1' } };

  if (dbReady) {
    const result = await pool.query(
      `select ${channelStateFields}
       from channel_states
       where channel_id = $1 and level = $2
       order by window_end desc, window_start desc, updated_at desc, state_id desc
       limit 1`,
      [channelId, level]
    );
    return { status: 200, body: { state: result.rows[0] || null } };
  }

  const state = memoryChannelStates
    .filter((item) => item.channel_id === channelId && item.level === level)
    .sort((a, b) =>
      b.window_end - a.window_end ||
      b.window_start - a.window_start ||
      String(b.updated_at).localeCompare(String(a.updated_at)) ||
      b.state_id.localeCompare(a.state_id)
    )[0] || null;
  return { status: 200, body: { state } };
}

async function upsertChannelState(state) {
  if (dbReady) {
    const result = await pool.query(
      `insert into channel_states
       (state_id, channel_id, level, markdown, cards, window_start, window_end, source_message_ids, previous_state_id)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9)
       on conflict (channel_id, level, window_start, window_end) do update set
         markdown = excluded.markdown,
         cards = excluded.cards,
         source_message_ids = excluded.source_message_ids,
         previous_state_id = excluded.previous_state_id,
         updated_at = now()
       returning ${channelStateFields}`,
      [
        state.state_id,
        state.channel_id,
        state.level,
        state.markdown,
        JSON.stringify(state.cards),
        state.window_start,
        state.window_end,
        JSON.stringify(state.source_message_ids),
        state.previous_state_id
      ]
    );
    return result.rows[0];
  }

  const now = new Date().toISOString();
  const index = memoryChannelStates.findIndex((item) =>
    item.channel_id === state.channel_id &&
    item.level === state.level &&
    item.window_start === state.window_start &&
    item.window_end === state.window_end
  );
  if (index >= 0) {
    memoryChannelStates[index] = {
      ...state,
      state_id: memoryChannelStates[index].state_id,
      created_at: memoryChannelStates[index].created_at,
      updated_at: now
    };
    return memoryChannelStates[index];
  }
  const stored = { ...state, created_at: now, updated_at: now };
  memoryChannelStates.push(stored);
  return stored;
}

async function getReports(params) {
  const limit = clampReportLimit(params.get('limit'));
  const channelId = String(params.get('channel_id') || '').trim();
  const level = normalizeLevel(params.get('level') || 'L0');

  if (level !== 'L0') return { status: 400, body: { error: 'level must be L0' } };

  if (dbReady) {
    const where = ['level = $1'];
    const values = [level];
    if (channelId) {
      values.push(channelId);
      where.push(`channel_id = $${values.length}`);
    }
    values.push(limit);
    const result = await pool.query(
      `select ${reportFields}
       from reports
       where ${where.join(' and ')}
       order by window_end desc, updated_at desc, report_id desc
       limit $${values.length}`,
      values
    );
    return { status: 200, body: { reports: result.rows } };
  }

  const reports = memoryReports
    .filter((report) => report.level === level && (!channelId || report.channel_id === channelId))
    .sort((a, b) =>
      b.window_end - a.window_end ||
      String(b.updated_at).localeCompare(String(a.updated_at)) ||
      b.report_id.localeCompare(a.report_id)
    )
    .slice(0, limit);
  return { status: 200, body: { reports } };
}

async function upsertReport(report) {
  if (dbReady) {
    const result = await pool.query(
      `insert into reports
       (report_id, level, channel_id, title, summary, markdown, topics, reference_items, window_start, window_end, source_state_ids, source_message_ids)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb)
       on conflict (report_id) do update set
         level = excluded.level,
         channel_id = excluded.channel_id,
         title = excluded.title,
         summary = excluded.summary,
         markdown = excluded.markdown,
         topics = excluded.topics,
         reference_items = excluded.reference_items,
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         source_state_ids = excluded.source_state_ids,
         source_message_ids = excluded.source_message_ids,
         updated_at = now()
       returning ${reportFields}`,
      [
        report.report_id,
        report.level,
        report.channel_id,
        report.title,
        report.summary,
        report.markdown,
        JSON.stringify(report.topics),
        JSON.stringify(report.references),
        report.window_start,
        report.window_end,
        JSON.stringify(report.source_state_ids),
        JSON.stringify(report.source_message_ids)
      ]
    );
    return result.rows[0];
  }

  const now = new Date().toISOString();
  const index = memoryReports.findIndex((item) => item.report_id === report.report_id);
  if (index >= 0) {
    memoryReports[index] = {
      ...report,
      created_at: memoryReports[index].created_at,
      updated_at: now
    };
    return memoryReports[index];
  }
  const stored = { ...report, created_at: now, updated_at: now };
  memoryReports.push(stored);
  return stored;
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
  const storedType = {
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif'
  }[ext] || type || 'application/octet-stream';

  const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  if (dbReady) {
    await pool.query(
      `insert into uploaded_images (stored_name, content_type, data)
       values ($1, $2, $3)
       on conflict (stored_name) do update set
         content_type = excluded.content_type,
         data = excluded.data`,
      [storedName, storedType, buffer]
    );
    return storedName;
  }

  memoryUploads.set(storedName, { content_type: storedType, data: buffer });
  await fs.mkdir(uploadsDir, { recursive: true });
  const filePath = path.join(uploadsDir, storedName);
  await fs.writeFile(filePath, buffer, { flag: 'wx' });
  return storedName;
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
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
  const requested = pathname === '/' ? '/ChatView.html' : pathname;
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
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
      expires: '0'
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

  if (dbReady) {
    const result = await pool.query(
      'select content_type, data from uploaded_images where stored_name = $1 limit 1',
      [basename]
    );
    const stored = result.rows[0];
    if (stored) {
      res.writeHead(200, {
        'content-type': stored.content_type,
        'cache-control': 'public, max-age=31536000, immutable'
      });
      res.end(stored.data);
      return;
    }
  }

  const memoryUpload = memoryUploads.get(basename);
  if (memoryUpload) {
    res.writeHead(200, {
      'content-type': memoryUpload.content_type,
      'cache-control': 'public, max-age=86400'
    });
    res.end(memoryUpload.data);
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
        messages: dbReady ? undefined : memoryMessages.length,
        channel_states: dbReady ? undefined : memoryChannelStates.length,
        reports: dbReady ? undefined : memoryReports.length
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

    if (req.method === 'GET' && pathname === '/api/channel-state') {
      const result = await getChannelState(url.searchParams);
      json(res, result.status, result.body);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/channel-state') {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      let input;
      try {
        input = normalizeChannelState(await readJson(req));
      } catch (error) {
        badRequest(res, error.message);
        return;
      }
      const state = await upsertChannelState(input);
      json(res, 200, { ok: true, state });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/reports') {
      const result = await getReports(url.searchParams);
      json(res, result.status, result.body);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/reports') {
      if (!isAuthorized(req)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      let input;
      try {
        input = normalizeReport(await readJson(req));
      } catch (error) {
        badRequest(res, error.message);
        return;
      }
      const report = await upsertReport(input);
      json(res, 200, { ok: true, report });
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
      let storedName;
      try {
        storedName = await receiveImage(req);
      } catch (error) {
        badRequest(res, error.message);
        return;
      }
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
