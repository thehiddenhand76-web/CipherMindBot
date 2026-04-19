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

  console.log("Incoming message", { chatId, text });

  // --- Supabase: upsert user into "users" table ---
  try {
    if (chatId && message.from) {
      const telegramUserId = String(chatId);
      const username = message.from.username || null;

      const { error: userError } = await supabase
        .from("users")
        .upsert(
          {
            telegram_user_id: telegramUserId,
            username,
          },
          { onConflict: "telegram_user_id" }
        );

      if (userError) {
        console.error("Supabase upsert users failed", userError);
      }
    }
  } catch (e) {
    console.error("Supabase users write error", e);
  }
  // ------------------------------------------------

  try {
    if (!chatId) {
      console.error("Missing chatId");
      return res.status(200).json({ ok: true, message: "Missing chatId" });
    }

    // /start
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        `Hello! I'm CipherMind.

Use /pricing to see plans.
Use /payment for payment info.
Use /pay <plan> monthly to subscribe.
Use /plan to see your current plan.`
      );
      return res.status(200).json({ ok: true });
    }

    // /pricing
    if (text === "/pricing") {
      await sendTelegramMessage(
        chatId,
        `Subscription Plans:

First 10 wallets: Free

50 wallets: 0.20 SOL/month
100 wallets: 0.30 SOL/month
200 wallets: 0.40 SOL/month

To subscribe, use:
/pay 50 monthly
/pay 100 monthly
/pay 200 monthly`
      );
      return res.status(200).json({ ok: true });
    }

    // /payment
    if (text === "/payment") {
      await sendTelegramMessage(
        chatId,
        `Payment Wallet:

${PAYMENT_WALLET}

Send SOL to this wallet for monthly access.

Then use:
/pay 50 monthly
or another listed plan.`
      );
      return res.status(200).json({ ok: true });
    }

    // /plan
    if (text === "/plan") {
      const userPlan = userPlans.get(chatId);

      if (!userPlan) {
        await sendTelegramMessage(
          chatId,
          `You are currently on the free plan.
Wallet limit: ${FREE_WALLET_LIMIT}`
        );
        return res.status(200).json({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        `Your Current Plan:

Plan: ${userPlan.plan} wallets
Status: ${userPlan.status}
Started: ${formatDate(userPlan.startedAt)}
Expires: ${formatDate(userPlan.expiresAt)}
Payment Reference: ${userPlan.reference}`
      );
      return res.status(200).json({ ok: true });
    }

    // /pay <plan> monthly
    if (text.startsWith("/pay ")) {
      // FIX: split on whitespace
      const parts = text.split(/s+/);
      const plan = Number(parts[1]);
      const duration = (parts[2] || "").toLowerCase();

      if (!PLANS[plan] || duration !== "monthly") {
        await sendTelegramMessage(
          chatId,
          `Invalid payment command.

Use:
/pay 50 monthly
/pay 100 monthly
/pay 200 monthly`
        );
        return res.status(200).json({ ok: true });
      }

      const amount = PLANS[plan].monthly;
      const reference = generatePaymentReference(chatId, plan);

      // Keep in‑memory tracking for now
      pendingPayments.set(reference, {
        chatId,
        plan,
        duration,
        amount,
        wallet: PAYMENT_WALLET,
        createdAt: new Date().toISOString(),
        status: "pending",
      });

      // NEW: log payment intent in Supabase pending_payments table
      try {
        const telegramUserId = String(chatId);

        const { error: payError } = await supabase
          .from("pending_payments")
          .insert({
            telegram_user_id: telegramUserId,
            plan_requested: String(plan),
            amount,
            billing_cycle: duration,
            status: "pending",
            // created_at default handled by Supabase
          });

        if (payError) {
          console.error(
            "Supabase insert pending_payments failed",
            payError
          );
        }
      } catch (e) {
        console.error("Supabase pending_payments insert error", e);
      }

      await sendTelegramMessage(
        chatId,
        `Subscription Payment

Plan: ${plan} wallets
Price: ${amount.toFixed(2)} SOL
Duration: monthly

Send payment to:
${PAYMENT_WALLET}

Reference:
${reference}

After manual confirmation, activate with:
/activate ${reference}`
      );
      return res.status(200).json({ ok: true });
    }

    // /activate <reference>
    if (text.startsWith("/activate ")) {
      const reference = text.replace("/activate", "").trim();
      const pending = pendingPayments.get(reference);

      if (!pending) {
        await sendTelegramMessage(chatId, "Payment reference not found.");
        return res.status(200).json({ ok: true });
      }

      if (pending.chatId !== chatId) {
        await sendTelegramMessage(
          chatId,
          "This payment reference belongs to another chat."
        );
        return res.status(200).json({ ok: true });
      }

      const startedAt = new Date();
      const expiresAt = addOneMonth(startedAt);

      userPlans.set(chatId, {
        plan: pending.plan,
        duration: pending.duration,
        amount: pending.amount,
        wallet: pending.wallet,
        reference,
        status: "active",
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      pendingPayments.set(reference, {
        ...pending,
        status: "paid",
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      await sendTelegramMessage(
        chatId,
        `Plan activated successfully.

Plan: ${pending.plan} wallets
Status: active
Started: ${formatDate(startedAt)}
Expires: ${formatDate(expiresAt)}`
      );
      return res.status(200).json({ ok: true });
    }

    // AI chat via Groq
    const groqKey = process.env.GROQ_API_KEY;

    if (!groqKey) {
      console.error("Missing GROQ_API_KEY");
      await sendTelegramMessage(
        chatId,
        "AI replies are temporarily unavailable, but command features still work."
      );
      return res.status(200).json({ ok: true });
    }

    const aiRes = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [
            {
              role: "system",
              content: "You are CipherMind, a helpful Telegram assistant.",
            },
            { role: "user", content: text },
          ],
        }),
      }
    );

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
      aiData.choices?.[0]?.message?.content || "No response.";

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
