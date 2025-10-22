const { Telegraf } = require('telegraf');
const express = require('express');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;  // From Vercel env
const LEADER_USERNAME = 'BasedPing_bot';  // Replace with your @handle (no @)
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// Subscribers: {userId: {risk: number, ref: string}}
let subscribers = {};

// Subscribe command with ref check
bot.command('subscribe', (ctx) => {
  const messageText = ctx.message.text;
  const refMatch = messageText.match(/ref=([A-Z]+)/);  // e.g., /subscribe?ref=GODSEYE
  const ref = refMatch ? refMatch[1] : null;
  if (ref !== 'GODSEYE') {  // Your referral code
    ctx.reply('Invalid referral. Join via leader link.');
    return;
  }
  const userId = ctx.from.id;
  subscribers[userId] = { userId, risk: 0.5, ref };
  ctx.reply(`Subscribed with ref ${ref}! Set risk with /risk 0.5.`);
});

// Unsubscribe
bot.command('unsubscribe', (ctx) => {
  const userId = ctx.from.id;
  delete subscribers[userId];
  ctx.reply('Unsubscribed.');
});

// Risk set
bot.command('risk', (ctx) => {
  const userId = ctx.from.id;
  const parts = ctx.message.text.split(' ');
  const risk = parseFloat(parts[1]) || 0.5;
  if (subscribers[userId]) {
    subscribers[userId].risk = Math.min(Math.max(risk, 0.1), 2);
    ctx.reply(`Risk set to ${subscribers[userId].risk}x.`);
  } else {
    ctx.reply('Subscribe first with /subscribe?ref=GODSEYE.');
  }
});

// Parse group messages for signals (only from leader)
bot.on('text', async (ctx) => {
  if (ctx.message.text.includes('New Trade Alert!') && ctx.from.username === LEADER_USERNAME) {
    const jsonMatch = ctx.message.text.match(/<!-- SIGNAL: ({.*}) -->/);
    if (jsonMatch) {
      let signal;
      try {
        signal = JSON.parse(jsonMatch[1]);
      } catch (e) {
        return;  // Invalid JSON
      }
      if (verifySignal(signal)) {  // Check signature
        const signalId = crypto.randomUUID();
        // Notify subscribers (DM signal for auto-copy)
        Object.values(subscribers).forEach(sub => {
          bot.telegram.sendMessage(sub.userId, `Auto-Signal: ${JSON.stringify(signal)}`);  // App polls this
        });
        console.log(`Signal broadcast to ${Object.keys(subscribers).length} subscribers:`, signal);
      }
    }
  }
});

function verifySignal(signal) {
  return signal.signature === 'GODSEYE-HASH-ABC123';  // Match leader's hash
}

// Vercel API endpoint for app polling (follower fetches pending signals)
app.get('/api/signals', (req, res) => {
  const userId = req.query.userId;
  // Simulate pending (in real, store in DB like Redis; here, dummy for test)
  const dummySignal = subscribers[userId] ? {
    id: 'test-signal',
    symbol: 'USTC',
    side: 'BUY',
    size: 3022,
    price: 0.008275,
    signature: 'GODSEYE-HASH-ABC123'
  } : null;
  res.json(dummySignal ? [dummySignal] : []);
});

app.delete('/api/signals/:id', (req, res) => {
  const id = req.params.id;
  // Dummy delete
  res.json({ success: true });
});

// Webhook for Telegram (Vercel URL + /webhook)
app.use(bot.webhookCallback('/webhook'));

// Vercel default export (fixes 500)
module.exports = app;