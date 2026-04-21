const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;
const HELIUS_API_BASE = "https://api.helius.xyz/v0";

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

function getArgs(text) {
  const parts = (text || "").trim().split(/\s+/);
  return parts.slice(1);
}

function shortenAddress(addr, len = 6) {
  if (!addr || addr.length <= len * 2 + 3) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

function isValidSolanaAddress(address) {
  return typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

async function sendTelegramMessage(chatId, text, parseMode) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }
  const body = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;
  const tgRes = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const tgData = await tgRes.json().catch(() => ({}));
  if (!tgRes.ok || tgData.ok === false) {
    console.error("Telegram sendMessage failed", { status: tgRes.status, data: tgData });
  }
}

async function ensureUserAndFreePlan(telegramUser) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const telegramUserId = String(telegramUser.id);
  const username = telegramUser.username || null;
  const { error: userError } = await supabase.from("users").upsert(
    { telegram_user_id: telegramUserId, username: username },
    { onConflict: "telegram_user_id" }
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
  if (!supabase) throw new Error("Supabase client not initialized");
  const { data, error } = await supabase
    .from("plans")
    .select("plan_name, wallet_limit, status, updated_at")
    .eq("telegram_user_id", String(telegramUserId))
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getTrackedWallets(telegramUserId) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { data, error } = await supabase
    .from("tracked_wallets")
    .select("wallet_address, label, created_at")
    .eq("telegram_user_id", String(telegramUserId))
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addTrackedWallet(telegramUserId, chatId, walletAddress, label) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { error } = await supabase.from("tracked_wallets").upsert(
    {
      telegram_user_id: String(telegramUserId),
      telegram_chat_id: String(chatId),
      wallet_address: walletAddress,
      label: label || null,
      active: true,
    },
    { onConflict: "telegram_user_id,wallet_address" }
  );
  if (error) throw error;
}

async function removeTrackedWallet(telegramUserId, walletAddress) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { error } = await supabase
    .from("tracked_wallets")
    .update({ active: false })
    .eq("telegram_user_id", String(telegramUserId))
    .eq("wallet_address", walletAddress);
  if (error) throw error;
}

async function registerWalletWithHelius(walletAddress) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) { console.error("Missing HELIUS_API_KEY"); return; }
  const webhookUrl = process.env.HELIUS_WEBHOOK_URL;
  if (!webhookUrl) { console.error("Missing HELIUS_WEBHOOK_URL"); return; }
  const secret = process.env.WEBHOOK_SECRET;
  const fullUrl = secret ? webhookUrl + "?secret=" + secret : webhookUrl;
  const listRes = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`);
  const webhooks = await listRes.json().catch(() => []);
  const existing = Array.isArray(webhooks) ? webhooks.find((w) => w.webhookURL === fullUrl) : null;
  if (existing) {
    const merged = Array.from(new Set([...(existing.accountAddresses || []), walletAddress]));
    await fetch(`${HELIUS_API_BASE}/webhooks/${existing.webhookID}?api-key=${apiKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: fullUrl,
        transactionTypes: existing.transactionTypes || ["Any"],
        accountAddresses: merged,
        webhookType: existing.webhookType || "enhanced",
      }),
    });
  } else {
    await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: fullUrl,
        transactionTypes: ["Any"],
        accountAddresses: [walletAddress],
        webhookType: "enhanced",
      }),
    });
  }
}

async function unregisterWalletFromHelius(walletAddress) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return;
  const webhookUrl = process.env.HELIUS_WEBHOOK_URL;
  if (!webhookUrl) return;
  const secret = process.env.WEBHOOK_SECRET;
  const fullUrl = secret ? webhookUrl + "?secret=" + secret : webhookUrl;
  const listRes = await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`);
  const webhooks = await listRes.json().catch(() => []);
  const existing = Array.isArray(webhooks) ? webhooks.find((w) => w.webhookURL === fullUrl) : null;
  if (!existing) return;
  const filtered = (existing.accountAddresses || []).filter((a) => a !== walletAddress);
  await fetch(`${HELIUS_API_BASE}/webhooks/${existing.webhookID}?api-key=${apiKey}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: fullUrl,
      transactionTypes: existing.transactionTypes || ["Any"],
      accountAddresses: filtered,
      webhookType: existing.webhookType || "enhanced",
    }),
  });
}

async function handleTrack(chatId, fromUser, text) {
  if (!fromUser) {
    await sendTelegramMessage(chatId, "Could not identify your account. Please try again.");
    return;
  }
  const args = getArgs(text);
  const walletAddress = args[0];
  const label = args.slice(1).join(" ") || null;
  if (!walletAddress) {
    await sendTelegramMessage(chatId, "Usage: /track <wallet_address> [optional label]\n\nExample:\n/track ABC123...XYZ my wallet");
    return;
  }
  if (!isValidSolanaAddress(walletAddress)) {
    await sendTelegramMessage(chatId, "That doesn't look like a valid Solana address. Please check and try again.");
    return;
  }
  const telegramUserId = String(fromUser.id);
  const userPlan = await getUserPlan(telegramUserId);
  if (!userPlan) {
    await sendTelegramMessage(chatId, "No plan found. Send /start first to set up your account.");
    return;
  }
  if (userPlan.status !== "active") {
    await sendTelegramMessage(chatId, "Your plan is not active. Please contact support.");
    return;
  }
  const existing = await getTrackedWallets(telegramUserId);
  if (existing.length >= userPlan.wallet_limit) {
    await sendTelegramMessage(chatId, "You have reached your wallet limit of " + userPlan.wallet_limit + " on the " + userPlan.plan_name + " plan. Use /pricing to upgrade.");
    return;
  }
  const alreadyTracked = existing.some((w) => w.wallet_address === walletAddress);
  if (alreadyTracked) {
    await sendTelegramMessage(chatId, "You are already tracking " + shortenAddress(walletAddress) + ".");
    return;
  }
  await addTrackedWallet(telegramUserId, chatId, walletAddress, label);
  await registerWalletWithHelius(walletAddress);
  const displayLabel = label ? ' ("' + label + '")' : "";
  await sendTelegramMessage(chatId, "Tracking started for " + shortenAddress(walletAddress) + displayLabel + ". You will receive alerts when this wallet has activity.");
}

async function handleUntrack(chatId, fromUser, text) {
  if (!fromUser) {
    await sendTelegramMessage(chatId, "Could not identify your account. Please try again.");
    return;
  }
  const args = getArgs(text);
  const walletAddress = args[0];
  if (!walletAddress) {
    await sendTelegramMessage(chatId, "Usage: /untrack <wallet_address>\n\nUse /wallets to see your tracked wallets.");
    return;
  }
  const telegramUserId = String(fromUser.id);
  const existing = await getTrackedWallets(telegramUserId);
  const found = existing.find((w) => w.wallet_address === walletAddress);
  if (!found) {
    await sendTelegramMessage(chatId, "Wallet " + shortenAddress(walletAddress) + " is not in your tracked list.");
    return;
  }
  await removeTrackedWallet(telegramUserId, walletAddress);
  await unregisterWalletFromHelius(walletAddress);
  await sendTelegramMessage(chatId, "Stopped tracking " + shortenAddress(walletAddress) + ".");
}

async function handleWallets(chatId, fromUser) {
  if (!fromUser) {
    await sendTelegramMessage(chatId, "Could not identify your account. Please try again.");
    return;
  }
  const telegramUserId = String(fromUser.id);
  const wallets = await getTrackedWallets(telegramUserId);
  const userPlan = await getUserPlan(telegramUserId);
  if (wallets.length === 0) {
    await sendTelegramMessage(chatId, "You are not tracking any wallets yet.\n\nUse /track <wallet_address> to start.");
    return;
  }
  const limit = userPlan ? userPlan.wallet_limit : FREE_WALLET_LIMIT;
  const lines = ["Your Tracked Wallets (" + wallets.length + "/" + limit + "):"];
  wallets.forEach((w, i) => {
    const label = w.label ? ' — "' + w.label + '"' : "";
    lines.push((i + 1) + ". " + shortenAddress(w.wallet_address) + label);
  });
  lines.push("\nUse /untrack <wallet_address> to stop tracking a wallet.");
  await sendTelegramMessage(chatId, lines.join("\n"));
}

module.exports = async function handler(req, res) {
  console.log("Webhook hit", { method: req.method, hasBody: !!req.body });

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

  console.log("Incoming message", { chatId, command });

  try {
    if (!chatId) {
      return res.status(200).json({ ok: true, message: "Missing chatId" });
    }

    if (!supabase) {
      await sendTelegramMessage(chatId, "Database is not configured yet. Add SUPABASEURL and SUPABASESERVICEROLEKEY in Vercel.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/start") {
      if (fromUser) await ensureUserAndFreePlan(fromUser);
      await sendTelegramMessage(chatId, "Hello! I'm CipherMind.\n\nYour account has been set up.\n\nCommands:\n/plan — your current plan\n/pricing — subscription plans\n/payment — payment wallet\n/track <address> — track a wallet\n/untrack <address> — stop tracking\n/wallets — list tracked wallets");
      return res.status(200).json({ ok: true });
    }

    if (command === "/pricing") {
      await sendTelegramMessage(chatId, "Subscription Plans:\n\nFirst " + FREE_WALLET_LIMIT + " wallets free.\n50 wallets: " + PLANS[50].monthly.toFixed(2) + " SOL/month\n100 wallets: " + PLANS[100].monthly.toFixed(2) + " SOL/month\n200 wallets: " + PLANS[200].monthly.toFixed(2) + " SOL/month\n\nUse /payment to see the payment wallet.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/payment") {
      await sendTelegramMessage(chatId, "Payment Wallet:\n" + PAYMENT_WALLET + "\n\nSend payment in Solana SOL only to this wallet for monthly access.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/plan") {
      if (!fromUser) {
        await sendTelegramMessage(chatId, "Could not identify user. Please try again.");
        return res.status(200).json({ ok: true });
      }
      const userPlan = await getUserPlan(fromUser.id);
      if (!userPlan) {
        await sendTelegramMessage(chatId, "No saved plan found. Send /start first to create your free plan.");
        return res.status(200).json({ ok: true });
      }
      await sendTelegramMessage(chatId, "Your Current Plan:\nPlan: " + userPlan.plan_name + "\nWallet limit: " + userPlan.wallet_limit + "\nStatus: " + userPlan.status + "\nUpdated: " + formatDate(userPlan.updated_at));
      return res.status(200).json({ ok: true });
    }

    if (command === "/pay") {
      await sendTelegramMessage(chatId, "To subscribe, send payment in Solana SOL to:\n" + PAYMENT_WALLET + "\n\nThen message support with your plan choice: 50, 100, or 200 wallets.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/track") {
      await handleTrack(chatId, fromUser, text);
      return res.status(200).json({ ok: true });
    }

    if (command === "/untrack") {
      await handleUntrack(chatId, fromUser, text);
      return res.status(200).json({ ok: true });
    }

    if (command === "/wallets") {
      await handleWallets(chatId, fromUser);
      return res.status(200).json({ ok: true });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      await sendTelegramMessage(chatId, "AI replies are temporarily unavailable, but all commands still work.");
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
          { role: "system", content: "You are CipherMind, a helpful Telegram assistant for a Solana wallet tracking service. Help users understand wallet tracking, Solana, and subscription plans." },
          { role: "user", content: text },
        ],
      }),
    });

    const aiData = await aiRes.json().catch(() => ({}));

    if (!aiRes.ok) {
      await sendTelegramMessage(chatId, "CipherMind AI is temporarily unavailable. Try again in a minute.");
      return res.status(200).json({ ok: true });
    }

    const reply =
      aiData && aiData.choices && aiData.choices[0] && aiData.choices[0].message && aiData.choices[0].message.content
        ? aiData.choices[0].message.content
        : "No response.";

    await sendTelegramMessage(chatId, reply);
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Webhook handler error", error);
    try {
      if (chatId) {
        await sendTelegramMessage(chatId, "CipherMind is temporarily unavailable. Try again in a minute.");
      }
    } catch (sendError) {
      console.error("Failed sending fallback Telegram message", sendError);
    }
    return res.status(200).json({ ok: true, errorHandled: true });
  }
};
