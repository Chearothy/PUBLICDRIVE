'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ADMIN_PASSWORD = process.env.ADMIN_UPLOAD_PASSWORD || '';
const API_BASE = (process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '');
const MAX_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_BYTES || 2147483648));
const CHANNEL_USERNAME = (process.env.TELEGRAM_CHANNEL_USERNAME || '').replace(/^@/, '');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'telegram-videos.json');
const OFFSET_FILE = path.join(DATA_DIR, 'telegram-update-offset.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]\n', { mode: 0o600 });

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
// Never expose private upload temp files or Telegram metadata through static hosting.
app.use('/data', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(__dirname, { index: 'index.html', dotfiles: 'ignore' }));
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExt = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.avi', '.webm', '.mpeg', '.mpg', '.3gp', '.wmv']);
    if ((file.mimetype || '').startsWith('video/') || allowedExt.has(ext)) return cb(null, true);
    cb(new Error('Please select a video file (MP4, MOV, MKV, AVI, WebM, etc.).'));
  }
});
function readVideos() {
  try { const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return Array.isArray(data) ? data : []; }
  catch { return []; }
}
function writeVideos(videos) {
  const temp = DB_FILE + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(videos, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, DB_FILE);
}
function saveChannelPost(message) {
  if (!message || !message.chat || message.chat.type !== 'channel') return false;
  const chat = message.chat;
  const target = CHAT_ID.trim();
  const targetUsername = target.startsWith('@') ? target.slice(1).toLowerCase() : '';
  const targetId = /^-?\d+$/.test(target) ? target : '';
  if (targetUsername && String(chat.username || '').toLowerCase() !== targetUsername) return false;
  if (targetId && String(chat.id) !== targetId) return false;
  if (!targetUsername && !targetId) return false;
  const media = message.video || (message.document && /^video\//i.test(message.document.mime_type || '') ? message.document : null);
  if (!media) return false;
  const videos = readVideos();
  if (videos.some(v => String(v.chatId) === String(chat.id) && Number(v.messageId) === Number(message.message_id))) return false;
  const fileName = media.file_name || (message.video ? `Telegram video ${message.message_id}.mp4` : `Telegram video ${message.message_id}`);
  const messageUrl = chat.username ? `https://t.me/${chat.username}/${message.message_id}` : '';
  videos.unshift({
    id: crypto.randomUUID(), name: path.basename(fileName), size: Number(media.file_size || 0),
    uploadedAt: new Date(Number(message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    telegramFileId: media.file_id || '', chatId: String(chat.id), messageId: message.message_id, messageUrl
  });
  writeVideos(videos);
  console.log(`Synced Telegram channel video message ${message.message_id}`);
  return true;
}
function readUpdateOffset() {
  try { return Number(JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0); } catch { return 0; }
}
function writeUpdateOffset(offset) {
  const temp = OFFSET_FILE + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ offset }), { mode: 0o600 });
  fs.renameSync(temp, OFFSET_FILE);
}
async function startTelegramChannelSync() {
  if (!TOKEN || !CHAT_ID) return;
  let offset = readUpdateOffset();
  let backoff = 2000;
  console.log('Telegram channel auto-sync enabled for new channel posts.');
  while (true) {
    try {
      const response = await axios.get(`${API_BASE}/bot${TOKEN}/getUpdates`, {
        params: { offset, timeout: 25, allowed_updates: JSON.stringify(['channel_post', 'edited_channel_post']) },
        timeout: 30000
      });
      if (!response.data || !response.data.ok || !Array.isArray(response.data.result)) throw new Error('Telegram getUpdates request failed');
      for (const update of response.data.result) {
        if (update.channel_post) saveChannelPost(update.channel_post);
        if (update.edited_channel_post) saveChannelPost(update.edited_channel_post);
        offset = Math.max(offset, Number(update.update_id) + 1);
        writeUpdateOffset(offset);
      }
      backoff = 2000;
    } catch (err) {
      // Do not print the request URL: it contains the private bot token.
      const status = err && err.response && err.response.status;
      console.error(`Telegram auto-sync temporarily failed${status ? ` (HTTP ${status})` : ''}. Check bot admin rights, token, and whether another app is polling this bot.`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}
function safeError(err) {
  if (err && err.response && err.response.data && err.response.data.description) return String(err.response.data.description);
  return err && err.message ? String(err.message) : 'Request failed.';
}
function requireConfig() {
  if (!TOKEN || !CHAT_ID || !ADMIN_PASSWORD || ADMIN_PASSWORD === 'replace_with_a_long_random_password') {
    const err = new Error('Server is not configured. Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and a strong ADMIN_UPLOAD_PASSWORD in .env.');
    err.status = 503; throw err;
  }
}
function authorized(req) {
  const supplied = Buffer.from(String(req.get('x-admin-password') || ''));
  const expected = Buffer.from(ADMIN_PASSWORD);
  return supplied.length > 0 && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
app.get('/api/health', (_req, res) => res.json({ ok: true, telegramConfigured: Boolean(TOKEN && CHAT_ID), maxUploadBytes: MAX_BYTES }));
app.get('/api/telegram/videos', (_req, res) => {
  const videos = readVideos().map(({ id, name, size, uploadedAt, messageUrl }) => ({ id, name, size, uploadedAt, messageUrl }));
  res.set('Cache-Control', 'no-store'); res.json({ videos });
});
app.post('/api/telegram/upload', (req, res, next) => {
  try { requireConfig(); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  if (!authorized(req)) return res.status(401).json({ error: 'Invalid admin upload password.' });
  upload.single('video')(req, res, async (err) => {
    if (err) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `File exceeds server upload limit (${Math.round(MAX_BYTES / 1024 / 1024)} MB).` : err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No video file was received.' });
    try {
      const form = new FormData();
      form.append('chat_id', CHAT_ID);
      form.append('supports_streaming', 'true');
      form.append('video', fs.createReadStream(req.file.path), {
        filename: path.basename(req.file.originalname || 'video.mp4'),
        contentType: req.file.mimetype || 'application/octet-stream',
        knownLength: req.file.size
      });
      const response = await axios.post(`${API_BASE}/bot${TOKEN}/sendVideo`, form, {
        headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity,
        timeout: 0, validateStatus: status => status >= 200 && status < 300
      });
      if (!response.data || !response.data.ok || !response.data.result) throw new Error('Telegram did not confirm the upload.');
      const message = response.data.result;
      const video = message.video || message.document || {};
      const id = String(message.message_id);
      const messageUrl = CHANNEL_USERNAME ? `https://t.me/${CHANNEL_USERNAME}/${id}` : '';
      const record = {
        id: crypto.randomUUID(), name: path.basename(req.file.originalname || 'video'),
        size: req.file.size, uploadedAt: new Date().toISOString(),
        telegramFileId: video.file_id || '', chatId: String(message.chat && message.chat.id || CHAT_ID),
        messageId: message.message_id, messageUrl
      };
      const videos = readVideos(); videos.unshift(record); writeVideos(videos);
      res.status(201).json({ ok: true, video: { id: record.id, name: record.name, size: record.size, uploadedAt: record.uploadedAt, messageUrl } });
    } catch (e) {
      const description = safeError(e);
      const isTooLarge = /too big|file is too large|request entity too large/i.test(description);
      res.status(isTooLarge ? 413 : 502).json({ error: isTooLarge ? `${description}. Telegram cloud Bot API has upload limits; use a self-hosted Local Bot API server for larger videos.` : `Telegram upload failed: ${description}` });
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  });
});
app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  res.status(500).json({ error: 'Unexpected server error.' });
});
app.listen(PORT, () => {
  console.log(`Public Drive + Telegram Video Library running at http://localhost:${PORT}`);
  if (!TOKEN || !CHAT_ID || !ADMIN_PASSWORD) console.warn('Telegram is not configured yet. Copy .env.example to .env and fill in the required values.');
  else startTelegramChannelSync().catch(() => console.error('Telegram channel auto-sync stopped unexpectedly.'));
});
