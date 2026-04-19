// api/webhook.js

const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const PLAN_CONFIG = {
  free: { walletLimit: 10, price: 0, label: "Free" },
  "50": { walletLimit: 50, price: 0.3, label: "50 wallets" },
  "100": { walletLimit: 100, price: 0.4, label: "100 wallets" },
  "200": { walletLimit: 200, price: 0.5, label: "200 wallets" },
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
  if (!date) return "N/A";
  return new Date(date).toLocaleString();
}

function normalizeCommand(text) {
  return text.split(" ")[0].split("@")[0].toLowerCase();
}

function parseCommandArgs(text) {
  const parts = text.trim().split(/s+/);
  return parts.slice(1);
}

function getPlanDetails(planName, walletLimit) {
  if (PLAN_CONFIG[planName]) {
    return PLAN_CONFIG[planName];
  }

  return {
    walletLimit: walletLimit || FREE_WALLET_LIMIT,
    price: null,
    label: planName || "Unknown",
  };
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

async function getWalletCount(telegramUserId) {
  const { count, error } = await supabase
    .from("trackedwallets")
    .select("*", { count: "exact", head: true })
    .eq("telegramuserid", String(telegramUserId));

  if (error) {
    throw error;
  }

  return count || 0;
}

async function addWallet(telegramUserId, walletAddress, label) {
  const plan = await getUserPlan(telegramUserId);

  if (!plan) {
    return { ok: false, message: "No plan found. Send /start first." };
  }

  const currentCount = await getWalletCount(telegramUserId);
  const walletLimit = plan.walletlimit || FREE_WALLET_LIMIT;

  if (currentCount >= walletLimit) {
    return {
      ok: false,
      message: `You have reached your wallet limit for the ${plan.planname} plan.

Current limit: ${walletLimit}
Use /pricing to view upgrade options.`,
    };
  }

  const { data: existingWallet, error: existingWalletError } = await supabase
    .from("trackedwallets")
    .select("id")
    .eq("telegramuserid", String(telegramUserId))
    .eq("walletaddress", walletAddress)
    .maybeSingle();

  if (existingWalletError) {
    throw existingWalletError;
  }

  if (existingWallet) {
    return { ok: false, message: "That wallet is already being tracked." };
  }

  const { error } = await supabase.from("trackedwallets").insert({
    telegramuserid: String(telegramUserId),
    walletaddress: walletAddress,
    chain: "solana",
    label: label || null,
  });

  if (error) {
    throw error;
  }

  return { ok: true, message: "Wallet added successfully." };
}

async function listWallets(telegramUserId) {
  const { data, error } = await supabase
    .from("trackedwallets")
    .select("walletaddress, chain, label, createdat")
    .eq("telegramuserid", String(telegramUserId))
    .order("createdat", { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function removeWallet(telegramUserId, walletAddress) {
  const { data, error } = await supabase
    .from("trackedwallets")
    .delete()
    .eq("telegramuserid", String(telegramUserId))
    .eq("walletaddress", walletAddress)
    .select(); 

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return { ok: false, message: "That wallet was not found in your tracked list." };
  }

  return { ok: true, message: "Wallet removed successfully." };
}

async function createPendingPayment(telegramUserId, requestedPlan) {
  const planKey = String(requestedPlan);
  const selectedPlan = PLAN_CONFIG[planKey];

  if (!selectedPlan || planKey === "free") {
    return { ok: false, message: "Invalid plan. Use /pay 50, /pay 100, or /pay 200." };
  }

  const { error } = await supabase.from("pendingpayments").insert({
    telegramuserid: String(telegramUserId),
    planrequested: planKey,
    amount: selectedPlan.price,
    billingcycle: "monthly",
    status: "pending",
  });

  if (error) {
    throw error;
  }

  return {
    ok: true,
    message: `Payment Request Created

Requested plan: ${selectedPlan.label}
Price: ${selectedPlan.price.toFixed(2)} Solana (SOL)/month

Send payment in Solana (SOL) only to:
${PAYMENT_WALLET}

After payment is confirmed, your plan can be updated.`,
  };
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
  const command = normalizeCommand(text);
  const args = parseCommandArgs(text);

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

    if (command === "/start") {
      if (fromUser) {
        await ensureUserAndFreePlan(fromUser);
      }

      await sendTelegramMessage(
        chatId,
        `Hello! I'm CipherMind.

Your account has been set up.

Use /pricing to see plans.
Use /payment to see the payment wallet.
Use /plan to see your current plan.
Use /pay to subscribe to a plan.
Use /addwallet to track a Solana wallet.
Use /wallets to view tracked wallets.`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pricing") {
      await sendTelegramMessage(
        chatId,
        `Subscription Plans:

First 10 wallets: Free

50 wallets: ${PLAN_CONFIG["50"].price.toFixed(2)} Solana (SOL)/month
100 wallets: ${PLAN_CONFIG["100"].price.toFixed(2)} Solana (SOL)/month
200 wallets: ${PLAN_CONFIG["200"].price.toFixed(2)} Solana (SOL)/month

All payments are made in Solana (SOL).

Use /payment to see the payment wallet.
Use /pay 50, /pay 100, or /pay 200 to subscribe.`
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
          `No saved plan was found yet.

Send /start first to create your free plan.`
        );
        return res.status(200).json({ ok: true });
      }

      const details = getPlanDetails(userPlan.planname, userPlan.walletlimit);

      await sendTelegramMessage(
        chatId,
        `Your Current Plan:

Plan: ${userPlan.planname}
Wallet limit: ${details.walletLimit}
Status: ${userPlan.status}
Updated: ${formatDate(userPlan.updatedat)}`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pay") {
      if (args.length === 0) {
        await sendTelegramMessage(
          chatId,
          `To subscribe, use one of these:

/pay 50
/pay 100
/pay 200

All payments are in Solana (SOL).`
        );
        return res.status(200).json({ ok: true });
      }

      const result = await createPendingPayment(chatId, args[0]);
      await sendTelegramMessage(chatId, result.message);
      return res.status(200).json({ ok: true });
    }

    if (command === "/addwallet") {
      if (args.length === 0) {
        await sendTelegramMessage(
          chatId,
          `Usage:

/addwallet WALLET_ADDRESS LABEL

Example:
/addwallet 7f3xExampleWalletAddress123456789 MainWallet`
        );
        return res.status(200).json({ ok: true });
      }

      const walletAddress = args[0];
      const label = args.slice(1).join(" ").trim();

      if (!SOLANA_ADDRESS_REGEX.test(walletAddress)) {
        await sendTelegramMessage(
          chatId,
          "That does not look like a valid Solana wallet address. Please check it and try again."
        );
        return res.status(200).json({ ok: true });
      }

      const result = await addWallet(chatId, walletAddress, label);
      await sendTelegramMessage(
        chatId,
        result.ok
          ? `${result.message}

Address: ${walletAddress}${label ? `
Label: ${label}` : ""}`
          : result.message
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/wallets") {
      const wallets = await listWallets(chatId);

      if (!wallets.length) {
        await sendTelegramMessage(
          chatId,
          "You are not tracking any wallets yet.

Use /addwallet WALLET_ADDRESS LABEL to add one."
        );
        return res.status(200).json({ ok: true });
      }

      const lines = wallets.map((wallet, index) => {
        const labelPart = wallet.label ? ` (${wallet.label})` : "";
        return `${index + 1}. ${wallet.walletaddress}${labelPart}`;
      });

      await sendTelegramMessage(
        chatId,
        `Your Tracked Wallets:

${lines.join("
")}`
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/removewallet") {
      if (args.length === 0) {
        await sendTelegramMessage(
          chatId,
          `Usage:

/removewallet WALLET_ADDRESS`
        );
        return res.status(200).json({ ok: true });
      }

      const walletAddress = args[0];
      const result = await removeWallet(chatId, walletAddress);
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
          {
            role: "system",
            content:
              "You are CipherMind, a helpful Telegram assistant for Solana wallet tracking and subscription support.",
          },
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
