const { createClient } = require("@supabase/supabase-js");

const HELIUS_API_BASE = "https://api.helius.xyz/v0";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1000000000;

const supabase =
  process.env.SUPABASEURL && process.env.SUPABASESERVICEROLEKEY
    ? createClient(process.env.SUPABASEURL, process.env.SUPABASESERVICEROLEKEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

function shortenAddress(addr, len) {
  len = len || 6;
  if (!addr || addr.length <= len * 2 + 3) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

function formatAmount(amount, decimals) {
  decimals = decimals || 9;
  var value = amount / Math.pow(10, decimals);
  if (value >= 1000000) return (value / 1000000).toFixed(2) + "M";
  if (value >= 1000) return (value / 1000).toFixed(2) + "K";
  return value.toFixed(value < 0.01 ? 6 : 4);
}

function formatUSD(value) {
  if (!value && value !== 0) return "";
  if (value >= 1000000) return " ($" + (value / 1000000).toFixed(2) + "M)";
  if (value >= 1000) return " ($" + (value / 1000).toFixed(2) + "K)";
  return " ($" + value.toFixed(2) + ")";
}

function explorerLink(signature) {
  return "https://solscan.io/tx/" + signature;
}

async function sendTelegramMessage(chatId, text) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch(function(e) { console.error("sendTelegramMessage error", e); });
}

async function sendTelegramMessageWithButtons(chatId, text, inlineKeyboard) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  }).catch(function(e) { console.error("sendTelegramMessageWithButtons error", e); });
}

// Get stored webhook ID from settings table
async function getStoredWebhookId() {
  if (!supabase) return null;
  var result = await supabase.from("settings").select("value").eq("key", "helius_webhook_id").maybeSingle();
  if (result.error || !result.data) return null;
  return result.data.value;
}

// Store webhook ID in settings table
async function storeWebhookId(webhookId) {
  if (!supabase) return;
  await supabase.from("settings").upsert({ key: "helius_webhook_id", value: webhookId }, { onConflict: "key" });
}

// Get all active wallet addresses from DB
async function getAllActiveWallets() {
  if (!supabase) return [];
  var result = await supabase.from("tracked_wallets").select("wallet_address").eq("active", true);
  if (result.error) return [];
  return (result.data || []).map(function(r) { return r.wallet_address; });
}

async function getActiveSubscribersForWallet(walletAddress) {
  if (!supabase) return [];
  var result = await supabase
    .from("tracked_wallets")
    .select("telegram_user_id, telegram_chat_id, label")
    .eq("wallet_address", walletAddress)
    .eq("active", true);
  if (result.error) {
    console.error("getActiveSubscribersForWallet error", result.error);
    return [];
  }
  return result.data || [];
}

// Register or update Helius webhook using stored ID
async function registerWalletWithHelius(walletAddress) {
  var apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) { console.error("Missing HELIUS_API_KEY"); return; }
  var webhookUrl = process.env.HELIUS_WEBHOOK_URL;
  if (!webhookUrl) { console.error("Missing HELIUS_WEBHOOK_URL"); return; }

  try {
    var storedId = await getStoredWebhookId();
    var allWallets = await getAllActiveWallets();

    // Make sure new wallet is included
    if (!allWallets.includes(walletAddress)) {
      allWallets.push(walletAddress);
    }

    if (storedId) {
      // Update existing webhook
      var updateRes = await fetch(HELIUS_API_BASE + "/webhooks/" + storedId + "?api-key=" + apiKey, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ["Any"],
          accountAddresses: allWallets,
          webhookType: "enhanced",
        }),
      });
      var updateData = await updateRes.json().catch(() => ({}));
      if (!updateRes.ok) {
        console.error("Failed to update Helius webhook", updateData);
        // Stored ID may be stale — clear it and create new
        await storeWebhookId(null);
        storedId = null;
      } else {
        console.log("Helius webhook updated, wallets:", allWallets.length);
        return;
      }
    }

    if (!storedId) {
      // Create new webhook
      var createRes = await fetch(HELIUS_API_BASE + "/webhooks?api-key=" + apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhookURL: webhookUrl,
          transactionTypes: ["Any"],
          accountAddresses: allWallets,
          webhookType: "enhanced",
        }),
      });
      var createData = await createRes.json().catch(() => ({}));
      if (createData && createData.webhookID) {
        await storeWebhookId(createData.webhookID);
        console.log("Helius webhook created, ID:", createData.webhookID);
      } else {
        console.error("Failed to create Helius webhook", createData);
      }
    }
  } catch (e) {
    console.error("registerWalletWithHelius error", e);
  }
}

// Remove wallet from Helius webhook
async function unregisterWalletFromHelius(walletAddress) {
  var apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return;
  var webhookUrl = process.env.HELIUS_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    var storedId = await getStoredWebhookId();
    if (!storedId) { console.error("No stored Helius webhook ID"); return; }

    var allWallets = await getAllActiveWallets();
    var filtered = allWallets.filter(function(a) { return a !== walletAddress; });

    await fetch(HELIUS_API_BASE + "/webhooks/" + storedId + "?api-key=" + apiKey, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webhookURL: webhookUrl,
        transactionTypes: ["Any"],
        accountAddresses: filtered,
        webhookType: "enhanced",
      }),
    });
    console.log("Helius webhook updated after removal, wallets:", filtered.length);
  } catch (e) {
    console.error("unregisterWalletFromHelius error", e);
  }
}

var tokenMetaCache = new Map();

async function getTokenMeta(mint) {
  if (!mint || mint === SOL_MINT) return { symbol: "SOL", name: "Solana", decimals: 9 };
  if (tokenMetaCache.has(mint)) return tokenMetaCache.get(mint);
  var apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { symbol: shortenAddress(mint, 4), name: mint, decimals: 6 };
  try {
    var res = await fetch("https://mainnet.helius-rpc.com/?api-key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "get-asset", method: "getAsset", params: { id: mint } }),
    });
    var json = await res.json();
    var r = json && json.result;
    var meta = {
      symbol: (r && r.content && r.content.metadata && r.content.metadata.symbol) || shortenAddress(mint, 4),
      name: (r && r.content && r.content.metadata && r.content.metadata.name) || mint,
      decimals: (r && r.token_info && r.token_info.decimals != null) ? r.token_info.decimals : 6,
      price: (r && r.token_info && r.token_info.price_info && r.token_info.price_info.price_per_token) || null,
    };
    tokenMetaCache.set(mint, meta);
    return meta;
  } catch (e) {
    console.error("getTokenMeta error", e);
    return { symbol: shortenAddress(mint, 4), name: mint, decimals: 6 };
  }
}

function buildTradeButtons(mint) {
  return [[
    { text: "📊 DEX Screener", url: "https://dexscreener.com/solana/" + mint },
    { text: "🎯 Pump.fun", url: "https://pump.fun/coin/" + mint },
  ],[
    { text: "⚡ Axiom", url: "https://axiom.trade/t/" + mint },
    { text: "🔆 Photon", url: "https://photon-sol.tinyastro.io/en/lp/" + mint },
  ]];
}

async function formatBuyAlert(tx, trackedWallet, label) {
  var sig = tx.signature;
  var swapEvent = tx.events && tx.events.swap;
  var solAmount = 0;
  var tokenAmount = 0;
  var tokenMint = null;
  var tokenSymbol = "TOKEN";
  var tokenPrice = null;

  if (swapEvent) {
    var nativeIn = swapEvent.nativeInput;
    var tokenOut = swapEvent.tokenOutputs && swapEvent.tokenOutputs[0];
    if (nativeIn) solAmount = nativeIn.amount / LAMPORTS_PER_SOL;
    if (tokenOut) {
      tokenMint = tokenOut.mint;
      var meta = await getTokenMeta(tokenMint);
      tokenSymbol = meta.symbol;
      tokenAmount = tokenOut.tokenAmount;
      tokenPrice = meta.price;
    }
  } else {
    var nTransfers = tx.nativeTransfers || [];
    var tTransfers = tx.tokenTransfers || [];
    for (var i = 0; i < nTransfers.length; i++) {
      if (nTransfers[i].fromUserAccount === trackedWallet) {
        solAmount += nTransfers[i].amount / LAMPORTS_PER_SOL;
      }
    }
    for (var j = 0; j < tTransfers.length; j++) {
      if (tTransfers[j].toUserAccount === trackedWallet) {
        tokenMint = tTransfers[j].mint;
        var m = await getTokenMeta(tokenMint);
        tokenSymbol = m.symbol;
        tokenAmount = tTransfers[j].tokenAmount;
        tokenPrice = m.price;
      }
    }
  }

  var usdValue = tokenPrice && tokenAmount ? formatUSD(tokenPrice * tokenAmount) : "";
  var mcap = tokenPrice ? formatUSD(tokenPrice * 1000000000) : "";

  var text =
    "🟢 <b>BUY " + tokenSymbol + "</b>\n" +
    "💎 " + (label ? label : shortenAddress(trackedWallet)) + "\n\n" +
    "💎 " + (label ? label : shortenAddress(trackedWallet)) +
    " swapped <b>" + solAmount.toFixed(4) + " SOL</b> for\n" +
    "<b>" + (tokenAmount ? tokenAmount.toFixed(2) : "?") + usdValue + " " + tokenSymbol + "</b>" +
    (tokenPrice ? " @$" + tokenPrice.toFixed(8) : "") + "\n\n" +
    (mcap ? "🪙 #" + tokenSymbol + " | MC: " + mcap + "\n" : "🪙 #" + tokenSymbol + "\n") +
    (tokenMint ? tokenMint : "");

  var buttons = tokenMint ? buildTradeButtons(tokenMint) : [];
  buttons.push([{ text: "🔍 View Transaction", url: explorerLink(sig) }]);

  return { text: text, buttons: buttons };
}

async function formatSellAlert(tx, trackedWallet, label) {
  var sig = tx.signature;
  var swapEvent = tx.events && tx.events.swap;
  var solAmount = 0;
  var tokenAmount = 0;
  var tokenMint = null;
  var tokenSymbol = "TOKEN";
  var tokenPrice = null;

  if (swapEvent) {
    var nativeOut = swapEvent.nativeOutput;
    var tokenIn = swapEvent.tokenInputs && swapEvent.tokenInputs[0];
    if (nativeOut) solAmount = nativeOut.amount / LAMPORTS_PER_SOL;
    if (tokenIn) {
      tokenMint = tokenIn.mint;
      var meta = await getTokenMeta(tokenMint);
      tokenSymbol = meta.symbol;
      tokenAmount = tokenIn.tokenAmount;
      tokenPrice = meta.price;
    }
  } else {
    var nTransfers = tx.nativeTransfers || [];
    var tTransfers = tx.tokenTransfers || [];
    for (var i = 0; i < nTransfers.length; i++) {
      if (nTransfers[i].toUserAccount === trackedWallet) {
        solAmount += nTransfers[i].amount / LAMPORTS_PER_SOL;
      }
    }
    for (var j = 0; j < tTransfers.length; j++) {
      if (tTransfers[j].fromUserAccount === trackedWallet) {
        tokenMint = tTransfers[j].mint;
        var m = await getTokenMeta(tokenMint);
        tokenSymbol = m.symbol;
        tokenAmount = tTransfers[j].tokenAmount;
        tokenPrice = m.price;
      }
    }
  }

  var usdValue = tokenPrice && tokenAmount ? formatUSD(tokenPrice * tokenAmount) : "";
  var mcap = tokenPrice ? formatUSD(tokenPrice * 1000000000) : "";

  var text =
    "🔴 <b>SELL " + tokenSymbol + "</b>\n" +
    "💎 " + (label ? label : shortenAddress(trackedWallet)) + "\n\n" +
    "💎 " + (label ? label : shortenAddress(trackedWallet)) +
    " swapped <b>" + (tokenAmount ? tokenAmount.toFixed(2) : "?") + usdValue + " " + tokenSymbol + "</b> for\n" +
    "<b>" + solAmount.toFixed(4) + " SOL</b>" +
    (tokenPrice ? " @$" + tokenPrice.toFixed(8) : "") + "\n\n" +
    (mcap ? "🪙 #" + tokenSymbol + " | MC: " + mcap + "\n" : "🪙 #" + tokenSymbol + "\n") +
    (tokenMint ? tokenMint : "");

  var buttons = tokenMint ? buildTradeButtons(tokenMint) : [];
  buttons.push([{ text: "🔍 View Transaction", url: explorerLink(sig) }]);

  return { text: text, buttons: buttons };
}

async function formatSwapAlert(tx, trackedWallet, label) {
  var sig = tx.signature;
  var swapEvent = tx.events && tx.events.swap;
  var inSymbol = "?", outSymbol = "?";
  var inAmount = 0, outAmount = 0;
  var outMint = null;
  var outPrice = null;

  if (swapEvent) {
    var tokenIn = swapEvent.tokenInputs && swapEvent.tokenInputs[0];
    var tokenOut = swapEvent.tokenOutputs && swapEvent.tokenOutputs[0];
    if (tokenIn) { var mi = await getTokenMeta(tokenIn.mint); inSymbol = mi.symbol; inAmount = tokenIn.tokenAmount; }
    if (tokenOut) {
      var mo = await getTokenMeta(tokenOut.mint);
      outSymbol = mo.symbol; outAmount = tokenOut.tokenAmount;
      outMint = tokenOut.mint; outPrice = mo.price;
    }
  }

  var mcap = outPrice ? formatUSD(outPrice * 1000000000) : "";

  var text =
    "🔄 <b>SWAP</b>\n" +
    "💎 " + (label ? label : shortenAddress(trackedWallet)) + "\n\n" +
    "💎 " + (label ? label : shortenAddress(trackedWallet)) +
    " swapped <b>" + inAmount.toFixed(2) + " " + inSymbol + "</b>\n" +
    "for <b>" + outAmount.toFixed(2) + " " + outSymbol + "</b>\n\n" +
    (outMint ? (mcap ? "🪙 #" + outSymbol + " | MC: " + mcap + "\n" : "🪙 #" + outSymbol + "\n") + outMint : "") +
    "\n\n" + explorerLink(sig);

  return { text: text, buttons: [] };
}

async function formatTransferAlert(tx, trackedWallet, label) {
  var sig = tx.signature;
  var nTransfers = tx.nativeTransfers || [];
  var tTransfers = tx.tokenTransfers || [];
  var lines = [];

  var outgoing = nTransfers.filter(function(t) { return t.fromUserAccount === trackedWallet; });
  var incoming = nTransfers.filter(function(t) { return t.toUserAccount === trackedWallet; });
  var outgoingTokens = tTransfers.filter(function(t) { return t.fromUserAccount === trackedWallet; });
  var incomingTokens = tTransfers.filter(function(t) { return t.toUserAccount === trackedWallet; });

  var direction = (outgoing.length > 0 || outgoingTokens.length > 0) ? "OUT" : "IN";
  var emoji = direction === "OUT" ? "📤" : "📥";
  var action = direction === "OUT" ? "TRANSFER OUT" : "TRANSFER IN";

  lines.push(emoji + " <b>" + action + "</b>");
  lines.push("💎 " + (label ? label : shortenAddress(trackedWallet)));
  lines.push("");

  if (outgoing.length > 0) {
    var solAmt = outgoing.reduce(function(s, t) { return s + t.amount; }, 0) / LAMPORTS_PER_SOL;
    var to = outgoing[0].toUserAccount;
    lines.push("💎 " + (label ? label : shortenAddress(trackedWallet)) + " sent <b>" + solAmt.toFixed(4) + " SOL</b>");
    lines.push("To: " + shortenAddress(to));
  }
  if (incoming.length > 0) {
    var solAmt2 = incoming.reduce(function(s, t) { return s + t.amount; }, 0) / LAMPORTS_PER_SOL;
    var from = incoming[0].fromUserAccount;
    lines.push("💎 " + (label ? label : shortenAddress(trackedWallet)) + " received <b>" + solAmt2.toFixed(4) + " SOL</b>");
    lines.push("From: " + shortenAddress(from));
  }
  for (var i = 0; i < outgoingTokens.length; i++) {
    var tt = outgoingTokens[i];
    var meta = await getTokenMeta(tt.mint);
    lines.push("💎 " + (label ? label : shortenAddress(trackedWallet)) + " sent <b>" + tt.tokenAmount.toFixed(2) + " " + meta.symbol + "</b>");
    lines.push("To: " + shortenAddress(tt.toUserAccount));
    if (tt.mint) { lines.push("🪙 #" + meta.symbol); lines.push(tt.mint); }
  }
  for (var j = 0; j < incomingTokens.length; j++) {
    var tt2 = incomingTokens[j];
    var meta2 = await getTokenMeta(tt2.mint);
    lines.push("💎 " + (label ? label : shortenAddress(trackedWallet)) + " received <b>" + tt2.tokenAmount.toFixed(2) + " " + meta2.symbol + "</b>");
    lines.push("From: " + shortenAddress(tt2.fromUserAccount));
    if (tt2.mint) { lines.push("🪙 #" + meta2.symbol); lines.push(tt2.mint); }
  }

  lines.push("");
  lines.push(explorerLink(sig));

  return { text: lines.join("\n"), buttons: [] };
}

function classifyTransaction(tx, trackedWallet) {
  var type = (tx.type || "").toUpperCase();
  if (type === "SWAP") return "SWAP";
  if (type === "TRANSFER") return "TRANSFER";
  if (tx.events && tx.events.swap) return "SWAP";

  var inTokens = (tx.tokenTransfers || []).filter(function(t) { return t.toUserAccount === trackedWallet; });
  var outTokens = (tx.tokenTransfers || []).filter(function(t) { return t.fromUserAccount === trackedWallet; });
  var inNative = (tx.nativeTransfers || []).filter(function(t) { return t.toUserAccount === trackedWallet; });
  var outNative = (tx.nativeTransfers || []).filter(function(t) { return t.fromUserAccount === trackedWallet; });

  var hasIn = inTokens.length > 0 || inNative.length > 0;
  var hasOut = outTokens.length > 0 || outNative.length > 0;

  if (hasIn && hasOut) {
    if (inTokens.length > 0 && outNative.length > 0) return "BUY";
    if (outTokens.length > 0 && inNative.length > 0) return "SELL";
    return "SWAP";
  }
  if (hasIn || hasOut) return "TRANSFER";
  return "UNKNOWN";
}

async function processTransactionForWallet(tx, trackedWallet, chatId, label) {
  var txType = classifyTransaction(tx, trackedWallet);
  console.log("Processing tx", { sig: tx.signature && tx.signature.slice(0, 12), txType: txType });

  var result = null;
  try {
    if (txType === "BUY") result = await formatBuyAlert(tx, trackedWallet, label);
    else if (txType === "SELL") result = await formatSellAlert(tx, trackedWallet, label);
    else if (txType === "SWAP") result = await formatSwapAlert(tx, trackedWallet, label);
    else if (txType === "TRANSFER") result = await formatTransferAlert(tx, trackedWallet, label);
    else { console.log("Skipping UNKNOWN tx", tx.signature); return; }
  } catch (err) {
    console.error("Formatter error", txType, err);
    return;
  }

  if (!result) { console.log("Formatter returned null"); return; }

  if (result.buttons && result.buttons.length > 0) {
    await sendTelegramMessageWithButtons(chatId, result.text, result.buttons);
  } else {
    await sendTelegramMessage(chatId, result.text);
  }
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Helius webhook alive" });
  }

  var secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    var provided = (req.query && req.query.secret) || (req.headers && req.headers["x-webhook-secret"]);
    if (provided !== secret) {
      console.warn("Helius webhook: invalid secret");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  var transactions = Array.isArray(req.body) ? req.body : [req.body];

  if (!supabase) {
    console.error("Helius webhook: Supabase not initialised");
    return res.status(200).json({ ok: true, warning: "Supabase not configured" });
  }

  for (var i = 0; i < transactions.length; i++) {
    var tx = transactions[i];
    if (!tx || !tx.signature) continue;

    var accountsInvolved = new Set();
    var nativeTransfers = tx.nativeTransfers || [];
    for (var n = 0; n < nativeTransfers.length; n++) {
      if (nativeTransfers[n].fromUserAccount) accountsInvolved.add(nativeTransfers[n].fromUserAccount);
      if (nativeTransfers[n].toUserAccount) accountsInvolved.add(nativeTransfers[n].toUserAccount);
    }
    var tokenTransfers = tx.tokenTransfers || [];
    for (var t = 0; t < tokenTransfers.length; t++) {
      if (tokenTransfers[t].fromUserAccount) accountsInvolved.add(tokenTransfers[t].fromUserAccount);
      if (tokenTransfers[t].toUserAccount) accountsInvolved.add(tokenTransfers[t].toUserAccount);
    }

    var wallets = Array.from(accountsInvolved);
    for (var w = 0; w < wallets.length; w++) {
      var walletAddress = wallets[w];
      var subscribers;
      try {
        subscribers = await getActiveSubscribersForWallet(walletAddress);
      } catch (dbErr) {
        console.error("DB lookup error", dbErr);
        continue;
      }

      for (var s = 0; s < subscribers.length; s++) {
        var sub = subscribers[s];
        var chatId = sub.telegram_chat_id;
        var label = sub.label || null;
        if (!chatId) continue;
        try {
          await processTransactionForWallet(tx, walletAddress, chatId, label);
        } catch (alertErr) {
          console.error("Alert dispatch error", alertErr);
        }
      }
    }
  }

  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.registerWalletWithHelius = registerWalletWithHelius;
module.exports.unregisterWalletFromHelius = unregisterWalletFromHelius;
