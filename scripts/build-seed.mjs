import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const sourcePath =
  process.env.CHATVIEW_SOURCE_JSON ||
  '/Users/lululiang/chatlog_alpha/exports/raw_three_groups_json_20260523/all_raw_messages.json';
const outputPath = path.join(root, 'data', 'seed-messages.json');

const nils = new Set(['', '<nil>', 'nil', 'null', 'undefined']);

function clean(value) {
  if (value == null) return '';
  const s = String(value).trim();
  return nils.has(s.toLowerCase()) ? '' : s;
}

function cleanUrl(value) {
  const s = clean(value);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

function messageId(channelId, message, index) {
  const raw = clean(message.local_id) || `${message.timestamp || 0}${String(index).padStart(6, '0')}`;
  return `${channelId}:${raw}`;
}

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Source export not found: ${sourcePath}`);
}

const raw = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const groups = Array.isArray(raw.groups) ? raw.groups : [];
const groupMap = new Map();

for (const group of groups) {
  const channelId = clean(group.username);
  if (!channelId) continue;
  groupMap.set(channelId, {
    channel_id: channelId,
    channel: clean(group.chat) || channelId,
    message_count: Number(group.total_count || group.count || 0)
  });
}

const seen = new Set();
const messages = [];

for (const [index, message] of (raw.messages || []).entries()) {
  const channelId = clean(message.source_username) || clean(message.group_username) || clean(message.username);
  if (!channelId) continue;

  const channel = clean(message.source_group) || clean(message.group) || clean(message.chat) || groupMap.get(channelId)?.channel || channelId;
  const timestamp = Number(message.timestamp || 0);
  const externalId = messageId(channelId, message, index);
  if (seen.has(externalId)) continue;
  seen.add(externalId);

  const imageUrl = cleanUrl(message.image_url) || cleanUrl(message.media_url);

  messages.push({
    external_id: externalId,
    channel_id: channelId,
    channel,
    username: clean(message.sender) || 'Unknown',
    content: clean(message.content),
    image_url: imageUrl,
    timestamp,
    priority: 'normal'
  });

  if (!groupMap.has(channelId)) {
    groupMap.set(channelId, { channel_id: channelId, channel, message_count: 0 });
  }
}

const counts = new Map();
for (const message of messages) {
  counts.set(message.channel_id, (counts.get(message.channel_id) || 0) + 1);
}

const channels = [...groupMap.values()]
  .map((channel) => ({
    ...channel,
    message_count: counts.get(channel.channel_id) || channel.message_count || 0
  }))
  .filter((channel) => channel.message_count > 0)
  .sort((a, b) => b.message_count - a.message_count || a.channel.localeCompare(b.channel));

messages.sort((a, b) => b.timestamp - a.timestamp || b.external_id.localeCompare(a.external_id));

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify({ channels, messages }, null, 2) + '\n');

console.log(`Wrote ${messages.length} messages across ${channels.length} channels to ${outputPath}`);
