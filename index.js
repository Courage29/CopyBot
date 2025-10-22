const { Telegraf } = require('telegraf');
const express = require('express');
const crypto = require('crypto');  // For signing

const BOT_TOKEN = 'YOUR_BOT_TOKEN';  // From BotFather
const LEADER_USERNAME = 'your_username';  // Your Telegram @handle
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

let subscribers = [];  // {userId: number, risk: number}
let pendingSignals = [];  // {id: string, data: object, subscribers: [userId]}

bot.launch();

// Subscribe command
bot.command('subscribe', (ctx) => {
  const userId = ctx.from.id;
  subscribers[userId] = { userId, risk: 0.5 };  // Default risk
  ctx.reply('Subscribed! Set risk with /risk 0.5. Auto-copy starts in app.');
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
  const risk = parseFloat(ctx.message.text.split(' ')[1]) || 0.5;
  if (subscribers[userId]) subscribers[userId].risk = Math.min(Math.max(risk, 0.1), 2);
  ctx.reply(`Risk set to ${subscribers[userId]?.risk || 0.5}x.`);
});

// Parse group messages for signals
bot.on('text', async (ctx) => {
  if (ctx.message.text.includes('New Trade Alert!') && ctx.from.username === LEADER_USERNAME) {
    const jsonMatch = ctx.message.text.match(/<!-- SIGNAL: ({.*}) -->/);
    if (jsonMatch) {
      const signal = JSON.parse(jsonMatch[1]);
      if (verifySignal(signal)) {  // Check signature
        const signalId = crypto.randomUUID();
        pendingSignals.push({ id: signalId, data: signal, subscribers: Object.keys(subscribers) });
        // DM subscribers
        subscribers.forEach(sub => bot.telegram.sendMessage(sub.userId, `Signal: ${JSON.stringify(signal)}`));
      }
    }
  }
});

function verifySignal(signal) {
  return signal.signature === 'GODSEYE-HASH-ABC123';
}

// API endpoint for app polling (Vercel /api/signals)
app.get('/api/signals', (req, res) => {
  const userId = req.query.userId;
  const userSignals = pendingSignals.filter(s => s.subscribers.includes(userId)).map(s => s.data);
  res.json(userSignals);
});

app.delete('/api/signals/:id', (req, res) => {
  const id = req.params.id;
  pendingSignals = pendingSignals.filter(s => s.id !== id);
  res.json({ success: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot API on port ${port}`));

module.exports = bot;  // For Vercel