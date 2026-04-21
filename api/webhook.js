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
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

function formatDate(date) { return new Date(date).toLocaleString(); }

function getCommand(text) {
  const clean = (text || "").trim();
  if (!clean.startsWith("/")) return "";
  return clean.split(/\s+/)[0].split("@")[0].toLowerCase();
}

function getArgs(text) {
  return (text || "").trim().split(/\s+/).slice(1);
}

function shortenAddress(addr, len = 6) {
  if (!addr || addr.length <= len * 2 + 3) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

function isValidSolanaAddress(address) {
  return typeof address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN"); return; }
  const tgRes = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
  });
  const tgData = await tgRes.json().catch(() => ({}));
  if (!tgRes.ok || tgData.ok === false) {
    console.error("Telegram sendMessage failed", { status: tgRes.status, data: tgData });
  }
}

async function getUserState(telegramUserId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_state")
    .select("state, data")
    .eq("telegram_user_id", String(telegramUserId))
    .maybeSingle();
  if (error) { console.error("getUserState error", error); return null; }
  return data;
}

async function setUserState(telegramUserId, state, data) {
  if (!supabase) return;
  const { error } = await supabase.from("user_state").upsert(
    { telegram_user_id: String(telegramUserId), state: state, data: data, updated_at: new Date().toISOString() },
    { onConflict: "telegram_user_id" }
  );
  if (error) console.error("setUserState error", error);
}

async function clearUserState(telegramUserId) {
  if (!supabase) return;
  const { error } = await supabase
    .from("user_state")
    .delete()
    .eq("telegram_user_id", String(telegramUserId));
  if (error) console.error("clearUserState error", error);
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
    .from("plans").select("telegram_user_id").eq("telegram_user_id", telegramUserId).maybeSingle();
  if (existingPlanError) throw existingPlanError;
  if (!existingPlan) {
    const { error: insertPlanError } = await supabase.from("plans").insert({
      telegram_user_id: telegramUserId, plan_name: "free", wallet_limit: FREE_WALLET_LIMIT, status: "active",
    });
    if (insertPlanError) throw insertPlanError;
  }
}

async function getUserPlan(telegramUserId) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { data, error } = await supabase.from("plans")
    .select("plan_name, wallet_limit, status, updated_at")
    .eq("telegram_user_id", String(telegramUserId)).maybeSingle();
  if (error) throw error;
  return data;
}

async function getTrackedWallets(telegramUserId) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { data, error } = await supabase.from("tracked_wallets")
    .select("wallet_address, label, created_at")
    .eq("telegram_user_id", String(telegramUserId)).eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addTrackedWallet(telegramUserId, chatId, walletAddress, label) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { error } = await supabase.from("tracked_wallets").upsert(
    { telegram_user_id: String(telegramUserId), telegram_chat_id: String(chatId), wallet_address: walletAddress, label: label || null, active: true },
    { onConflict: "telegram_user_id,wallet_address" }
  );
  if (error) throw error;
}

async function removeTrackedWallet(telegramUserId, walletAddress) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { error } = await supabase.from("tracked_wallets").update({ active: false })
    .eq("telegram_user_id", String(telegramUserId)).eq("wallet_address", walletAddress);
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
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookURL: fullUrl, transactionTypes: existing.transactionTypes || ["Any"], accountAddresses: merged, webhookType: existing.webhookType || "enhanced" }),
    });
  } else {
    await fetch(`${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookURL: fullUrl, transactionTypes: ["Any"], accountAddresses: [walletAddress], webhookType: "enhanced" }),
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
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhookURL: fullUrl, transactionTypes: existing.transactionTypes || ["Any"], accountAddresses: filtered, webhookType: existing.webhookType || "enhanced" }),
  });
}

async function completeWalletTracking(chatId, telegramUserId, walletAddress, label) {
  const userPlan = await getUserPlan(telegramUserId);
  if (!userPlan) { await sendTelegramMessage(chatId, "No plan found. Send /start first."); return; }
  if (userPlan.status !== "active") { await sendTelegramMessage(chatId, "Your plan is not active. Contact support."); return; }
  const existing = await getTrackedWallets(telegramUserId);
  if (existing.length >= userPlan.wallet_limit) {
    await sendTelegramMessage(chatId, "Wallet limit reached (" + userPlan.wallet_limit + "). Use /pricing to upgrade.");
    return;
  }
  if (existing.some((w) => w.wallet_address === walletAddress)) {
    await sendTelegramMessage(chatId, "Already tracking " + shortenAddress(walletAddress) + ".");
    return;
  }
  await addTrackedWallet(telegramUserId, chatId, walletAddress, label);
  await registerWalletWithHelius(walletAddress);
  await sendTelegramMessage(
    chatId,
    "Tracking started!\n\nWallet: " + shortenAddress(walletAddress) + '\nName: "' + label + '"\n\nYou will receive alerts when this wallet has activity.'
  );
}

async function handleAdd(chatId, fromUser, text) {
  if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return; }
  const args = getArgs(text);
  const walletAddress = args[0];
  if (!walletAddress) {
    await sendTelegramMessage(chatId, "Please provide a wallet address.\n\nUsage: /add <wallet_address>");
    return;
  }
  if (!isValidSolanaAddress(walletAddress)) {
    await sendTelegramMessage(chatId, "Invalid Solana address. Please check and try again.");
    return;
  }
  const telegramUserId = String(fromUser.id);
  await setUserState(telegramUserId, "awaiting_wallet_name", { wallet_address: walletAddress, chat_id: String(chatId) });
  await sendTelegramMessage(chatId, "Wallet found: " + shortenAddress(walletAddress) + "\n\nWhat would you like to name this wallet?");
}

async function handleUntrack(chatId, fromUser, text) {
  if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return; }
  const walletAddress = getArgs(text)[0];
  if (!walletAddress) {
    await sendTelegramMessage(chatId, "Usage: /untrack <wallet_address>\n\nUse /wallets to see your list.");
    return;
  }
  const telegramUserId = String(fromUser.id);
  const existing = await getTrackedWallets(telegramUserId);
  if (!existing.find((w) => w.wallet_address === walletAddress)) {
    await sendTelegramMessage(chatId, shortenAddress(walletAddress) + " is not in your tracked list.");
    return;
  }
  await removeTrackedWallet(telegramUserId, walletAddress);
  await unregisterWalletFromHelius(walletAddress);
  await sendTelegramMessage(chatId, "Stopped tracking " + shortenAddress(walletAddress) + ".");
}

async function handleWallets(chatId, fromUser) {
  if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return; }
  const telegramUserId = String(fromUser.id);
  const wallets = await getTrackedWallets(telegramUserId);
  const userPlan = await getUserPlan(telegramUserId);
  if (wallets.length === 0) {
    await sendTelegramMessage(chatId, "No wallets tracked yet.\n\nUse /add <wallet_address> to start.");
    return;
  }
  const limit = userPlan ? userPlan.wallet_limit : FREE_WALLET_LIMIT;
  const lines = ["Your Tracked Wallets (" + wallets.length + "/" + limit + "):"];
  wallets.forEach((w, i) => {
    lines.push((i + 1) + ". " + shortenAddress(w.wallet_address) + (w.label ? ' — "' + w.label + '"' : ""));
  });
  lines.push("\nUse /untrack <wallet_address> to remove.");
  await sendTelegramMessage(chatId, lines.join("\n"));
}

module.exports = async function handler(req, res) {
  console.log("Webhook hit", { method: req.method, hasBody: !!req.body });

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Webhook alive" });
  }

  const message = req.body && req.body.message ? req.body.message : null;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true, message: "No message text" });
  }

  const chatId = message.chat && message.chat.id ? message.chat.id : null;
  const text = (message.text || "").trim();
  const fromUser = message.from;
  const command = getCommand(text);
  const textLower = text.toLowerCase();

  console.log("Incoming message", { chatId, command });

  try {
    if (!chatId) return res.status(200).json({ ok: true, message: "Missing chatId" });

    if (!supabase) {
      await sendTelegramMessage(chatId, "Database not configured. Contact support.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/start") {
      if (fromUser) await ensureUserAndFreePlan(fromUser);
      await sendTelegramMessage(
        chatId,
        "Hello! I'm CipherMind.\n\nCommands:\n/add <address> — add a wallet to track\n/untrack <address> — stop tracking a wallet\n/wallets — list your tracked wallets\n/plan — your current plan\n/pricing — subscription plans\n/payment — payment wallet"
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pricing") {
      await sendTelegramMessage(
        chatId,
        "Subscription Plans:\n\nFree: " + FREE_WALLET_LIMIT + " wallets\n50 wallets: " + PLANS[50].monthly.toFixed(2) + " SOL/month\n100 wallets: " + PLANS[100].monthly.toFixed(2) + " SOL/month\n200 wallets: " + PLANS[200].monthly.toFixed(2) + " SOL/month\n\nUse /payment to pay."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/payment") {
      await sendTelegramMessage(chatId, "Payment Wallet:\n" + PAYMENT_WALLET + "\n\nSend SOL only to this wallet for monthly access.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/plan") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify user."); return res.status(200).json({ ok: true }); }
      const userPlan = await getUserPlan(fromUser.id);
      if (!userPlan) { await sendTelegramMessage(chatId, "No plan found. Send /start first."); return res.status(200).json({ ok: true }); }
      await sendTelegramMessage(
        chatId,
        "Your Current Plan:\nPlan: " + userPlan.plan_name + "\nWallet limit: " + userPlan.wallet_limit + "\nStatus: " + userPlan.status + "\nUpdated: " + formatDate(userPlan.updated_at)
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pay") {
      await sendTelegramMessage(chatId, "Send SOL to:\n" + PAYMENT_WALLET + "\n\nThen contact support with your plan: 50, 100, or 200 wallets.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/add" || textLower.startsWith("/add ") || textLower === "/add") {
      if (fromUser) await clearUserState(String(fromUser.id));
      await handleAdd(chatId, fromUser, text);
      return res.status(200).json({ ok: true });
    }

    if (command === "/untrack" || textLower.startsWith("/untrack ") || textLower === "/untrack") {
      if (fromUser) await clearUserState(String(fromUser.id));
      await handleUntrack(chatId, fromUser, text);
      return res.status(200).json({ ok: true });
    }

    if (command === "/wallets" || textLower === "/wallets") {
      await handleWallets(chatId, fromUser);
      return res.status(200).json({ ok: true });
    }

    if (fromUser && !command) {
      const telegramUserId = String(fromUser.id);
      const userState = await getUserState(telegramUserId);

      if (userState && userState.state === "awaiting_wallet_name") {
        const walletAddress = userState.data && userState.data.wallet_address;
        const label = text;
        if (!walletAddress) {
          await clearUserState(telegramUserId);
          await sendTelegramMessage(chatId, "Something went wrong. Please try /add again.");
          return res.status(200).json({ ok: true });
        }
        await clearUserState(telegramUserId);
        await completeWalletTracking(chatId, telegramUserId, walletAddress, label);
        return res.status(200).json({ ok: true });
      }
    }

    if (isValidSolanaAddress(text)) {
      await sendTelegramMessage(chatId, "To track this wallet use:\n/add " + text);
      return res.status(200).json({ ok: true });
    }

    await sendTelegramMessage(chatId, "Unknown command. Use /start to see all available commands.");
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Webhook handler error", error);
    try {
      if (chatId) await sendTelegramMessage(chatId, "CipherMind is temporarily unavailable. Try again.");
    } catch (e) { console.error(e); }
    return res.status(200).json({ ok: true, errorHandled: true });
  }
};
