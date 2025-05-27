const axios = require('axios');
require('dotenv').config();

// Telegram Bot config di .env
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // gunakan chat_id channel Anda

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('WARNING: TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belum diset. Reporting Telegram dinonaktifkan.');
}

/**
 * Kirim laporan ke Telegram
 * @param {string} message - teks laporan (bisa Markdown)
 */
async function sendReport(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
    });
    console.log('Report terkirim ke Telegram');
  } catch (err) {
    console.error('Gagal kirim laporan ke Telegram:', err.response?.data || err.message);
  }
}

module.exports = { sendReport };
