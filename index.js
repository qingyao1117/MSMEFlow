const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const API_URL = 'http://127.0.0.1:8000/api/ingest/whatsapp';
const client = new Client({ authStrategy: new LocalAuth({ clientId: 'msmeflow-bridge' }), puppeteer: { headless: true } });

client.on('qr', qr => { console.log('Scan this QR code in WhatsApp > Linked devices:'); qrcode.generate(qr, { small: true }); });
client.on('ready', () => console.log('MSMEFlow WhatsApp bridge is ready.'));
client.on('auth_failure', message => console.error('WhatsApp authentication failed:', message));
client.on('disconnected', reason => console.warn('WhatsApp disconnected:', reason));
client.on('message', async msg => {
  if (msg.fromMe || !msg.body.trim()) return;
  try { await axios.post(API_URL, { sender: msg.from, raw_text: msg.body }); console.log(`Ingested message from ${msg.from}`); }
  catch (error) { console.error('Could not forward message:', error.message); }
});
client.initialize();
