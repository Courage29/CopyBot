// api/index.js - Vercel Compatible Version
import { PrismaClient } from "@prisma/client";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import * as dotenv from "dotenv";
import rateLimit from "express-rate-limit";

dotenv.config();

const prisma = new PrismaClient();
const app = express();

if (!process.env.FRONTEND_URL) {
  console.error("Error: FRONTEND_URL environment variable is not set.");
  process.exit(1);
}

if (!process.env.APP_SECRET) {
  console.error("Error: APP_SECRET environment variable is not set.");
  process.exit(1);
}

app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, error: "Too many requests, please try again later." },
});
app.use(limiter);

const APP_SECRET = process.env.APP_SECRET;

// Register Leader
app.post("/api/register-leader", async (req, res) => {
  const { userId, botToken, chatId, referralCode } = req.body;
  if (!userId || !botToken || !chatId || !referralCode) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  try {
    const leader = await prisma.leaders.upsert({
      where: { user_id: userId },
      update: {
        bot_token: botToken,
        chat_id: chatId,
        referral_code: referralCode,
      },
      create: {
        user_id: userId,
        bot_token: botToken,
        chat_id: chatId,
        referral_code: referralCode,
      },
    });
    res.json({ ok: true, data: { referralCode: leader.referral_code } });
  } catch (err) {
    if (err.code === "P2002") {
      return res
        .status(400)
        .json({ ok: false, error: "Referral code or user ID already in use" });
    }
    console.error("Register error:", err);
    res.status(500).json({ ok: false, error: "Failed to register leader" });
  }
});

// Share Trade
app.post("/api/share-trade", async (req, res) => {
  const { userId, trade } = req.body;
  if (!userId || !trade?.symbol || !trade.type) {
    return res.status(400).json({ ok: false, error: "Invalid trade" });
  }

  try {
    const leader = await prisma.leaders.findUnique({
      where: { user_id: userId },
    });
    if (!leader)
      return res.status(404).json({ ok: false, error: "Leader not found" });

    const signal = {
      ...trade,
      id: crypto.randomUUID(),
      signature: generateSignature(trade),
    };
    const message = formatTelegramMessage(signal, userId, leader.referral_code);

    // Send to Telegram with exponential backoff
    const maxRetries = 3;
    let attempt = 0;
    let success = false;
    let tgData;

    while (attempt < maxRetries && !success) {
      const tgRes = await fetch(
        `https://api.telegram.org/bot${leader.bot_token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: leader.chat_id,
            text: message,
            parse_mode: "HTML",
          }),
        }
      );

      if (tgRes.status === 429) {
        const retryAfter =
          parseInt(tgRes.headers.get("Retry-After") || "1", 10) * 1000;
        await new Promise((resolve) =>
          setTimeout(resolve, retryAfter * Math.pow(2, attempt))
        );
        attempt++;
        continue;
      }

      if (!tgRes.ok) {
        throw new Error(`HTTP ${tgRes.status}: ${await tgRes.text()}`);
      }

      tgData = await tgRes.json();
      if (!tgData.ok)
        throw new Error(tgData.description || "Telegram API error");
      success = true;
    }

    if (!success) {
      throw new Error("Failed to send to Telegram after retries");
    }

    // Store signal
    await prisma.signals.create({
      data: { leader_user_id: userId, signal },
    });

    res.json({ ok: true, data: { signalId: signal.id } });
  } catch (err) {
    console.error("Share error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get Signals
app.get("/api/signals", async (req, res) => {
  const { followerUserId, page = 1, limit = 10 } = req.query;
  if (!followerUserId) {
    return res
      .status(400)
      .json({ ok: false, error: "followerUserId required" });
  }

  try {
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const signals = await prisma.signals.findMany({
      where: {
        leader_user_id: {
          in: (
            await prisma.followers.findMany({
              where: { follower_user_id: followerUserId },
            })
          ).map((r) => r.leader_user_id),
        },
      },
      orderBy: { created_at: "desc" },
      skip,
      take: parseInt(limit),
      select: { id: true, signal: true },
    });
    res.json({
      ok: true,
      data: signals.map((s) => ({ ...s.signal, id: s.id })),
    });
  } catch (err) {
    console.error("Fetch signals error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch signals" });
  }
});

// Optimized Signals Query
app.get("/api/signals/optimized", async (req, res) => {
  const { followerUserId, page = 1, limit = 10 } = req.query;
  if (!followerUserId) {
    return res
      .status(400)
      .json({ ok: false, error: "followerUserId required" });
  }

  try {
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const signals = await prisma.signals.findMany({
      where: {
        leader_user_id: {
          in: (
            await prisma.followers.findMany({
              where: { follower_user_id: followerUserId },
            })
          ).map((r) => r.leader_user_id),
        },
      },
      orderBy: { created_at: "desc" },
      skip,
      take: parseInt(limit),
      select: { id: true, signal: true },
    });
    res.json({
      ok: true,
      data: signals.map((s) => ({ ...s.signal, id: s.id })),
    });
  } catch (err) {
    console.error("Fetch optimized signals error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch signals" });
  }
});

// Delete Signal
app.delete("/api/signals/:id", async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId required" });
  }

  try {
    const signal = await prisma.signals.findUnique({ where: { id } });
    if (
      !signal ||
      !(await prisma.followers.findFirst({
        where: {
          follower_user_id: userId,
          leader_user_id: signal.leader_user_id,
        },
      }))
    ) {
      return res
        .status(403)
        .json({ ok: false, error: "Unauthorized to delete this signal" });
    }
    await prisma.signals.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete signal error:", err);
    res.status(500).json({ ok: false, error: "Failed to delete signal" });
  }
});

// Subscribe
app.post("/api/subscribe", async (req, res) => {
  const { leaderReferral, followerUserId, risk = 0.5 } = req.body;
  if (!leaderReferral || !followerUserId || risk < 0.1 || risk > 2) {
    return res.status(400).json({ ok: false, error: "Invalid request" });
  }

  try {
    const leader = await prisma.leaders.findUnique({
      where: { referral_code: leaderReferral },
    });
    if (!leader)
      return res.status(404).json({ ok: false, error: "Leader not found" });

    await prisma.followers.upsert({
      where: {
        leader_user_id_follower_user_id: {
          leader_user_id: leader.user_id,
          follower_user_id: followerUserId,
        },
      },
      update: { risk },
      create: {
        leader_user_id: leader.user_id,
        follower_user_id: followerUserId,
        risk,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "P2002") {
      return res
        .status(400)
        .json({ ok: false, error: "Already subscribed to this leader" });
    }
    console.error("Subscribe error:", err);
    res.status(500).json({ ok: false, error: "Failed to subscribe" });
  }
});

// Check Subscription
app.get("/api/subscription", async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ ok: false, error: "userId required" });
  }

  try {
    const subscription = await prisma.followers.findFirst({
      where: { follower_user_id: userId },
    });
    if (subscription) {
      res.json({
        ok: true,
        data: { subscribed: true, risk: subscription.risk },
      });
    } else {
      res.json({ ok: true, data: { subscribed: false } });
    }
  } catch (err) {
    console.error("Check subscription error:", err);
    res.status(500).json({ ok: false, error: "Failed to check subscription" });
  }
});

// Get Risk
app.get("/api/risk", async (req, res) => {
  const { userId, leaderReferral } = req.query;
  if (!userId || !leaderReferral) {
    return res
      .status(400)
      .json({ ok: false, error: "userId and leaderReferral required" });
  }

  try {
    const leader = await prisma.leaders.findUnique({
      where: { referral_code: leaderReferral },
    });
    if (!leader)
      return res.status(404).json({ ok: false, error: "Leader not found" });
    const follower = await prisma.followers.findFirst({
      where: { leader_user_id: leader.user_id, follower_user_id: userId },
    });
    if (!follower)
      return res
        .status(404)
        .json({ ok: false, error: "Subscription not found" });
    res.json({ ok: true, data: { risk: follower.risk } });
  } catch (err) {
    console.error("Fetch risk error:", err);
    res.status(500).json({ ok: false, error: "Failed to fetch risk" });
  }
});

// Update Risk
app.post("/api/risk", async (req, res) => {
  const { leaderReferral, followerUserId, risk } = req.body;
  if (!leaderReferral || !followerUserId || risk < 0.1 || risk > 2) {
    return res.status(400).json({ ok: false, error: "Invalid request" });
  }

  try {
    const leader = await prisma.leaders.findUnique({
      where: { referral_code: leaderReferral },
    });
    if (!leader)
      return res.status(404).json({ ok: false, error: "Leader not found" });

    await prisma.followers.updateMany({
      where: {
        leader_user_id: leader.user_id,
        follower_user_id: followerUserId,
      },
      data: { risk },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Update risk error:", err);
    res.status(500).json({ ok: false, error: "Failed to update risk" });
  }
});

// Webhook
app.post("/webhook", async (req, res) => {
  console.log("Webhook received:", req.body);
  res.json({ ok: true });
});

// Test Telegram
app.post("/api/test-telegram", async (req, res) => {
  const { botToken, chatId, message } = req.body;
  if (!botToken || !chatId || !message) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
    const tgData = await tgRes.json();
    if (!tgData.ok) throw new Error(tgData.description || "Telegram API error");
    res.json({ ok: true });
  } catch (err) {
    console.error("Test telegram error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Root Endpoint
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

function generateSignature(trade) {
  const data = JSON.stringify({
    symbol: trade.symbol,
    side: trade.side,
    size: trade.size,
    price: trade.price,
    leverage: trade.leverage,
  });
  return crypto.createHmac("sha256", APP_SECRET).update(data).digest("hex");
}

function formatTelegramMessage(signal, leaderUserId, referralCode) {
  const sideEmoji = signal.side.toUpperCase() === "BUY" ? "🟢 BUY" : "🔴 SELL";
  const typeTitle =
    signal.type === "Closed" ? "*Position Closed!*" : "*New Trade Alert!*";
  return `
${typeTitle}

📊 **Symbol:** \`${signal.symbol}\`
📈 **Side:** ${sideEmoji}
💰 **Size:** ${signal.size}
💵 **Price:** $${signal.price}
⚡ **Leverage:** ${signal.leverage}x
🕐 **Time:** ${new Date().toLocaleString()}

🔗 **Join my signals:** https://based-one-trade-sharer.vercel.app//?ref=${referralCode}

<tg-spoiler>SIGNAL: ${JSON.stringify(signal)}</tg-spoiler>
  `;
}

// Export for Vercel serverless
export default app;
