# TikTok Live Connector Demo

Minimal Node.js script that connects to a TikTok LIVE broadcast with `tiktok-live-connector`, logs the chat and gift events, and illustrates how to handle basic connection lifecycle events.

## Setup

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` or set the variables in your shell. The connector expects:

| Variable | Description |
| --- | --- |
| `TIKTOK_USERNAME` | TikTok broadcaster `@uniqueId` who is currently live (e.g., `officialgeilegisela`). |
| `SIGN_API_KEY` | Euler sign API key used by the connector to build a valid websocket URL. |
| `VLC_URL` | VLC HTTP interface status endpoint (defaults to `http://localhost:8080/requests/status.json`). |
| `VLC_COMMAND` | VLC command to run when a gift finalizes (default `pl_next` for next song). |
| `VLC_USERNAME` | HTTP username for VLC. Leave blank when VLC only uses a password. |
| `VLC_PASSWORD` | HTTP password for VLC. If VLC requires auth, provide this value (400/401 if missing/mismatched). |
| `VLC_TIMEOUT_MS` | HTTP timeout when pinging VLC (default `5000`). |


## Running

```bash
npm start
```

The script:

- loads variables using `dotenv`, validates the required values, and connects to TikTok LIVE;
- logs connection lifecycle events, chat comments, and gift metadata;
- calls VLC’s HTTP API (`VLC_COMMAND`) whenever a non-streak gift arrives or a streak concludes, effectively skipping to the next song.
- the script calls `curl --user :Password http://localhost:8080/requests/status.json?command=…` (with your configured credentials), so VLC receives the exact request you verified.
- listens for chat comments; if a viewer types `/skip`, VLC will skip just like a gift.

Confirmed gifts are skipped right after they complete (`repeatEnd`), so repeated gift streaks do not fire the VLC command multiple times.

## Next steps

1. Extend the event handlers to emit data over WebSockets or HTTP so other apps can respond to gifts and chat.
2. Include richer gift metadata by enabling `enableExtendedGiftInfo` or calling `fetchAvailableGifts()`.
