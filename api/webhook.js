// api/webhook.js

const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

const PLANS = {
  50: { monthly: 0.3 },
  100: { monthly: 0.4 },
  200: { monthly: 0.5 },
};

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase =
  supabaseUrl && supabaseServiceRoleKey
    ? createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      })
    : null;

function formatDate(date) {
  return new Date(date).toLocaleString();
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  const tgData = await tgRes.json().catch(() => ({}));

  if (!tgRes.ok || tgData.ok === false) {
    console.error("Telegram sendMessage failed", {
      status: tgRes.status,
      data: tgData,
    });
  }
}

async function ensureUserAndFreePlan(telegramUser) {
  if (!supabase) {
    throw new Error("Supabase client not initialized");
  }

  const telegramUserId = String(telegramUser.id);
  const username = telegramUser.username || null;

  const { error: userError } = await supabase.from("users").upsert(
    {
      telegramuserid: telegramUserId,
      username,
    },
    {
      onConflict: "telegramuserid",
    }
  );

  if (userError) {
    throw userError;
  }

  const { data: existingPlan, error: existingPlanError } = await supabase
    .from("plans")
    .select("telegramuserid")
    .eq("telegramuserid", telegramUserId)
    .maybeSingle();

  if (existingPlanError) {
    throw existingPlanError;
  }

  if (!existingPlan) {
    const { error: insertPlanError } = await supabase.from("plans").insert({
      telegramuserid: telegramUserId,
      planname: "free",
      walletlimit: FREE_WALLET_LIMIT,
      status: "active",
    });

    if (insertPlanError) {
      throw insertPlanError;
    }
  }
}

async function getUserPlan(telegramUserId) {
  if (!supabase) {
    throw new Error("Supabase client not initialized");
  }

  const { data, error } = await supabase
    .from("plans")
    .select("planname, walletlimit, status, updatedat")
    .eq("telegramuserid", String(telegramUserId))
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

module.exports = async function handler(req, res) {
  console.log("Webhook hit", {
    method: req.method,
    hasBody: !!req.body,
  });

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Webhook alive" });
  }

  const { message } = req.body || {};
  if (!message || !message.text) {
    console.log("No message text in update");
    return res.status(200).json({ ok: true, message: "No message text" });
  }

  const chatId = message.chat?.id;
  const text = (message.text || "").trim();
  const fromUser = message.from;

  console.log("Incoming message", { chatId, text });

  try {
    if (!chatId) {
      console.error("Missing chatId");
      return res.status(200).json({ ok: true, message: "Missing chatId" });
    }

    if (!supabase) {
      console.error("Missing Supabase environment variables");
      await sendTelegramMessage(
        chatId,
        "Database is not configured yet. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel."
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/start") {
      if (fromUser) {
        await ensureUserAndFreePlan(fromUser);
      }

      await sendTelegramMessage(
        chatId,
        `Hello! I'm CipherMind.

Your account has been set up.

Use /pricing to see plans.
Use /payment to see the payment wallet.
Use /plan to see your current plan.`
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/pricing") {
      await sendTelegramMessage(
        chatId,
        `Subscription Plans:

First 10 wallets: Free

50 wallets: ${PLANS[50].monthly.toFixed(2)} Solana (SOL)/month
100 wallets: ${PLANS[100].monthly.toFixed(2)} Solana (SOL)/month
200 wallets: ${PLANS[200].monthly.toFixed(2)} Solana (SOL)/month

All payments are made in Solana (SOL).

Use /payment to see the payment wallet.`
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/payment") {
      await sendTelegramMessage(
        chatId,
        `Payment Wallet:

${PAYMENT_WALLET}

Send payment in Solana (SOL) only to this wallet for monthly access.`
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/plan") {
      const userPlan = await getUserPlan(chatId);

      if (!userPlan) {
        await sendTelegramMessage(
          chatId,
          `No saved plan was found yet.

Send /start first to create your free plan.`
        );
        return res.status(200).json({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        `Your Current Plan:

Plan: ${userPlan.planname}
Wallet limit: ${userPlan.walletlimit}
Status: ${userPlan.status}
Updated: ${formatDate(userPlan.updatedat)}`
      );
      return res.status(200).json({ ok: true });
    }

    const groqKey = process.env.GROQ_API_KEY;

    if (!groqKey) {
      console.error("Missing GROQ_API_KEY");
      await sendTelegramMessage(
        chatId,
        "AI replies are temporarily unavailable, but command features still work."
      );
      return res.status(200).json({ ok: true });
    }

    const aiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are CipherMind, a helpful Telegram assistant." },
          { role: "user", content: text },
        ],
      }),
    });

    const aiData = await aiRes.json().catch(() => ({}));

    if (!aiRes.ok) {
      console.error("Groq request failed", {
        status: aiRes.status,
        data: aiData,
      });

      await sendTelegramMessage(
        chatId,
        "CipherMind AI is temporarily unavailable. Try again in a minute."
      );
      return res.status(200).json({ ok: true });
    }

    const reply = aiData.choices?.[0]?.message?.content || "No response.";

    await sendTelegramMessage(chatId, reply);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook handler error", error);

    try {
      if (chatId) {
        await sendTelegramMessage(
          chatId,
          "CipherMind is temporarily unavailable. Try again in a minute."
        );
      }
    } catch (sendError) {
      console.error("Failed sending fallback Telegram message", sendError);
    }

    return res.status(200).json({ ok: true, errorHandled: true });
  }
};
