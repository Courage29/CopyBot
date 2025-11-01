// index.js
import { sql } from "@vercel/postgres";
import { Telegraf } from "telegraf";
import express from "express";
import crypto from "crypto";
import cors from "cors";

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_SECRET = process.env.APP_SECRET; // MUST BE SET IN VERCEL
const LEADER_USERNAME = "BasedPing_bot";

if (!BOT_TOKEN || !APP_SECRET) {
  throw new Error("BOT_TOKEN and APP_SECRET must be set in Vercel Env");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

// Rate limiting
const rateLimits = {};
function rateLimit(req, res, next) {
  const userId = req.query.userId || req.body.userId;
  const now = Date.now();
  const window = 60_000;
  if (!rateLimits[userId])
    rateLimits[userId] = { count: 0, reset: now + window };
  if (now > rateLimits[userId].reset)
    rateLimits[userId] = { count: 0, reset: now + window };
  if (rateLimits[userId].count >= 10)
    return res.status(429).json({ error: "Rate limit" });
  rateLimits[userId].count++;
  next();
}

// === COMMANDS ===
bot.command("subscribe", async (ctx) => {
  const ref = ctx.message.text.match(/ref=([A-Z]+)/)?.[1];
  if (ref !== "GODSEYE") return ctx.reply("Invalid referral.");
  const userId = ctx.from.id.toString();
  try {
    await sql`INSERT INTO subs (user_id, risk, ref) VALUES (${userId}, 0.5, ${ref})
              ON CONFLICT (user_id) DO UPDATE SET risk = 0.5, ref = ${ref}`;
    ctx.reply(`Subscribed! Use /risk 0.5 to adjust.`);
  } catch (e) {
    ctx.reply("Error.");
  }
});

bot.command("unsubscribe", async (ctx) => {
  const userId = ctx.from.id.toString();
  await sql`DELETE FROM signals WHERE user_id = ${userId}`;
  const { rowCount } = await sql`DELETE FROM subs WHERE user_id = ${userId}`;
  ctx.reply(rowCount > 0 ? "Unsubscribed." : "Not subscribed.");
});

bot.command("risk", async (ctx) => {
  const userId = ctx.from.id.toString();
  const risk = parseFloat(ctx.message.text.split(" ")[1]);
  if (isNaN(risk) || risk < 0.1 || risk > 2) return ctx.reply("Risk 0.1–2.0");
  const { rowCount } =
    await sql`UPDATE subs SET risk = ${risk} WHERE user_id = ${userId}`;
  ctx.reply(rowCount > 0 ? `Risk: ${risk}x` : "Subscribe first.");
});

// === SIGNAL INTAKE ===
bot.on("text", async (ctx) => {
  if (
    !ctx.message.text.includes("New Trade Alert!") ||
    ctx.from.username !== LEADER_USERNAME
  )
    return;

  const match = ctx.message.text.match(
    /SIGNAL: ({[\s\S]*?})(?:<\/tg-spoiler>|$)/
  );
  if (!match) return;

  let signal;
  try {
    signal = JSON.parse(match[1]);
  } catch {
    return;
  }

  if (!verifySignal(signal)) return console.log("Invalid sig");

  const signalId = crypto.randomUUID();
  const { rows } = await sql`SELECT user_id FROM subs WHERE ref = 'GODSEYE'`;

  for (const { user_id } of rows) {
    await sql`INSERT INTO signals (id, user_id, signal) 
              VALUES (${signalId}, ${user_id}, ${JSON.stringify({
      ...signal,
      id: signalId,
    })}::jsonb)
              ON CONFLICT (id, user_id) DO NOTHING`;
  }
  console.log(`Broadcast to ${rows.length} users`);
});

function verifySignal(signal) {
  const data = JSON.stringify({
    symbol: signal.symbol,
    side: signal.side,
    size: signal.size,
    price: signal.price,
    leverage: signal.leverage,
  });
  const hash = crypto
    .createHmac("sha256", APP_SECRET)
    .update(data)
    .digest("hex");
  return hash === signal.signature;
}

// === API ===
app.get("/api/signals", rateLimit, async (req, res) => {
  const { userId } = req.query;
  const { rows } =
    await sql`SELECT signal FROM signals WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 10`;
  res.json(rows.map((r) => r.signal));
});

app.delete("/api/signals/:id", rateLimit, async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;
  const { rowCount } =
    await sql`DELETE FROM signals WHERE id = ${id} AND user_id = ${userId}`;
  res.json(rowCount > 0 ? { success: true } : { error: "Not found" });
});

app.get("/api/risk", rateLimit, async (req, res) => {
  const { rows } =
    await sql`SELECT risk FROM subs WHERE user_id = ${req.query.userId}`;
  res.json(rows[0] ? { risk: rows[0].risk } : { error: "Not subbed" });
});

app.get("/api/subscription", rateLimit, async (req, res) => {
  const { rows } =
    await sql`SELECT risk FROM subs WHERE user_id = ${req.query.userId}`;
  res.json({ subscribed: rows.length > 0, risk: rows[0]?.risk });
});

app.use(bot.webhookCallback("/webhook"));
export default app;
