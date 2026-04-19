const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

const PLANS = {
  50: { monthly: 0.20 },
  100: { monthly: 0.30 },
  200: { monthly: 0.40 },
};

const VALID_PLANS = new Set([50, 100, 200]);
const VALID_DURATIONS = new Set(["monthly"]);

const pendingPayments = new Map();
const userPlans = new Map();

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
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  const { message } = req.body || {};
  if (!message || !message.text) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "Hello! I'm CipherMind.

Use /pricing to see plans.
Use /payment for payment info.
Use /pay <plan> monthly to subscribe."
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/pricing") {
      await sendTelegramMessage(
        chatId,
        `Subscription Plans:

First 10 wallets: Free

50 wallets: 0.20 SOL/month
100 wallets: 0.30 SOL/month
200 wallets: 0.40 SOL/month

To subscribe, use /pay <plan> <duration>.
For example:
/pay 100 monthly`
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/payment") {
      await sendTelegramMessage(
        chatId,
        `Payment Wallet:

${PAYMENT_WALLET}

Send payment to this wallet for monthly bot access.

Use /pay <plan> monthly to get your payment amount and reference.

Example:
/pay 50 monthly`
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
Expires: ${formatDate(userPlan.expiresAt)}
Payment Reference: ${userPlan.reference}`
      );
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/pay ")) {
      const parts = text.split(/s+/);
      const plan = Number(parts[1]);
      const duration = (parts[2] || "").toLowerCase();

      if (!VALID_PLANS.has(plan) || !VALID_DURATIONS.has(duration)) {
        await sendTelegramMessage(
          chatId,
          `Invalid payment command.

Use one of these:
/pay 50 monthly
/pay 100 monthly
/pay 200 monthly`
        );
        return res.status(200).json({ ok: true });
      }

      const amount = PLANS[plan][duration];
      const reference = generatePaymentReference(chatId, plan);

      pendingPayments.set(reference, {
        chatId,
        plan,
        duration,
        amount,
        wallet: PAYMENT_WALLET,
        createdAt: new Date().toISOString(),
        status: "pending",
      });

      await sendTelegramMessage(
        chatId,
        `Subscription Payment

Plan: ${plan} wallets
Price: ${amount.toFixed(2)} SOL
Duration: monthly

Send payment to:
${PAYMENT_WALLET}

Payment Reference:
${reference}

Important:
Include this reference in your payment memo if possible.

After payment is confirmed, your monthly plan should start and expire one month later.

For now, payment confirmation still needs to be wired into live on-chain verification.`
      );
      return res.status(200).json({ ok: true });
    }

    if (text.startsWith("/activate ")) {
      const reference = text.replace("/activate", "").trim();
      const pending = pendingPayments.get(reference);

      if (!pending) {
        await sendTelegramMessage(chatId, "Payment reference not found.");
        return res.status(200).json({ ok: true });
      }

      if (pending.chatId !== chatId) {
        await sendTelegramMessage(chatId, "That payment reference does not belong to this chat.");
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

    const aiRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are CipherMind, a helpful Telegram assistant." },
          { role: "user", content: text }
        ],
      }),
    });

    const aiData = await aiRes.json();
    const reply = aiData.choices?.[0]?.message?.content || "No response.";

    await sendTelegramMessage(chatId, reply);
  } catch (e) {
    console.error(e);

    await sendTelegramMessage(
      chatId,
      "CipherMind is temporarily unavailable. Try again in a minute."
    );
  }

  res.status(200).json({ ok: true });
};
