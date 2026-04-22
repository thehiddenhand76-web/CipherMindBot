const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;
const HELIUS_API_BASE = "https://api.helius.xyz/v0";

const PLANS = {
  monthly_50:  { label: "50 Wallets — Monthly",  sol: 0.30, wallet_limit: 50,  billing: "monthly" },
  monthly_100: { label: "100 Wallets — Monthly", sol: 0.40, wallet_limit: 100, billing: "monthly" },
  monthly_200: { label: "200 Wallets — Monthly", sol: 0.50, wallet_limit: 200, billing: "monthly" },
  yearly_50:   { label: "50 Wallets — Yearly",   sol: 1.20, wallet_limit: 50,  billing: "yearly"  },
  yearly_100:  { label: "100 Wallets — Yearly",  sol: 1.60, wallet_limit: 100, billing: "yearly"  },
  yearly_200:  { label: "200 Wallets — Yearly",  sol: 2.00, wallet_limit: 200, billing: "yearly"  },
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

async function sendTelegramMessageWithButtons(chatId, text, inlineKeyboard) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN"); return; }
  const tgRes = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  });
  const tgData = await tgRes.json().catch(() => ({}));
  if (!tgRes.ok || tgData.ok === false) {
    console.error("Telegram sendMessageWithButtons failed", { status: tgRes.status, data: tgData });
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch("https://api.telegram.org/bot" + token + "/answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || "" }),
  });
}

async function getUserState(telegramUserId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_state").select("state, data")
    .eq("telegram_user_id", String(telegramUserId)).maybeSingle();
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
  const { error } = await supabase.from("user_state").delete().eq("telegram_user_id", String(telegramUserId));
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
      telegram_user_id: telegramUserId, plan_name: "free", wallet_limit: FREE_WALLET_LIMIT, status: "active", expires_at: null,
    });
    if (insertPlanError) throw insertPlanError;
  }
}

async function getUserPlan(telegramUserId) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { data, error } = await supabase.from("plans")
    .select("plan_name, wallet_limit, status, updated_at, expires_at")
    .eq("telegram_user_id", String(telegramUserId)).maybeSingle();
  if (error) throw error;
  return data;
}

async function checkAndExpirePlan(telegramUserId) {
  const plan = await getUserPlan(telegramUserId);
  if (!plan) return plan;
  if (plan.expires_at && new Date(plan.expires_at) < new Date() && plan.plan_name !== "free") {
    await supabase.from("plans").update({
      plan_name: "free", wallet_limit: FREE_WALLET_LIMIT, status: "active", expires_at: null,
    }).eq("telegram_user_id", String(telegramUserId));
    return await getUserPlan(telegramUserId);
  }
  return plan;
}

async function getTrackedWallets(telegramUserId) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { data, error } = await supabase.from("tracked_wallets")
    .select("wallet_address, label, active, created_at")
    .eq("telegram_user_id", String(telegramUserId))
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

async function toggleWalletTracking(telegramUserId, walletAddress, active) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { error } = await supabase.from("tracked_wallets").update({ active: active })
    .eq("telegram_user_id", String(telegramUserId)).eq("wallet_address", walletAddress);
  if (error) throw error;
}

async function removeTrackedWallet(telegramUserId, walletAddress) {
  if (!supabase) throw new Error("Supabase client not initialized");
  const { error } = await supabase.from("tracked_wallets").delete()
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
  const listRes = await fetch(HELIUS_API_BASE + "/webhooks?api-key=" + apiKey);
  const webhooks = await listRes.json().catch(() => []);
  const existing = Array.isArray(webhooks) ? webhooks.find(function(w) { return w.webhookURL === fullUrl; }) : null;
  if (existing) {
    const merged = Array.from(new Set([...(existing.accountAddresses || []), walletAddress]));
    await fetch(HELIUS_API_BASE + "/webhooks/" + existing.webhookID + "?api-key=" + apiKey, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookURL: fullUrl, transactionTypes: existing.transactionTypes || ["Any"], accountAddresses: merged, webhookType: existing.webhookType || "enhanced" }),
    });
  } else {
    await fetch(HELIUS_API_BASE + "/webhooks?api-key=" + apiKey, {
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
  const listRes = await fetch(HELIUS_API_BASE + "/webhooks?api-key=" + apiKey);
  const webhooks = await listRes.json().catch(() => []);
  const existing = Array.isArray(webhooks) ? webhooks.find(function(w) { return w.webhookURL === fullUrl; }) : null;
  if (!existing) return;
  const filtered = (existing.accountAddresses || []).filter(function(a) { return a !== walletAddress; });
  await fetch(HELIUS_API_BASE + "/webhooks/" + existing.webhookID + "?api-key=" + apiKey, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ webhookURL: fullUrl, transactionTypes: existing.transactionTypes || ["Any"], accountAddresses: filtered, webhookType: existing.webhookType || "enhanced" }),
  });
}

async function completeWalletTracking(chatId, telegramUserId, walletAddress, label) {
  const userPlan = await checkAndExpirePlan(telegramUserId);
  if (!userPlan) { await sendTelegramMessage(chatId, "No plan found. Send /start first."); return; }
  if (userPlan.status !== "active") { await sendTelegramMessage(chatId, "Your plan is not active. Contact support."); return; }
  const allWallets = await getTrackedWallets(telegramUserId);
  const activeWallets = allWallets.filter(function(w) { return w.active; });
  if (activeWallets.length >= userPlan.wallet_limit) {
    await sendTelegramMessage(chatId, "Wallet limit reached (" + userPlan.wallet_limit + "). Use /plan to upgrade.");
    return;
  }
  if (allWallets.some(function(w) { return w.wallet_address === walletAddress && w.active; })) {
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

async function sendPlanMenu(chatId) {
  const text =
    "📋 CipherMind Plans\n\n" +
    "Monthly          Wallets\n" +
    "0.30 SOL ———— 50\n" +
    "0.40 SOL ———— 100\n" +
    "0.50 SOL ———— 200\n\n" +
    "Yearly           Wallets\n" +
    "1.20 SOL ———— 50\n" +
    "1.60 SOL ———— 100\n" +
    "2.00 SOL ———— 200\n\n" +
    "Tap a plan to subscribe:";

  const inlineKeyboard = [
    [{ text: "Monthly — 0.30 SOL — 50 Wallets",  callback_data: "plan:monthly_50"  }],
    [{ text: "Monthly — 0.40 SOL — 100 Wallets", callback_data: "plan:monthly_100" }],
    [{ text: "Monthly — 0.50 SOL — 200 Wallets", callback_data: "plan:monthly_200" }],
    [{ text: "——— Yearly ———",                   callback_data: "plan:noop"        }],
    [{ text: "Yearly — 1.20 SOL — 50 Wallets",   callback_data: "plan:yearly_50"   }],
    [{ text: "Yearly — 1.60 SOL — 100 Wallets",  callback_data: "plan:yearly_100"  }],
    [{ text: "Yearly — 2.00 SOL — 200 Wallets",  callback_data: "plan:yearly_200"  }],
  ];

  await sendTelegramMessageWithButtons(chatId, text, inlineKeyboard);
}

async function handlePlanSelection(chatId, callbackQueryId, planKey) {
  await answerCallbackQuery(callbackQueryId, "");
  if (planKey === "noop") return;
  const plan = PLANS[planKey];
  if (!plan) {
    await sendTelegramMessage(chatId, "Invalid plan. Please try /plan again.");
    return;
  }
  const daysText = plan.billing === "yearly" ? "365 days" : "30 days";
  await sendTelegramMessage(
    chatId,
    "✅ You selected: " + plan.label +
    "\nPrice: " + plan.sol.toFixed(2) + " SOL" +
    "\nDuration: " + daysText +
    "\n\nSend exactly " + plan.sol.toFixed(2) + " SOL to:\n\n" + PAYMENT_WALLET +
    "\n\nAfter sending use:\n/verify TRANSACTION_HASH " + planKey +
    "\n\nExample:\n/verify abc123xyz " + planKey
  );
}

module.exports = async function handler(req, res) {
  console.log("Webhook hit", { method: req.method, hasBody: !!req.body });

  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Webhook alive" });
  }

  const body = req.body || {};

  // --- Handle callback queries (button taps) ---
  if (body.callback_query) {
    const cq = body.callback_query;
    const callbackQueryId = cq.id;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const data = cq.data || "";
    try {
      if (data.startsWith("plan:")) {
        const planKey = data.replace("plan:", "");
        await handlePlanSelection(chatId, callbackQueryId, planKey);
      } else {
        await answerCallbackQuery(callbackQueryId, "");
      }
    } catch (e) {
      console.error("Callback query error", e);
      await answerCallbackQuery(callbackQueryId, "");
    }
    return res.status(200).json({ ok: true });
  }

  // --- Handle regular messages ---
  const message = body.message ? body.message : null;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true, message: "No message text" });
  }

  const chatId = message.chat && message.chat.id ? message.chat.id : null;
  const text = (message.text || "").trim();
  const fromUser = message.from;
  const command = getCommand(text);

  console.log("Incoming message", { chatId, command });

  try {
    if (!chatId) return res.status(200).json({ ok: true, message: "Missing chatId" });

    if (!supabase) {
      await sendTelegramMessage(chatId, "Database not configured. Contact support.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/start") {
      if (fromUser) await ensureUserAndFreePlan(fromUser);
      await sendTelegramMessage(chatId, "Welcome to CipherMind. Designed to track wallets on Solana Chain.\n\nPlease select Menu to see commands list.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/help") {
      await sendTelegramMessage(
        chatId,
        "CipherMind Commands:\n\n" +
        "/start — Set up your account\n\n" +
        "/add <wallet_address>\nStep 1: Enter wallet address\nStep 2: Enter wallet name\nTracking begins immediately\n\n" +
        "/untrack <wallet_address> — Pause or resume tracking on a wallet\n\n" +
        "/remove — Permanently remove a wallet\nStep 1: Bot shows numbered list\nStep 2: Enter number to remove. Bot confirms and shows updated list\n\n" +
        "/wallets — View all your tracked wallets with address and name\n\n" +
        "/plan — View subscription plans and subscribe\n\n" +
        "/myplan — View your current active plan\n\n" +
        "/verify TRANSACTION_HASH PLAN — Verify your SOL payment"
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/plan") {
      await sendPlanMenu(chatId);
      return res.status(200).json({ ok: true });
    }

    if (command === "/myplan") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify user."); return res.status(200).json({ ok: true }); }
      const userPlan = await checkAndExpirePlan(String(fromUser.id));
      if (!userPlan) { await sendTelegramMessage(chatId, "No plan found. Send /start first."); return res.status(200).json({ ok: true }); }
      const expiryText = userPlan.expires_at ? "\nExpires: " + formatDate(userPlan.expires_at) : "";
      await sendTelegramMessage(
        chatId,
        "Your Current Plan:\nPlan: " + userPlan.plan_name +
        "\nWallet limit: " + userPlan.wallet_limit +
        "\nStatus: " + userPlan.status + expiryText
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/verify") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify user."); return res.status(200).json({ ok: true }); }
      const args = getArgs(text);
      if (args.length < 2) {
        await sendTelegramMessage(chatId, "Usage: /verify TRANSACTION_HASH PLAN\n\nExample:\n/verify abc123xyz monthly_50\n\nUse /plan to select a plan first.");
        return res.status(200).json({ ok: true });
      }
      const txHash = args[0];
      const planKey = args[1];
      const plan = PLANS[planKey];
      if (!plan) {
        await sendTelegramMessage(chatId, "Invalid plan key. Use /plan to select a plan first.");
        return res.status(200).json({ ok: true });
      }
      await sendTelegramMessage(chatId, "Checking your transaction on the Solana blockchain...");
      try {
        const { data: existingPayment } = await supabase
          .from("pending_payments").select("id, status").eq("id", txHash).maybeSingle();
        if (existingPayment && existingPayment.status === "confirmed") {
          await sendTelegramMessage(chatId, "This transaction has already been used to activate a plan.");
          return res.status(200).json({ ok: true });
        }
        const rpcRes = await fetch("https://api.mainnet-beta.solana.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [txHash, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
          }),
        });
        const txData = await rpcRes.json();
        const tx = txData && txData.result;
        if (!tx) {
          await sendTelegramMessage(chatId, "Transaction not found. Make sure it is confirmed on Solana and try again.");
          return res.status(200).json({ ok: true });
        }
        if (tx.meta && tx.meta.err) {
          await sendTelegramMessage(chatId, "That transaction failed on the blockchain. Please send a successful transaction.");
          return res.status(200).json({ ok: true });
        }
        const instructions = (tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [];
        let receivedLamports = 0;
        let destinationMatched = false;
        for (var i = 0; i < instructions.length; i++) {
          var ix = instructions[i];
          if (ix.parsed && ix.parsed.type === "transfer" && ix.parsed.info && ix.parsed.info.destination === PAYMENT_WALLET) {
            destinationMatched = true;
            receivedLamports += ix.parsed.info.lamports || 0;
          }
        }
        if (!destinationMatched) {
          await sendTelegramMessage(chatId, "Payment was not sent to the correct wallet. Please send to:\n" + PAYMENT_WALLET);
          return res.status(200).json({ ok: true });
        }
        const receivedSOL = receivedLamports / 1e9;
        if (receivedSOL < plan.sol) {
          await sendTelegramMessage(chatId, "Payment too low. Expected " + plan.sol.toFixed(2) + " SOL but received " + receivedSOL.toFixed(4) + " SOL.");
          return res.status(200).json({ ok: true });
        }
        const now = new Date();
        const days = plan.billing === "yearly" ? 365 : 30;
        const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
        await supabase.from("plans").update({
          plan_name: planKey, wallet_limit: plan.wallet_limit, status: "active", expires_at: expiresAt.toISOString(),
        }).eq("telegram_user_id", String(fromUser.id));
        await supabase.from("pending_payments").upsert({
          id: txHash, telegram_user_id: String(fromUser.id), plan_requested: planKey,
          amount: receivedSOL, bill_cycle: plan.billing, status: "confirmed",
        });
        await sendTelegramMessage(
          chatId,
          "✅ Payment confirmed!\n\nPlan: " + plan.label +
          "\nWallet limit: " + plan.wallet_limit +
          "\nExpires: " + formatDate(expiresAt) +
          "\n\nUse /add to start tracking wallets."
        );
      } catch (verifyError) {
        console.error("Verify error", verifyError);
        await sendTelegramMessage(chatId, "Could not verify transaction. Please try again in a moment.");
      }
      return res.status(200).json({ ok: true });
    }

    if (command === "/add") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return res.status(200).json({ ok: true }); }
      await clearUserState(String(fromUser.id));
      const args = getArgs(text);
      const walletAddress = args[0];
      if (!walletAddress) {
        await setUserState(String(fromUser.id), "awaiting_wallet_address", { chat_id: String(chatId) });
        await sendTelegramMessage(chatId, "Step 1: Enter your Solana wallet address to track:");
        return res.status(200).json({ ok: true });
      }
      if (!isValidSolanaAddress(walletAddress)) {
        await sendTelegramMessage(chatId, "Invalid Solana address. Please check and try again.");
        return res.status(200).json({ ok: true });
      }
      await setUserState(String(fromUser.id), "awaiting_wallet_name", { wallet_address: walletAddress, chat_id: String(chatId) });
      await sendTelegramMessage(chatId, "Step 2: What would you like to name this wallet?\n\nWallet: " + shortenAddress(walletAddress));
      return res.status(200).json({ ok: true });
    }

    if (command === "/untrack") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return res.status(200).json({ ok: true }); }
      const walletAddress = getArgs(text)[0];
      if (!walletAddress) {
        await sendTelegramMessage(chatId, "Usage: /untrack <wallet_address>\n\nUse /wallets to see your list.");
        return res.status(200).json({ ok: true });
      }
      const telegramUserId = String(fromUser.id);
      const allWallets = await getTrackedWallets(telegramUserId);
      const wallet = allWallets.find(function(w) { return w.wallet_address === walletAddress; });
      if (!wallet) {
        await sendTelegramMessage(chatId, shortenAddress(walletAddress) + " is not in your list.");
        return res.status(200).json({ ok: true });
      }
      const newState = !wallet.active;
      await toggleWalletTracking(telegramUserId, walletAddress, newState);
      if (!newState) await unregisterWalletFromHelius(walletAddress);
      if (newState) await registerWalletWithHelius(walletAddress);
      await sendTelegramMessage(
        chatId,
        "Tracking " + (newState ? "resumed" : "paused") + " for " + shortenAddress(walletAddress) + (wallet.label ? ' ("' + wallet.label + '")' : "") + "."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/remove") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return res.status(200).json({ ok: true }); }
      const telegramUserId = String(fromUser.id);
      const allWallets = await getTrackedWallets(telegramUserId);
      if (!allWallets.length) {
        await sendTelegramMessage(chatId, "You have no wallets to remove.");
        return res.status(200).json({ ok: true });
      }
      const formatted = allWallets.map(function(w, i) {
        return (i + 1) + ". " + w.wallet_address + (w.label ? ' — "' + w.label + '"' : "") + (w.active ? "" : " [paused]");
      }).join("\n");
      await setUserState(telegramUserId, "awaiting_remove_selection", { wallets: allWallets, chat_id: String(chatId) });
      await sendTelegramMessage(chatId, "Your Wallets:\n\n" + formatted + "\n\nPlease enter the number of the wallet to remove.\nOr send /cancel to stop.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/wallets") {
      if (!fromUser) { await sendTelegramMessage(chatId, "Could not identify your account."); return res.status(200).json({ ok: true }); }
      const telegramUserId = String(fromUser.id);
      const userPlan = await checkAndExpirePlan(telegramUserId);
      const allWallets = await getTrackedWallets(telegramUserId);
      if (!allWallets.length) {
        await sendTelegramMessage(chatId, "No wallets added yet.\n\nUse /add <wallet_address> to start tracking.");
        return res.status(200).json({ ok: true });
      }
      const limit = userPlan ? userPlan.wallet_limit : FREE_WALLET_LIMIT;
      const activeCount = allWallets.filter(function(w) { return w.active; }).length;
      const lines = ["Your Tracked Wallets (" + activeCount + "/" + limit + " active):\n"];
      allWallets.forEach(function(w, i) {
        lines.push((i + 1) + ". " + w.wallet_address + (w.label ? ' — "' + w.label + '"' : "") + (w.active ? "" : " [paused]"));
      });
      lines.push("\n/untrack <address> — pause or resume\n/remove — permanently delete");
      await sendTelegramMessage(chatId, lines.join("\n"));
      return res.status(200).json({ ok: true });
    }

    if (command === "/cancel") {
      if (fromUser) await clearUserState(String(fromUser.id));
      await sendTelegramMessage(chatId, "Cancelled.");
      return res.status(200).json({ ok: true });
    }

    // --- Session / state handling ---
    if (fromUser && !command) {
      const telegramUserId = String(fromUser.id);
      const userState = await getUserState(telegramUserId);

      if (userState && userState.state === "awaiting_wallet_address") {
        if (!isValidSolanaAddress(text)) {
          await sendTelegramMessage(chatId, "That does not look like a valid Solana address. Please try again or send /cancel.");
          return res.status(200).json({ ok: true });
        }
        await setUserState(telegramUserId, "awaiting_wallet_name", { wallet_address: text, chat_id: String(chatId) });
        await sendTelegramMessage(chatId, "Step 2: What would you like to name this wallet?\n\nWallet: " + shortenAddress(text));
        return res.status(200).json({ ok: true });
      }

      if (userState && userState.state === "awaiting_wallet_name") {
        const walletAddress = userState.data && userState.data.wallet_address;
        if (!walletAddress) {
          await clearUserState(telegramUserId);
          await sendTelegramMessage(chatId, "Something went wrong. Please try /add again.");
          return res.status(200).json({ ok: true });
        }
        await clearUserState(telegramUserId);
        await completeWalletTracking(chatId, telegramUserId, walletAddress, text);
        return res.status(200).json({ ok: true });
      }

      if (userState && userState.state === "awaiting_remove_selection") {
        const wallets = userState.data && userState.data.wallets;
        const selection = parseInt(text, 10);
        if (!wallets || isNaN(selection) || selection < 1 || selection > wallets.length) {
          await sendTelegramMessage(chatId, "Please enter a valid number from the list, or send /cancel to stop.");
          return res.status(200).json({ ok: true });
        }
        const walletToRemove = wallets[selection - 1];
        await clearUserState(telegramUserId);
        await removeTrackedWallet(telegramUserId, walletToRemove.wallet_address);
        await unregisterWalletFromHelius(walletToRemove.wallet_address);
        const remaining = await getTrackedWallets(telegramUserId);
        if (!remaining.length) {
          await sendTelegramMessage(chatId, "Wallet removed. You have no more tracked wallets.\n\nUse /add to add one.");
          return res.status(200).json({ ok: true });
        }
        const lines = ["Wallet removed. Updated list:\n"];
        remaining.forEach(function(w, i) {
          lines.push((i + 1) + ". " + w.wallet_address + (w.label ? ' — "' + w.label + '"' : "") + (w.active ? "" : " [paused]"));
        });
        await sendTelegramMessage(chatId, lines.join("\n"));
        return res.status(200).json({ ok: true });
      }
    }

    if (isValidSolanaAddress(text)) {
      await sendTelegramMessage(chatId, "To track this wallet use:\n/add " + text);
      return res.status(200).json({ ok: true });
    }

    await sendTelegramMessage(chatId, "Unknown command. Use /help to see all available commands.");
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("Webhook handler error", error);
    try {
      if (chatId) await sendTelegramMessage(chatId, "CipherMind is temporarily unavailable. Try again.");
    } catch (e) { console.error(e); }
    return res.status(200).json({ ok: true, errorHandled: true });
  }
};
