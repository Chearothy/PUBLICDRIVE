# Public Drive + Telegram Video Library

This version keeps the existing Google Drive folder browser and adds Telegram as a second storage option. Telegram uploads go through a Node.js backend; the Telegram bot token is read only from the server's `.env` file and is never sent to the browser.

## Requirements

- Node.js 20 or newer
- A Telegram bot created with `@BotFather`
- A Telegram channel where that bot is an administrator with permission to post messages

## Run locally (Windows / VS Code)

1. Extract this project folder and open it in VS Code.
2. Open the VS Code terminal in this folder (the folder containing `package.json`).
3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy `.env.example` to a new file named `.env`.
5. Edit `.env` and set:

   - `TELEGRAM_BOT_TOKEN`: token from `@BotFather`. Keep it secret.
   - `TELEGRAM_CHAT_ID`: your channel username such as `@my_video_channel`, or the channel's numeric chat ID.
   - `ADMIN_UPLOAD_PASSWORD`: a long, unique password you choose. Enter this password in the app before uploading.
   - `TELEGRAM_CHANNEL_USERNAME`: public channel username without `@` if you want each saved item to show an “Open in Telegram” link. Leave blank for a private channel; private-channel message links need a suitable invite/access link and are not guessed by this app.

6. In Telegram, add the bot to the channel as an administrator and allow it to post messages. For a private channel, configure the numeric chat ID correctly.
7. Start the app:

   ```bash
   npm start
   ```

8. Open **http://localhost:3000** in your browser. Do not open `index.html` directly from the file system; the Telegram feature needs the backend.
9. Select **Upload**, enter your admin upload password, choose videos, and click **Upload to Telegram**. Google Drive browsing remains available.

## Automatic channel video sync

This version automatically adds **new video posts** to the website list when the configured bot receives `channel_post` updates. The bot must be an administrator in the configured channel. Keep the Node server running for syncing to work. Both videos and video files sent as documents are recognized.

**Important limitation:** Telegram Bot API does not provide a method for a bot to read the complete historical channel message history. Therefore, posts made before the bot receives updates will not all appear automatically. This auto-sync captures new posts going forward (and any pending updates Telegram still has for the bot). To import older channel posts, use a separate Telegram client/MTProto-based importer with a user account session; that is not included here. Do not share your Telegram account login code or session file.

The bot uses long polling (`getUpdates`). If another app is polling the same bot, or a webhook is configured for the bot, syncing can fail. Use only one polling process for this bot.

## File size notes

The server's default cap is 2 GB per file (`MAX_UPLOAD_BYTES`). This is only the application-side cap, not a promise that Telegram's hosted Bot API accepts files that large. The standard cloud Bot API has a much smaller upload limit (commonly 50 MB for `sendVideo`). To upload larger files, install and operate Telegram's official **Local Bot API Server**, then set `TELEGRAM_API_BASE_URL` to its local base URL, for example `http://127.0.0.1:8081`, and configure the local server according to Telegram's current documentation. Local Bot API server operation is an additional service and is not included in this project. Make sure the local API server is reachable only by trusted services.

Telegram may also have separate playback/download restrictions depending on whether the hosted or local Bot API is used. This project stores the videos in the channel and saves metadata; “Open in Telegram” opens the channel post when a public channel username is configured. It does not proxy the video bytes through the website.

## Deploying securely

- Deploy the Node backend and website together behind HTTPS.
- Set environment variables in your hosting provider's secret/environment settings; do not upload `.env` to Git or share it.
- Use a unique strong `ADMIN_UPLOAD_PASSWORD`. Rotate it if it is exposed.
- Keep the Telegram bot an administrator only in the intended channel.
- Restrict upload size and disk usage for your environment. Ensure `data/` is writable and has enough temporary disk space.
- The JSON metadata database is stored in `data/telegram-videos.json`. Back it up if you need the site's list to survive server replacement. The actual video files are stored in Telegram.
- For multiple server instances, replace the local JSON metadata store with a shared database.
- Existing Google Drive integration still uses a Google API key in the frontend. Restrict that key in Google Cloud Console to the required APIs and allowed website origins; do not treat a browser key as a secret.

## Troubleshooting

- **Backend unavailable:** run `npm install` and `npm start` from this folder, then use `http://localhost:3000`.
- **Server is not configured:** make sure `.env` exists and the required values are filled in; restart the server after editing it.
- **Chat not found / forbidden:** ensure the bot is an administrator in the correct channel and `TELEGRAM_CHAT_ID` is correct.
- **File too large:** the hosted Telegram Bot API has a lower limit. Use a properly configured Local Bot API Server for large files and update `TELEGRAM_API_BASE_URL`.
- **Upload password rejected:** enter exactly the value configured in `ADMIN_UPLOAD_PASSWORD`.

## API endpoints

- `GET /api/health` — backend status and configured upload cap (does not reveal secrets)
- `GET /api/telegram/videos` — list saved Telegram video metadata (including synced new channel posts)
- `POST /api/telegram/upload` — authenticated multipart upload; form field `video`, header `x-admin-password`
