// api/webhook.js

const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

const PLANS = {
  50: { monthly: 0.3 },
  100: { monthly: 0.4 },
  200: { monthly: 0.5 },
};

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.SUPABASEURL;

const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASESERVICEROLEKEY;

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

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function getCommand(text) {
  return (text || "").trim().split(/s+/)[0].split("@")[0].toLowerCase();
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

  if (userError) throw userError;

  const { data: existingPlan, error: existingPlanError } = await supabase
    .from("plans")
    .select("telegramuserid")
    .eq("telegramuserid", telegramUserId)
    .maybeSingle();

  if (existingPlanError) throw existingPlanError;

  if (!existingPlan) {
    const { error: insertPlanError } = await supabase.from("plans").insert({
      telegramuserid: telegramUserId,
      planname: "free",
      walletlimit: FREE_WALLET_LIMIT,
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
    .select("planname, walletlimit, status, updatedat")
    .eq("telegramuserid", String(telegramUserId))
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getTrackedWallets(telegramUserId) {
  const { data, error } = await supabase
    .from("trackedwallets")
    .select("id, walletaddress, label, chain, createdat")
    .eq("telegramuserid", String(telegramUserId))
    .order("createdat", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function addTrackedWallet(telegramUserId, walletAddress, label) {
  const currentPlan = await getUserPlan(telegramUserId);

  if (!currentPlan) {
    return { ok: false, message: "No saved plan found. Send /start first." };
  }

  const existingWallets = await getTrackedWallets(telegramUserId);

  if (existingWallets.find((w) => w.walletaddress === walletAddress)) {
    return { ok: false, message: "That wallet is already being tracked." };
  }

  if (existingWallets.length >= currentPlan.walletlimit) {
    return {
      ok: false,
      message: "You reached your wallet limit for your current plan. Use /pricing or /pay to upgrade.",
    };
  }

  const { error } = await supabase.from("trackedwallets").insert({
    telegramuserid: String(telegramUserId),
    walletaddress: walletAddress,
    chain: "solana",
    label: label || null,
  });

  if (error) throw error;

  return { ok: true, message: "Wallet added successfully." };
}

async function removeTrackedWallet(telegramUserId, walletAddress) {
  const { data, error } = await supabase
    .from("trackedwallets")
    .delete()
    .eq("telegramuserid", String(telegramUserId))
    .eq("walletaddress", walletAddress)
    .select("id");

  if (error) throw error;

  if (!data || data.length === 0) {
    return { ok: false, message: "That wallet was not found in your tracked list." };
  }

  return { ok: true, message: "Wallet removed successfully." };
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
  const command = getCommand(text);
  const parts = text.split(/s+/);

  console.log("Incoming message", { chatId, text, command });

  try {
    if (!chatId) {
      console.error("Missing chatId");
      return res.status(200).json({ ok: true, message: "Missing chatId" });
    }

    if (!supabase) {
      console.error("Missing Supabase environment variables", {
        has_SUPABASE_URL: !!process.env.SUPABASE_URL,
        has_SUPABASEURL: !!process.env.SUPABASEURL,
        has_SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        has_SUPABASESERVICEROLEKEY: !!process.env.SUPABASESERVICEROLEKEY,
      });

      await sendTelegramMessage(
        chatId,
        "Database is not configured yet. Add SUPABASE_URL or SUPABASEURL, and SUPABASE_SERVICE_ROLE_KEY or SUPABASESERVICEROLEKEY in Vercel."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/start") {
      if (fromUser) {
        await ensureUserAndFreePlan(fromUser);
      }

      await sendTelegramMessage(
        chatId,
        "Hello! I'm CipherMind.

Your account has been set up.

Use /pricing to see plans.
Use /payment to see the payment wallet.
Use /plan to see your current plan."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pricing") {
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

    if (command === "/payment") {
      await sendTelegramMessage(
        chatId,
        `Payment Wallet:

${PAYMENT_WALLET}

Send payment in Solana (SOL) only to this wallet for monthly access.`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/plan") {
      const userPlan = await getUserPlan(chatId);

      if (!userPlan) {
        await sendTelegramMessage(
          chatId,
          "No saved plan was found yet.

Send /start first to create your free plan."
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

    if (command === "/pay") {
      await sendTelegramMessage(
        chatId,
        `To subscribe, send payment in Solana (SOL) to:

${PAYMENT_WALLET}

Then message support with your requested plan: 50, 100, or 200 wallets.`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/addwallet") {
      if (parts.length < 2) {
        await sendTelegramMessage(
          chatId,
          "Usage:
/addwallet WALLET_ADDRESS LABEL

Example:
/addwallet 8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j Main"
        );
        return res.status(200).json({ ok: true });
      }

      const walletAddress = parts[1];
      const label = parts.slice(2).join(" ").trim();

      if (!isValidSolanaAddress(walletAddress)) {
        await sendTelegramMessage(
          chatId,
          "That does not look like a valid Solana wallet address."
        );
        return res.status(200).json({ ok: true });
      }

      const result = await addTrackedWallet(chatId, walletAddress, label);

      await sendTelegramMessage(
        chatId,
        result.ok
          ? `Wallet added successfully.

Address: ${walletAddress}${label ? `
Label: ${label}` : ""}`
          : result.message
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/wallets") {
      const wallets = await getTrackedWallets(chatId);

      if (!wallets.length) {
        await sendTelegramMessage(
          chatId,
          "You are not tracking any wallets yet.

Use /addwallet WALLET_ADDRESS LABEL to add one."
        );
        return res.status(200).json({ ok: true });
      }

      const formatted = wallets
        .map((wallet, index) => {
          return `${index + 1}. ${wallet.walletaddress}${wallet.label ? ` (${wallet.label})` : ""}`;
        })
        .join("
");

      await sendTelegramMessage(
        chatId,
        `Your Tracked Wallets:

${formatted}`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/removewallet") {
      if (parts.length < 2) {
        await sendTelegramMessage(
          chatId,
          "Usage:
/removewallet WALLET_ADDRESS"
        );
        return res.status(200).json({ ok: true });
      }

      const walletAddress = parts[1];
      const result = await removeTrackedWallet(chatId, walletAddress);

      await sendTelegramMessage(chatId, result.message);
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
