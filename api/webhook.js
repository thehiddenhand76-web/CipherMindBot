// api/webhook.js

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

const PLANS = {
  50: { monthly: 0.3 },
  100: { monthly: 0.4 },
  200: { monthly: 0.5 },
};

const userPlans = new Map();

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

  try {
    if (!chatId) {
      console.error("Missing chatId");
      return res.status(200).json({ ok: true, message: "Missing chatId" });
    }

    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        `Hello! I'm CipherMind.

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

50 wallets: ${PLANS[50].monthly.toFixed(2)} SOL/month
100 wallets: ${PLANS[100].monthly.toFixed(2)} SOL/month
200 wallets: ${PLANS[200].monthly.toFixed(2)} SOL/month

Use /payment to see the payment wallet.`
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/payment") {
      await sendTelegramMessage(
        chatId,
        `Payment Wallet:

${PAYMENT_WALLET}

Send SOL to this wallet for monthly access.`
      );
      return res.status(200).json({ ok: true });
    }

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
Expires: ${formatDate(userPlan.expiresAt)}`
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
