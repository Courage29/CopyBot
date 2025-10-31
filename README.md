# Trade Copier Bot

A Telegram bot that copies trading signals from a leader to multiple followers with customizable risk multipliers. Built for Vercel deployment with PostgreSQL storage.

## Overview

This bot monitors a Telegram channel/group for trading signals from a leader account and automatically distributes them to subscribed followers. Each follower can set their own risk multiplier to adjust position sizes.

## Features

- **Automated Signal Distribution**: Captures signals from leader and broadcasts to all subscribers
- **Risk Management**: Individual risk multipliers (0.1x - 2.0x) per subscriber
- **Secure Verification**: HMAC-SHA256 signature validation for signals
- **RESTful API**: Endpoints for follower apps to fetch and manage signals
- **Rate Limiting**: Basic protection against API abuse (10 req/min per user)
- **Referral System**: Subscribe with verification code (GODSEYE)

## Architecture

```
Telegram Leader → Bot (Webhooks) → PostgreSQL → API → Follower Apps
```

### Database Schema

**subs table** (subscribers):
- `user_id` (TEXT, PRIMARY KEY): Telegram user ID
- `risk` (REAL): Risk multiplier (0.1 - 2.0)
- `ref` (TEXT): Referral code

**signals table** (pending trades):
- `id` (TEXT, PRIMARY KEY): UUID
- `user_id` (TEXT): Foreign key to subs
- `signal` (JSONB): Signal data (symbol, side, size, price, leverage, signature)
- `created_at` (TIMESTAMP): Auto-generated

## Prerequisites

- Node.js 18+
- Vercel account
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Vercel Postgres database

## Environment Variables

Set these in your Vercel project settings:

```env
BOT_TOKEN=your_telegram_bot_token
APP_SECRET=your_secret_for_signature_verification
POSTGRES_URL=your_vercel_postgres_url
```

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd trade-copier-bot
```

2. Install dependencies:
```bash
npm install
```

3. Set up Vercel Postgres:
   - Create a Vercel project
   - Add Postgres storage in Vercel dashboard
   - Run migrations to create tables

4. Deploy to Vercel:
```bash
vercel --prod
```

5. Set up Telegram webhook:
```bash
curl https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-vercel-url>/webhook
```

## Database Setup

Run these SQL commands in your Vercel Postgres console:

```sql
CREATE TABLE subs (
  user_id TEXT PRIMARY KEY,
  risk REAL DEFAULT 0.5,
  ref TEXT
);

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES subs(user_id),
  signal JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_signals_user ON signals(user_id);
CREATE INDEX idx_signals_created ON signals(created_at DESC);
```

## Bot Commands

### For Followers

- `/subscribe?ref=GODSEYE` - Subscribe to signals with referral code
- `/unsubscribe` - Remove subscription and clear all signals
- `/risk <value>` - Set risk multiplier (e.g., `/risk 0.5` for half size)
  - Valid range: 0.1 - 2.0
  - Example: `/risk 1.5` for 1.5x position size

## API Endpoints

All endpoints require `userId` query parameter.

### GET `/api/signals?userId=<telegram_id>`
Fetch pending signals for user (max 10 recent).

**Response:**
```json
[
  {
    "id": "uuid",
    "symbol": "BTCUSDT",
    "side": "LONG",
    "size": 0.1,
    "price": 50000,
    "leverage": 10,
    "signature": "hash"
  }
]
```

### DELETE `/api/signals/:id?userId=<telegram_id>`
Delete a signal after copying.

**Response:**
```json
{ "success": true }
```

### GET `/api/risk?userId=<telegram_id>`
Fetch user's risk multiplier.

**Response:**
```json
{ "risk": 0.5 }
```

### GET `/api/subscription?userId=<telegram_id>`
Check subscription status.

**Response:**
```json
{
  "subscribed": true,
  "risk": 0.5
}
```

## Signal Format

Signals must be posted by the leader account (`BasedPing_bot`) in this format:

```
New Trade Alert!
<tg-spoiler>SIGNAL: {"symbol":"BTCUSDT","side":"LONG","size":0.1,"price":50000,"leverage":10,"signature":"..."}</tg-spoiler>
```

The signature is generated using HMAC-SHA256:
```javascript
const data = JSON.stringify({symbol, side, size, price, leverage});
const signature = crypto.createHmac('sha256', APP_SECRET).update(data).digest('hex');
```

## Security Features

- **Parameterized SQL queries**: Protection against SQL injection
- **Rate limiting**: 10 requests per minute per user
- **HMAC signature verification**: Ensures signals come from legitimate leader
- **CORS enabled**: Adjust origin whitelist for production
- **Environment secrets**: Sensitive data stored in Vercel environment

## Rate Limiting

In-memory rate limiter (basic):
- 10 requests per minute per user
- Returns 429 status when exceeded
- Consider Redis for production scaling

## Development

```bash
# Install dependencies
npm install

# Run locally (requires ngrok for webhook)
npm start

# Deploy to Vercel
vercel --prod
```

## Configuration

Edit constants in `index.js`:

```javascript
const LEADER_USERNAME = "BasedPing_bot";  // Leader's bot username
const APP_SECRET = process.env.APP_SECRET; // Signature secret
```

## Troubleshooting

**Bot not receiving messages:**
- Verify webhook is set: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Check bot is added to the channel/group where leader posts
- Ensure bot has permission to read messages

**Signals not distributing:**
- Verify leader username matches exactly (no @ symbol)
- Check signal format includes `New Trade Alert!` text
- Confirm signature verification passes (check logs)

**Database errors:**
- Verify Postgres connection string in Vercel env vars
- Check tables exist with correct schema
- Review indexes for performance

## Production Considerations

1. **Rate Limiting**: Implement Redis-based rate limiting for multi-instance scaling
2. **CORS**: Restrict origins to your frontend domain
3. **Monitoring**: Add error tracking (Sentry, Datadog)
4. **Logging**: Implement structured logging
5. **Webhooks**: Set up webhook secret verification
6. **Database**: Add connection pooling, optimize indexes
7. **Caching**: Cache subscription status in Redis/KV

## License

MIT

## Support

For issues or questions, contact [your-contact-info]
