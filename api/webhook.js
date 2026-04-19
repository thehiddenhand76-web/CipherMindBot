// api/webhook.js

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

const PLANS = {
  50: { monthly: 0.2 },
  100: { monthly: 0.3 },
  200: { monthly: 0.4 },
};

// In‑memory maps (later you can move these fully to Supabase)
const pendingPayments = new Map();
const userPlans = new Map();

// Supabase client
const { supabase } = require("../lib/supabase");

function addOneMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

function formatDate(date) {
  return new Date(date).toLocaleString();
}

function generatePaymentReference(chatId, plan) {
  return `SUB-${chatId}-${plan}-${Date.now()}`;
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  console.log("Sending Telegram message", { chatId, text });

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  const rawBody = await tgRes.text();
  let tgData = null;
  try {
    tgData = JSON.parse(rawBody);
  } catch (e) {
    // non‑JSON body is fine; we logged rawBody
  }

  console.log("Telegram sendMessage status:", tgRes.status);
  console.log("Telegram sendMessage body:", rawBody);

  if (!tgRes.ok || (tgData && tgData.ok === false)) {
    console.error("Telegram sendMessage failed", {
      status: tgRes.status,
      data: tgData || rawBody,
    });
  }
}
