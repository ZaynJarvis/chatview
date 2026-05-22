# Data

`seed-messages.json` is a cleaned L2 seed that matches the frontend API contract:

- `external_id`
- `channel_id`
- `channel`
- `username`
- `content`
- `image_url`
- `timestamp`
- `priority`

When `DATABASE_URL` is configured, the server creates a `messages` table and loads this seed only if the table is empty. Without Postgres, the API serves this seed from memory.
