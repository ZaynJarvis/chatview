# ChatView

ChatLens L2 viewer and cleaned-message ingestion API.

## What Is Implemented

- `public/ChatLens.html`: three-column ChatLens UI.
- L2 consumes the message API contract.
- L1 and L0 are placeholders until their backend contracts exist.
- Channel filter, priority filter, search across loaded messages, star/archive local state, image thumbnails, lightbox, and message detail fetch are implemented.
- `server.js`: Node HTTP server with Postgres support on Railway and an empty in-memory fallback locally.
- `POST /api/messages`: authenticated daemon ingestion endpoint for cleaned messages.

No mock or seed messages are bundled in the repo.

## Run Locally

```sh
npm install
CHATVIEW_API_KEY=replace_me npm start
```

Open:

```text
http://localhost:3000/ChatLens.html
```

## Read API

```http
GET /api/channels
GET /api/messages?channel_id=&priority=&limit=50&cursor=
GET /api/messages/{external_id}
```

`priority` supports `high`, `normal`, `low`, and `ignore`.

## Daemon Write API

```http
POST /api/messages
Authorization: Bearer <CHATVIEW_API_KEY>
Content-Type: application/json
```

Single message:

```json
{
  "external_id": "26929515373@chatroom:1779325379000001",
  "channel_id": "26929515373@chatroom",
  "channel": "芝士美股分享②群",
  "username": "灝Fung",
  "content": "日本有什么好股票吗",
  "image_url": null,
  "timestamp": 1779325379,
  "priority": "normal"
}
```

Batch:

```json
{
  "messages": [
    {
      "external_id": "26929515373@chatroom:1779325379000001",
      "channel_id": "26929515373@chatroom",
      "channel": "芝士美股分享②群",
      "username": "灝Fung",
      "content": "日本有什么好股票吗",
      "image_url": null,
      "timestamp": 1779325379,
      "priority": "normal"
    }
  ]
}
```

The endpoint also accepts `x-api-key: <CHATVIEW_API_KEY>`. Writes are upserts by `external_id`.

## Railway

The app expects Railway to provide:

- Node service running `npm start`
- `DATABASE_URL` from Railway Postgres
- `CHATVIEW_API_KEY`
- `PORT` from Railway
