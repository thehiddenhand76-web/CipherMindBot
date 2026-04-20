const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

const PLANS = {
  50: { monthly: 0.3 },
  100: { monthly: 0.4 },
  200: { monthly: 0.5 },
};

const supabaseUrl = process.env.SUPABASEURL;
const supabaseServiceRoleKey = process.env.SUPABASESERVICEROLEKEY;

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

function getCommand(text) {
  return (text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  const tgRes = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
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
      telegram_user_id: telegramUserId,
      username: username,
    },
    {
      onConflict: "telegram_user_id",
    }
  );

  if (userError) throw userError;

  const { data: existingPlan, error: existingPlanError } = await supabase
    .from("plans")
    .select("telegram_user_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (existingPlanError) throw existingPlanError;

  if (!existingPlan) {
    const { error: insertPlanError } = await supabase.from("plans").insert({
      telegram_user_id: telegramUserId,
      plan_name: "free",
      wallet_limit: FREE_WALLET_LIMIT,
      status: "active",
    });

    if (insertPlanError) throw insertPlanError;
  }
}

async function getUserPlan(telegramUserId) {
  if (!supabase) {
    throw new Error("Supabase client not initialized");
  }

  const { data, error } = await supabase
    .from("plans")
    .select("plan_name, wallet_limit, status, updated_at")
    .eq("telegram_user_id", String(telegramUserId))
    .maybeSingle();

  if (error) throw error;
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

  const message = req.body && req.body.message ? req.body.message : null;

  if (!message || !message.text) {
    console.log("No message text in update");
    return res.status(200).json({ ok: true, message: "No message text" });
  }

  const chatId = message.chat && message.chat.id ? message.chat.id : null;
  const text = (message.text || "").trim();
  const fromUser = message.from;
  const command = getCommand(text);

  console.log("Incoming message", { chatId, text, command });

  try {
    if (!chatId) {
      console.error("Missing chatId");
      return res.status(200).json({ ok: true, message: "Missing chatId" });
    }

    if (!supabase) {
      console.error("Missing Supabase environment variables");
      await sendTelegramMessage(
        chatId,
        "Database is not configured yet. Add SUPABASEURL and SUPABASESERVICEROLEKEY in Vercel."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/start") {
      if (fromUser) {
        await ensureUserAndFreePlan(fromUser);
      }

      await sendTelegramMessage(
        chatId,
        "Hello! I'm CipherMind. Your account has been set up. Use /pricing to see plans. Use /payment to see the payment wallet. Use /plan to see your current plan."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pricing") {
      await sendTelegramMessage(
        chatId,
        "Subscription Plans: First 10 wallets free. 50 wallets: " +
          PLANS[50].monthly.toFixed(2) +
          " SOL per month. 100 wallets: " +
          PLANS[100].monthly.toFixed(2) +
          " SOL per month. 200 wallets: " +
          PLANS[200].monthly.toFixed(2) +
          " SOL per month. Use /payment to see the payment wallet."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/payment") {
      await sendTelegramMessage(
        chatId,
        "Payment Wallet: " +
          PAYMENT_WALLET +
          " Send payment in Solana SOL only to this wallet for monthly access."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/plan") {
      if (!fromUser) {
        await sendTelegramMessage(chatId, "Could not identify user. Please try again.");
        return res.status(200).json({ ok: true });
      }

      const userPlan = await getUserPlan(fromUser.id);

      if (!userPlan) {
        await sendTelegramMessage(
          chatId,
          "No saved plan was found yet. Send /start first to create your free plan."
        );
        return res.status(200).json({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        "Your Current Plan: Plan " +
          userPlan.plan_name +
          ", wallet limit " +
          userPlan.wallet_limit +
          ", status " +
          userPlan.status +
          ", updated " +
          formatDate(userPlan.updated_at)
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pay") {
      await sendTelegramMessage(
        chatId,
        "To subscribe, send payment in Solana SOL to " +
          PAYMENT_WALLET +
          " and then message support with your requested plan: 50, 100, or 200 wallets."
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
        Authorization: "Bearer " + groqKey,
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

    const reply =
      aiData &&
      aiData.choices &&
      aiData.choices[0] &&
      aiData.choices[0].message &&
      aiData.choices[0].message.content
        ? aiData.choices[0].message.content
        : "No response.";

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
