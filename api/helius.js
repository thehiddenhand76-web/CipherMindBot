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

function dexLink(mint) {
  return "https://dexscreener.com/solana/" + mint;
}

function jupLink(inputMint, outputMint) {
  return "https://jup.ag/swap/" + (inputMint || "SOL") + "-" + (outputMint || "SOL");
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
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "get-asset",
        method: "getAsset",
        params: { id: mint },
      }),
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

async function formatTransfer(tx, trackedWallet, label) {
  var sig = tx.signature;
  var ts = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : "";
  var fee = tx.fee ? (tx.fee / LAMPORTS_PER_SOL).toFixed(6) : "?";
  var legs = [];

  var nativeTransfers = tx.nativeTransfers || [];
  for (var i = 0; i < nativeTransfers.length; i++) {
    var nt = nativeTransfers[i];
    if (!nt.amount || nt.amount === 0) continue;
    legs.push({ mint: SOL_MINT, symbol: "SOL", decimals: 9, amount: nt.amount, from: nt.fromUserAccount, to: nt.toUserAccount });
  }

  var tokenTransfers = tx.tokenTransfers || [];
  for (var j = 0; j < tokenTransfers.length; j++) {
    var tt = tokenTransfers[j];
    if (!tt.tokenAmount || tt.tokenAmount === 0) continue;
    var meta = await getTokenMeta(tt.mint);
    legs.push({
      mint: tt.mint, symbol: meta.symbol, decimals: meta.decimals,
      amount: tt.tokenAmount * Math.pow(10, meta.decimals),
      from: tt.fromUserAccount, to: tt.toUserAccount, price: meta.price,
    });
  }

  if (legs.length === 0) return null;

  var outgoing = legs.filter(function(l) { return l.from === trackedWallet; });
  var incoming = legs.filter(function(l) { return l.to === trackedWallet; });
  var direction = (outgoing.length > 0 && incoming.length === 0) ? "OUT"
                : (incoming.length > 0 && outgoing.length === 0) ? "IN" : "BOTH";

  var emoji = direction === "OUT" ? "[OUT]" : direction === "IN" ? "[IN]" : "[TRANSFER]";
  var action = direction === "OUT" ? "Sent" : direction === "IN" ? "Received" : "Transfer";
  var relevant = direction === "BOTH" ? legs : direction === "OUT" ? outgoing : incoming;

  var lines = [
    emoji + " <b>" + action + "</b>",
    "",
    "<b>Wallet:</b> " + (label ? '"' + label + '"' : shortenAddress(trackedWallet)),
  ];

  for (var k = 0; k < relevant.length; k++) {
    var leg = relevant[k];
    var amt = formatAmount(leg.amount, leg.decimals);
    var usd = leg.price ? formatUSD(leg.price * (leg.amount / Math.pow(10, leg.decimals))) : "";
    var counterparty = direction === "OUT" ? leg.to : leg.from;
    lines.push("<b>" + amt + " " + leg.symbol + usd + "</b>  ->  " + shortenAddress(counterparty));
  }

  lines.push("", "Fee: " + fee + " SOL");
  if (ts) lines.push(ts);

  var buttons = [[{ text: "View Transaction", url: explorerLink(sig) }]];

  if (direction === "BOTH" && legs.length >= 2) {
    var inMint = incoming[0] && incoming[0].mint;
    var outMint = outgoing[0] && outgoing[0].mint;
    if (inMint && outMint) {
      buttons.push([{ text: "Swap on Jupiter", url: jupLink(outMint, inMint) }]);
    }
  }

  return { text: lines.join("\n"), buttons: buttons };
}

async function formatSwap(tx, trackedWallet, label) {
  var sig = tx.signature;
  var ts = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : "";
  var fee = tx.fee ? (tx.fee / LAMPORTS_PER_SOL).toFixed(6) : "?";
  var swapEvent = tx.events && tx.events.swap;
  var inputMint, inputSymbol, inputDecimals, inputAmount;
  var outputMint, outputSymbol, outputDecimals, outputAmount;
  var inputUSD = "", outputUSD = "";

  if (swapEvent) {
    var inLeg = (swapEvent.tokenInputs && swapEvent.tokenInputs[0]) || swapEvent.nativeInput;
    var outLeg = (swapEvent.tokenOutputs && swapEvent.tokenOutputs[0]) || swapEvent.nativeOutput;
    if (inLeg) {
      var inMeta = await getTokenMeta(inLeg.mint || SOL_MINT);
      inputMint = inLeg.mint || SOL_MINT;
      inputSymbol = inMeta.symbol;
      inputDecimals = inMeta.decimals;
      inputAmount = inLeg.tokenAmount != null ? inLeg.tokenAmount : inLeg.amount;
      if (inMeta.price) inputUSD = formatUSD(inMeta.price * inputAmount);
    }
    if (outLeg) {
      var outMeta = await getTokenMeta(outLeg.mint || SOL_MINT);
      outputMint = outLeg.mint || SOL_MINT;
      outputSymbol = outMeta.symbol;
      outputDecimals = outMeta.decimals;
      outputAmount = outLeg.tokenAmount != null ? outLeg.tokenAmount : outLeg.amount;
      if (outMeta.price) outputUSD = formatUSD(outMeta.price * outputAmount);
    }
  } else {
    var tTransfers = tx.tokenTransfers || [];
    for (var i = 0; i < tTransfers.length; i++) {
      var tt = tTransfers[i];
      var m = await getTokenMeta(tt.mint);
      if (tt.fromUserAccount === trackedWallet && !inputMint) {
        inputMint = tt.mint; inputSymbol = m.symbol; inputDecimals = m.decimals; inputAmount = tt.tokenAmount;
      }
      if (tt.toUserAccount === trackedWallet && !outputMint) {
        outputMint = tt.mint; outputSymbol = m.symbol; outputDecimals = m.decimals; outputAmount = tt.tokenAmount;
      }
    }
    var nTransfers = tx.nativeTransfers || [];
    for (var j = 0; j < nTransfers.length; j++) {
      var nt = nTransfers[j];
      if (nt.fromUserAccount === trackedWallet && !inputMint) {
        inputMint = SOL_MINT; inputSymbol = "SOL"; inputDecimals = 9;
        inputAmount = nt.amount / LAMPORTS_PER_SOL;
      }
      if (nt.toUserAccount === trackedWallet && !outputMint) {
        outputMint = SOL_MINT; outputSymbol = "SOL"; outputDecimals = 9;
        outputAmount = nt.amount / LAMPORTS_PER_SOL;
      }
    }
  }

  if (!inputMint && !outputMint) return null;

  var inStr = inputAmount != null ? formatAmount(inputAmount * (swapEvent ? Math.pow(10, inputDecimals || 6) : 1), swapEvent ? (inputDecimals || 6) : 0) : "?";
  var outStr = outputAmount != null ? formatAmount(outputAmount * (swapEvent ? Math.pow(10, outputDecimals || 6) : 1), swapEvent ? (outputDecimals || 6) : 0) : "?";

  var lines = [
    "[SWAP] <b>Swap</b>",
    "",
    "<b>Wallet:</b> " + (label ? '"' + label + '"' : shortenAddress(trackedWallet)),
    "",
    "<b>Sold:</b>   " + inStr + " " + (inputSymbol || "?") + inputUSD,
    "<b>Bought:</b> " + outStr + " " + (outputSymbol || "?") + outputUSD,
    "",
    "Fee: " + fee + " SOL",
  ];
  if (ts) lines.push(ts);

  var buttons = [[{ text: "View on Solscan", url: explorerLink(sig) }]];
  if (outputMint && outputMint !== SOL_MINT) {
    buttons.push([{ text: "Chart on DexScreener", url: dexLink(outputMint) }]);
  }
  if (inputMint && outputMint) {
    buttons.push([{ text: "Trade on Jupiter", url: jupLink(inputMint, outputMint) }]);
  }

  return { text: lines.join("\n"), buttons: buttons };
}

async function formatBuy(tx, trackedWallet, label) {
  var result = await formatSwap(tx, trackedWallet, label);
  if (!result) return null;
  result.text = result.text.replace("[SWAP] <b>Swap</b>", "[BUY] <b>Buy</b>");
  return result;
}

async function formatSell(tx, trackedWallet, label) {
  var result = await formatSwap(tx, trackedWallet, label);
  if (!result) return null;
  result.text = result.text.replace("[SWAP] <b>Swap</b>", "[SELL] <b>Sell</b>");
  return result;
}

async function formatNFTSale(tx, trackedWallet, label) {
  var sig = tx.signature;
  var ts = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : "";
  var sale = tx.events && tx.events.nft;
  if (!sale) return null;
  var isSeller = sale.seller === trackedWallet;
  var isBuyer = sale.buyer === trackedWallet;
  if (!isSeller && !isBuyer) return null;
  var role = isSeller ? "Sold" : "Bought";
  var price = sale.amount ? (sale.amount / LAMPORTS_PER_SOL).toFixed(4) : "?";
  var nftName = (sale.nfts && sale.nfts[0] && sale.nfts[0].name) || "NFT";
  var lines = [
    "[NFT] <b>NFT " + role + "</b>",
    "",
    "<b>Wallet:</b> " + (label ? '"' + label + '"' : shortenAddress(trackedWallet)),
    "<b>Item:</b>  " + nftName,
    "<b>Price:</b> " + price + " SOL",
    "",
    ts,
  ];
  var buttons = [[{ text: "View Transaction", url: explorerLink(sig) }]];
  var nftMint = sale.nfts && sale.nfts[0] && sale.nfts[0].mint;
  if (nftMint) {
    buttons.push([{ text: "View on Magic Eden", url: "https://magiceden.io/item-details/" + nftMint }]);
  }
  return { text: lines.join("\n"), buttons: buttons };
}

function classifyTransaction(tx, trackedWallet) {
  var type = (tx.type || "").toUpperCase();
  if (type === "NFT_SALE" || type === "NFT_BID" || type === "NFT_LISTING") return "NFT_SALE";
  if (type === "SWAP") return "SWAP";
  if (type === "TRANSFER") return "TRANSFER";
  if (tx.events && tx.events.swap) return "SWAP";
  if (tx.events && tx.events.nft) return "NFT_SALE";

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
    if (txType === "BUY") result = await formatBuy(tx, trackedWallet, label);
    else if (txType === "SELL") result = await formatSell(tx, trackedWallet, label);
    else if (txType === "SWAP") result = await formatSwap(tx, trackedWallet, label);
    else if (txType === "TRANSFER") result = await formatTransfer(tx, trackedWallet, label);
    else if (txType === "NFT_SALE") result = await formatNFTSale(tx, trackedWallet, label);
    else { console.log("Skipping UNKNOWN tx", tx.signature); return; }
  } catch (err) {
    console.error("Formatter error", txType, err);
    return;
  }

  if (!result) { console.log("Formatter returned null", tx.signature, txType); return; }

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
