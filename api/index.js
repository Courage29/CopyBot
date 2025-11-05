// api/index.js
import { sql } from "@vercel/postgres";
import { Telegraf } from "telegraf";
import express from "express";
import crypto from "crypto";
import cors from "cors";

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const LEADER_USERNAME = "BasedPing_bot";

if (!BOT_TOKEN || !APP_SECRET) {
  console.error("Missing BOT_TOKEN or APP_SECRET");
  throw new Error("BOT_TOKEN and APP_SECRET must be set in Vercel Env");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Middleware
app.use(express.json());
app.use(cors({ origin: "*" }));

// Rate limiting
const rateLimits = {};
function rateLimit(req, res, next) {
  const userId = req.query.userId || req.body.userId;
  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }

  const now = Date.now();
  const window = 60_000;

  if (!rateLimits[userId]) {
    rateLimits[userId] = { count: 0, reset: now + window };
  }

  if (now > rateLimits[userId].reset) {
    rateLimits[userId] = { count: 0, reset: now + window };
  }

  if (rateLimits[userId].count >= 10) {
    return res
      .status(429)
      .json({ error: "Rate limit exceeded. Try again later." });
  }

  rateLimits[userId].count++;
  next();
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Trade Copier Bot API is running",
    endpoints: {
      signals: "/api/signals?userId=YOUR_ID",
      subscription: "/api/subscription?userId=YOUR_ID",
      risk: "/api/risk?userId=YOUR_ID",
      webhook: "/webhook",
    },
  });
});

app.get("/api", (req, res) => {
  res.json({
    status: "ok",
    message: "API endpoint working",
  });
});

// === BOT COMMANDS ===
bot.command("subscribe", async (ctx) => {
  try {
    const ref = ctx.message.text.match(/ref=([A-Z]+)/)?.[1];
    if (ref !== "GODSEYE") {
      return ctx.reply(
        "Invalid referral code. Please use: /subscribe ref=GODSEYE"
      );
    }

    const userId = ctx.from.id.toString();

    await sql`
      INSERT INTO subs (user_id, risk, ref) 
      VALUES (${userId}, 0.5, ${ref})
      ON CONFLICT (user_id) 
      DO UPDATE SET risk = 0.5, ref = ${ref}
    `;

    ctx.reply(
      `✅ Successfully subscribed!\n\n` +
        `Your default risk multiplier is 0.5x\n` +
        `Use /risk <value> to adjust (0.1 to 2.0)\n\n` +
        `Example: /risk 1.0`
    );
  } catch (e) {
    console.error("Subscribe error:", e);
    ctx.reply("❌ Error subscribing. Please try again.");
  }
});

bot.command("unsubscribe", async (ctx) => {
  try {
    const userId = ctx.from.id.toString();

    await sql`DELETE FROM signals WHERE user_id = ${userId}`;
    const { rowCount } = await sql`DELETE FROM subs WHERE user_id = ${userId}`;

    ctx.reply(
      rowCount > 0
        ? "✅ Successfully unsubscribed. All your signals have been deleted."
        : "❌ You are not subscribed."
    );
  } catch (e) {
    console.error("Unsubscribe error:", e);
    ctx.reply("❌ Error unsubscribing. Please try again.");
  }
});

bot.command("risk", async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const riskText = ctx.message.text.split(" ")[1];

    if (!riskText) {
      return ctx.reply(
        "Please specify a risk value.\n\n" +
          "Usage: /risk <value>\n" +
          "Example: /risk 1.0\n\n" +
          "Valid range: 0.1 to 2.0"
      );
    }

    const risk = parseFloat(riskText);

    if (isNaN(risk) || risk < 0.1 || risk > 2) {
      return ctx.reply(
        "❌ Invalid risk value.\n\n" +
          "Risk must be between 0.1 and 2.0\n" +
          "Examples:\n" +
          "• /risk 0.5 (conservative)\n" +
          "• /risk 1.0 (standard)\n" +
          "• /risk 2.0 (aggressive)"
      );
    }

    const { rowCount } = await sql`
      UPDATE subs 
      SET risk = ${risk} 
      WHERE user_id = ${userId}
    `;

    ctx.reply(
      rowCount > 0
        ? `✅ Risk multiplier updated to ${risk}x`
        : "❌ Please subscribe first using: /subscribe ref=GODSEYE"
    );
  } catch (e) {
    console.error("Risk update error:", e);
    ctx.reply("❌ Error updating risk. Please try again.");
  }
});

bot.command("status", async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const { rows } = await sql`
      SELECT risk, ref, created_at 
      FROM subs 
      WHERE user_id = ${userId}
    `;

    if (rows.length === 0) {
      return ctx.reply(
        "❌ You are not subscribed.\n\n" +
          "To subscribe, use: /subscribe ref=GODSEYE"
      );
    }

    const { risk, ref, created_at } = rows[0];
    const signalCount = await sql`
      SELECT COUNT(*) as count 
      FROM signals 
      WHERE user_id = ${userId}
    `;

    ctx.reply(
      `📊 Your Status:\n\n` +
        `✅ Subscribed: Yes\n` +
        `🎯 Risk Multiplier: ${risk}x\n` +
        `🔑 Referral: ${ref}\n` +
        `📈 Active Signals: ${signalCount.rows[0].count}\n` +
        `📅 Subscribed Since: ${new Date(created_at).toLocaleDateString()}`
    );
  } catch (e) {
    console.error("Status error:", e);
    ctx.reply("❌ Error fetching status. Please try again.");
  }
});

bot.command("help", (ctx) => {
  ctx.reply(
    `🤖 Trade Copier Bot Commands:\n\n` +
      `/subscribe ref=GODSEYE - Subscribe to signals\n` +
      `/unsubscribe - Unsubscribe from signals\n` +
      `/risk <value> - Set risk multiplier (0.1-2.0)\n` +
      `/status - Check your subscription status\n` +
      `/help - Show this help message\n\n` +
      `For support, contact the admin.`
  );
});

// === SIGNAL INTAKE ===
bot.on("text", async (ctx) => {
  try {
    // Only process messages from the leader bot containing trade alerts
    if (
      !ctx.message.text.includes("New Trade Alert!") ||
      ctx.from.username !== LEADER_USERNAME
    ) {
      return;
    }

    console.log("Received signal from leader bot");

    // Extract signal JSON from message
    const match = ctx.message.text.match(
      /SIGNAL: ({[\s\S]*?})(?:<\/tg-spoiler>|$)/
    );

    if (!match) {
      console.log("No signal pattern found in message");
      return;
    }

    let signal;
    try {
      signal = JSON.parse(match[1]);
    } catch (parseError) {
      console.error("Failed to parse signal JSON:", parseError);
      return;
    }

    // Verify signal signature
    if (!verifySignal(signal)) {
      console.log("Invalid signal signature");
      return;
    }

    const signalId = crypto.randomUUID();

    // Get all subscribed users
    const { rows } = await sql`
      SELECT user_id, risk 
      FROM subs 
      WHERE ref = 'GODSEYE'
    `;

    console.log(`Broadcasting to ${rows.length} subscribers`);

    // Insert signal for each subscriber
    for (const { user_id, risk } of rows) {
      try {
        const adjustedSignal = {
          ...signal,
          id: signalId,
          originalSize: signal.size,
          adjustedSize: signal.size * risk,
          userRisk: risk,
        };

        await sql`
          INSERT INTO signals (id, user_id, signal) 
          VALUES (${signalId}, ${user_id}, ${JSON.stringify(
          adjustedSignal
        )}::jsonb)
          ON CONFLICT (id, user_id) DO NOTHING
        `;
      } catch (insertError) {
        console.error(
          `Error inserting signal for user ${user_id}:`,
          insertError
        );
      }
    }

    console.log(`Signal ${signalId} broadcast complete`);
  } catch (e) {
    console.error("Signal processing error:", e);
  }
});

function verifySignal(signal) {
  try {
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
  } catch (e) {
    console.error("Signature verification error:", e);
    return false;
  }
}

// === API ROUTES ===
app.get("/api/signals", rateLimit, async (req, res) => {
  try {
    const { userId } = req.query;

    const { rows } = await sql`
      SELECT signal 
      FROM signals 
      WHERE user_id = ${userId} 
      ORDER BY created_at DESC 
      LIMIT 10
    `;

    res.json({
      success: true,
      count: rows.length,
      signals: rows.map((r) => r.signal),
    });
  } catch (e) {
    console.error("Get signals error:", e);
    res.status(500).json({
      error: "Failed to fetch signals",
      details: e.message,
    });
  }
});

app.delete("/api/signals/:id", rateLimit, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const { rowCount } = await sql`
      DELETE FROM signals 
      WHERE id = ${id} AND user_id = ${userId}
    `;

    res.json(
      rowCount > 0
        ? { success: true, message: "Signal deleted" }
        : { success: false, error: "Signal not found" }
    );
  } catch (e) {
    console.error("Delete signal error:", e);
    res.status(500).json({
      error: "Failed to delete signal",
      details: e.message,
    });
  }
});

app.get("/api/risk", rateLimit, async (req, res) => {
  try {
    const { userId } = req.query;

    const { rows } = await sql`
      SELECT risk 
      FROM subs 
      WHERE user_id = ${userId}
    `;

    res.json(
      rows[0]
        ? { success: true, risk: rows[0].risk }
        : { success: false, error: "Not subscribed" }
    );
  } catch (e) {
    console.error("Get risk error:", e);
    res.status(500).json({
      error: "Failed to fetch risk",
      details: e.message,
    });
  }
});

app.get("/api/subscription", rateLimit, async (req, res) => {
  try {
    const { userId } = req.query;

    const { rows } = await sql`
      SELECT risk, ref, created_at 
      FROM subs 
      WHERE user_id = ${userId}
    `;

    res.json({
      success: true,
      subscribed: rows.length > 0,
      risk: rows[0]?.risk || null,
      ref: rows[0]?.ref || null,
      subscribedSince: rows[0]?.created_at || null,
    });
  } catch (e) {
    console.error("Get subscription error:", e);
    res.status(500).json({
      error: "Failed to fetch subscription",
      details: e.message,
    });
  }
});

// Webhook endpoint for Telegram
app.use("/webhook", bot.webhookCallback("/webhook"));

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    error: "Not found",
    path: req.path,
    message: "The requested endpoint does not exist",
  });
});

// Export for Vercel serverless function
export default app;
