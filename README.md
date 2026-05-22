# ChatView

ChatLens L2 viewer for cleaned chat messages.

## What Is Implemented

- `public/ChatLens.html`: three-column ChatLens UI based on the design handoff.
- L2 is wired to the message API contract.
- L1 and L0 keep the designed columns as placeholders until their backend contracts exist.
- Low and ignored messages are hidden by default unless explicitly shown or filtered.
- Channel filter, priority filter, search across loaded messages, star/archive local state, image thumbnails, lightbox, and message detail fetch are implemented.
- `server.js`: Node HTTP server with Postgres support on Railway and in-memory seed fallback locally.

The original Claude Design handoff remains in:

- `chats/chat1.md`
- `project/ChatLens.html`
- `project/*.jsx`
- `project/styles.css`

## Run Locally

```sh
npm install
npm start
```

Open:

```text
http://localhost:3000/ChatLens.html
```

## API Contract

```http
GET /api/channels
```

```json
{
  "channels": [
    {
      "channel_id": "26929515373@chatroom",
      "channel": "芝士美股分享②群",
      "message_count": 2397
    }
  ]
}
```

```http
GET /api/messages?channel_id=&priority=&limit=50&cursor=
```

Supports `priority=high|normal|low|ignore`.

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
  ],
  "next_cursor": "50"
}
```

```http
GET /api/messages/{external_id}
```

```json
{
  "message": {
    "external_id": "26929515373@chatroom:1779325379000001",
    "channel_id": "26929515373@chatroom",
    "channel": "芝士美股分享②群",
    "username": "灝Fung",
    "content": "日本有什么好股票吗",
    "image_url": null,
    "timestamp": 1779325379,
    "priority": "normal"
  }
}
```

## Data

`data/seed-messages.json` contains 4,100 cleaned messages across:

- `芝士美股分享②群`
- `芝士美股分享①群`
- `Slock 中文社区（暂定）`

All seed priorities default to `normal`, matching the temporary backend behavior before the priority tagging agent is connected.

Regenerate the seed from the local export:

```sh
npm run build:seed
```

## Railway

The app expects Railway to provide:

- Node service running `npm start`
- `DATABASE_URL` from Railway Postgres
- `PORT` from Railway

On first boot with Postgres, the server creates the `messages` table and seeds it if empty.
