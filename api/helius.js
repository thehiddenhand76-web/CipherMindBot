const { createClient } = require("@supabase/supabase-js");

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const HELIUS_API_BASE = "https://api.helius.xyz/v0";
const SOL_MINT        = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;

// â”€â”€â”€ Supabase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const supabase =
  process.env.SUPABASEURL && process.env.SUPABASESERVICEROLEKEY
    ? createClient(process.env.SUPABASEURL, process.env.SUPABASESERVICEROLEKEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function shortenAddress(addr, len = 6) {
  if (!addr || addr.length <= len * 2 + 3) return addr;
  return addr.slice(0, len) + "..." + addr.slice(-len);
}

function formatAmount(amount, decimals = 9) {
  const value = amount / Math.pow(10, decimals);
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000)     return (value / 1_000).toFixed(2) + "K";
  return value.toFixed(value < 0.01 ? 6 : 4);
}

function formatUSD(value) {
  if (!value && value !== 0) return "";
  if (value >= 1_000_000) return " ($" + (value / 1_000_000).toFixed(2) + "M)";
  if (value >= 1_000)     return " ($" + (value / 1_000).toFixed(2) + "K)";
  return " ($" + value.toFixed(2) + ")";
}

function explorerLink(signature) {
  return "https://solscan.io/tx/" + signature;
}

function dexLink(mint) {
  return "https://dexscreener.com/solana/" + mint;
}

function jupLink(inputMint, outputMint) {
  return (
    "https://jup.ag/swap/" + (inputMint || "SOL") + "-" + (outputMint || "SOL")
  );
}

// â”€â”€â”€ Telegram Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch((e) => console.error("sendTelegramMessage error", e));
}

async function sendTelegramMessageWithButtons(chatId, text, inlineKeyboard) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    }),
  }).catch((e) => console.error("sendTelegramMessageWithButtons error", e));
}

// â”€â”€â”€ Supabase Lookups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Returns all active tracked-wallet rows for a given wallet address.
 * Multiple users may track the same wallet, so we return an array.
 */
async function getActiveSubscribersForWallet(walletAddress) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("tracked_wallets")
    .select("telegram_user_id, telegram_chat_id, label")
    .eq("wallet_address", walletAddress)
    .eq("active", true);
  if (error) {
    console.error("getActiveSubscribersForWallet error", error);
    return [];
  }
  return data || [];
}

// â”€â”€â”€ Token Metadata (Helius DAS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const tokenMetaCache = new Map();

async function getTokenMeta(mint) {
  if (!mint || mint === SOL_MINT) return { symbol: "SOL", name: "Solana", decimals: 9 };
  if (tokenMetaCache.has(mint)) return tokenMetaCache.get(mint);

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { symbol: shortenAddress(mint, 4), name: mint, decimals: 6 };

  try {
    const res = await fetch(
      "https://mainnet.helius-rpc.com/?api-key=" + apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-asset",
          method: "getAsset",
          params: { id: mint },
        }),
      }
    );
    const json = await res.json();
    const result = json?.result;
    const meta = {
      symbol:   result?.content?.metadata?.symbol   || shortenAddress(mint, 4),
      name:     result?.content?.metadata?.name     || mint,
      decimals: result?.token_info?.decimals         ?? 6,
      price:    result?.token_info?.price_info?.price_per_token ?? null,
    };
    tokenMetaCache.set(mint, meta);
    return meta;
  } catch (e) {
    console.error("getTokenMeta error", e);
    return { symbol: shortenAddress(mint, 4), name: mint, decimals: 6 };
  }
}

// â”€â”€â”€ Alert Formatters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Formats a TRANSFER alert.
 *
 * Helius "tokenTransfers" / "nativeTransfers" arrays are used.
 * We resolve who is sender/receiver relative to the tracked wallet.
 */
async function formatTransfer(tx, trackedWallet, label) {
  const sig   = tx.signature;
  const ts    = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : "";
  const fee   = tx.fee ? (tx.fee / LAMPORTS_PER_SOL).toFixed(6) : "?";

  // --- Collect all transfer legs ---
  const legs = [];

  // Native SOL transfers
  for (const nt of tx.nativeTransfers || []) {
    if (!nt.amount || nt.amount === 0) continue;
    legs.push({
      mint:     SOL_MINT,
      symbol:   "SOL",
      decimals: 9,
      amount:   nt.amount,
      from:     nt.fromUserAccount,
      to:       nt.toUserAccount,
    });
  }

  // SPL token transfers
  for (const tt of tx.tokenTransfers || []) {
    if (!tt.tokenAmount || tt.tokenAmount === 0) continue;
    const meta = await getTokenMeta(tt.mint);
    legs.push({
      mint:     tt.mint,
      symbol:   meta.symbol,
      decimals: meta.decimals,
      amount:   tt.tokenAmount * Math.pow(10, meta.decimals), // normalise back to raw
      from:     tt.fromUserAccount,
      to:       tt.toUserAccount,
      price:    meta.price,
    });
  }

  if (legs.length === 0) return null;

  // Determine direction from perspective of trackedWallet
  const outgoing = legs.filter((l) => l.from === trackedWallet);
  const incoming = legs.filter((l) => l.to   === trackedWallet);

  const direction = outgoing.length > 0 && incoming.length === 0 ? "OUT"
                  : incoming.length > 0 && outgoing.length === 0 ? "IN"
                  : "BOTH";

  const emoji  = direction === "OUT" ? "ðŸ“¤" : direction === "IN" ? "ðŸ“¥" : "ðŸ”„";
  const action = direction === "OUT" ? "Sent" : direction === "IN" ? "Received" : "Transfer";

  const relevant = direction === "BOTH" ? legs : direction === "OUT" ? outgoing : incoming;

  let lines = [
    emoji + " <b>" + action + "</b>",
    "",
    "ðŸ‘› <b>Wallet:</b> " + (label ? '"' + label + '"' : shortenAddress(trackedWallet)),
  ];

  for (const leg of relevant) {
    const amt = formatAmount(leg.amount, leg.decimals);
    const usd = leg.price ? formatUSD(leg.price * (leg.amount / Math.pow(10, leg.decimals))) : "";
    const counterparty = direction === "OUT" ? leg.to : leg.from;
    lines.push(
      "ðŸ’¸ <b>" + amt + " " + leg.symbol + usd + "</b>  â†’  " + shortenAddress(counterparty)
    );
  }

  lines.push("", "â›½ Fee: " + fee + " SOL");
  if (ts) lines.push("ðŸ•’ " + ts);

  const buttons = [
    [{ text: "ðŸ” View Transaction", url: explorerLink(sig) }],
  ];

  // Add a Swap button if both sides present (mixed transfer)
  if (direction === "BOTH" && legs.length >= 2) {
    const inMint  = incoming[0]?.mint;
    const outMint = outgoing[0]?.mint;
    if (inMint && outMint) {
      buttons.push([{ text: "âš¡ Swap on Jupiter", url: jupLink(outMint, inMint) }]);
    }
  }

  return { text: lines.join("\n"), buttons };
}

/**
 * Formats a SWAP alert.
 *
 * Helius enriched "swap" events have .events.swap with tokenInputs / tokenOutputs.
 */
async function formatSwap(tx, trackedWallet, label) {
  const sig = tx.signature;
  const ts  = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : "";
  const fee = tx.fee ? (tx.fee / LAMPORTS_PER_SOL).toFixed(6) : "?";

  const swapEvent = tx.events?.swap;

  // Fallback: derive from tokenTransfers if no structured swap event
  let inputMint, inputSymbol, inputDecimals, inputAmount;
  let outputMint, outputSymbol, outputDecimals, outputAmount;
  let inputUSD = "", outputUSD = "";

  if (swapEvent) {
    const inLeg  = swapEvent.tokenInputs?.[0]  || swapEvent.nativeInput;
    const outLeg = swapEvent.tokenOutputs?.[0] || swapEvent.nativeOutput;

    if (inLeg) {
      const meta  = await getTokenMeta(inLeg.mint || SOL_MINT);
      inputMint    = inLeg.mint || SOL_MINT;
      inputSymbol  = meta.symbol;
      inputDecimals = meta.decimals;
      inputAmount  = inLeg.tokenAmount ?? inLeg.amount;
      if (meta.price) inputUSD = formatUSD(meta.price * inputAmount);
    }

    if (outLeg) {
      const meta   = await getTokenMeta(outLeg.mint || SOL_MINT);
      outputMint    = outLeg.mint || SOL_MINT;
      outputSymbol  = meta.symbol;
      outputDecimals = meta.decimals;
      outputAmount  = outLeg.tokenAmount ?? outLeg.amount;
      if (meta.price) outputUSD = formatUSD(meta.price * outputAmount);
    }
  } else {
    // Derive from tokenTransfers: wallet sent X, wallet received Y
    for (const tt of tx.tokenTransfers || []) {
      const meta = await getTokenMeta(tt.mint);
      if (tt.fromUserAccount === trackedWallet && !inputMint) {
        inputMint    = tt.mint;
        inputSymbol  = meta.symbol;
        inputDecimals = meta.decimals;
        inputAmount  = tt.tokenAmount;
      }
      if (tt.toUserAccount === trackedWallet && !outputMint) {
        outputMint    = tt.mint;
        outputSymbol  = meta.symbol;
        outputDecimals = meta.decimals;
        outputAmount  = tt.tokenAmount;
      }
    }
    // Check native transfers
    for (const nt of tx.nativeTransfers || []) {
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

  const inStr  = inputAmount  != null ? formatAmount(inputAmount  * (swapEvent ? Math.pow(10, inputDecimals || 6)  : 1), swapEvent ? inputDecimals || 6 : 0)  : "?";
  const outStr = outputAmount != null ? formatAmount(outputAmount * (swapEvent ? Math.pow(10, outputDecimals || 6) : 1), swapEvent ? outputDecimals || 6 : 0) : "?";

  const lines = [
    "ðŸ”„ <b>Swap</b>",
    "",
    "ðŸ‘› <b>Wallet:</b> " + (label ? '"' + label + '"' : shortenAddress(trackedWallet)),
    "",
    "ðŸ“‰ <b>Sold:</b>   " + inStr  + " " + (inputSymbol  || "?") + inputUSD,
    "ðŸ“ˆ <b>Bought:</b> " + outStr + " " + (outputSymbol || "?") + outputUSD,
    "",
    "â›½ Fee: " + fee + " SOL",
  ];
  if (ts) lines.push("ðŸ•’ " + ts);

  const buttons = [
    [{ text: "ðŸ” View on Solscan", url: explorerLink(sig) }],
  ];

  if (outputMint && outputMint !== SOL_MINT) {
    buttons.push([{ text: "ðŸ“Š Chart on DexScreener", url: dexLink(outputMint) }]);
  }
  if (inputMint && outputMint) {
    buttons.push([{ text: "âš¡ Trade on Jupiter", url: jupLink(inputMint, outputMint) }]);
  }

  return { text: lines.join("\n"), buttons };
}

/**
 * Formats a BUY alert.
 * A "buy" is semantically a swap where wallet received a non-SOL/stablecoin token.
 */
async function formatBuy(tx, trackedWallet, label) {
  const result = await formatSwap(tx, trackedWallet, label);
  if (!result) return null;
  // Replace the first line emoji/label
  result.text = result.text.replace("ðŸ”„ <b>Swap</b>", "ðŸŸ¢ <b>Buy</b>");
  return result;
}

/**
 * Formats a SELL alert.
 * A "sell" is a swap where wallet sent a non-SOL/stablecoin token.
 */
async function formatSell(tx, trackedWallet, label) {
  const result = await formatSwap(tx, trackedWallet, label);
  if (!result) return null;
  result.text = result.text.replace("ðŸ”„ <b>Swap</b>", "ðŸ”´ <b>Sell</b>");
  return result;
}

/**
 * Formats an NFT SALE alert.
 */
async function formatNFTSale(tx, trackedWallet, label) {
  const sig   = tx.signature;
  const ts    = tx.timestamp ? new Date(tx.timestamp * 1000).toLocaleString() : "";
  const sale  = tx.events?.nft;

  if (!sale) return null;

  const isSeller = sale.seller === trackedWallet;
  const isBuyer  = sale.buyer  === trackedWallet;
  if (!isSeller && !isBuyer) return null;

  const role   = isSeller ? "Sold" : "Bought";
  const emoji  = isSeller ? "ðŸ·ï¸" : "ðŸ›’";
  const price  = sale.amount ? (sale.amount / LAMPORTS_PER_SOL).toFixed(4) : "?";
  const nftName = sale.nfts?.[0]?.name || "NFT";

  const lines = [
    emoji + " <b>NFT " + role + "</b>",
    "",
    "ðŸ‘› <b>Wallet:</b> " + (label ? '"' + label + '"' : shortenAddress(trackedWallet)),
    "ðŸ–¼ï¸ <b>Item:</b>  " + nftName,
    "ðŸ’° <b>Price:</b> " + price + " SOL",
    "",
    "ðŸ•’ " + ts,
  ];

  const buttons = [
    [{ text: "ðŸ” View Transaction", url: explorerLink(sig) }],
  ];

  const nftMint = sale.nfts?.[0]?.mint;
  if (nftMint) {
    buttons.push([{ text: "ðŸ–¼ï¸ View on Magic Eden", url: "https://magiceden.io/item-details/" + nftMint }]);
  }

  return { text: lines.join("\n"), buttons };
}

// â”€â”€â”€ Transaction Classifier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Classifies a Helius enriched transaction into one of:
 *   BUY | SELL | SWAP | TRANSFER | NFT_SALE | UNKNOWN
 *
 * Strategy:
 * 1. Use tx.type if Helius already labelled it.
 * 2. Inspect token flows relative to trackedWallet.
 */
function classifyTransaction(tx, trackedWallet) {
  const type = (tx.type || "").toUpperCase();

  // Helius already classified it
  if (type === "NFT_SALE" || type === "NFT_BID" || type === "NFT_LISTING") return "NFT_SALE";
  if (type === "SWAP")     return "SWAP";
  if (type === "TRANSFER") return "TRANSFER";

  // Check for swap events
  if (tx.events?.swap) return "SWAP";

  // Check for NFT events
  if (tx.events?.nft)  return "NFT_SALE";

  // Analyse token flows
  const inTokens  = (tx.tokenTransfers || []).filter((t) => t.toUserAccount   === trackedWallet);
  const outTokens = (tx.tokenTransfers || []).filter((t) => t.fromUserAccount === trackedWallet);
  const inNative  = (tx.nativeTransfers || []).filter((t) => t.toUserAccount   === trackedWallet);
  const outNative = (tx.nativeTransfers || []).filter((t) => t.fromUserAccount === trackedWallet);

  const hasIn  = inTokens.length  > 0 || inNative.length  > 0;
  const hasOut = outTokens.length > 0 || outNative.length > 0;

  if (hasIn && hasOut) {
    // Both sides involved â†’ likely a swap
    // Classify as BUY if received non-SOL, SELL if sent non-SOL
    if (inTokens.length > 0 && outNative.length > 0)  return "BUY";
    if (outTokens.length > 0 && inNative.length > 0)  return "SELL";
    return "SWAP";
  }

  if (hasIn || hasOut) return "TRANSFER";

  return "UNKNOWN";
}

// â”€â”€â”€ Core Alert Dispatcher â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Processes one enriched Helius transaction for one tracked wallet.
 * Selects the correct formatter and sends the Telegram alert.
 */
async function processTransactionForWallet(tx, trackedWallet, chatId, label) {
  const txType = classifyTransaction(tx, trackedWallet);
  console.log("Processing tx", { sig: tx.signature?.slice(0, 12), txType, trackedWallet: shortenAddress(trackedWallet) });

  let result = null;

  try {
    switch (txType) {
      case "BUY":      result = await formatBuy(tx, trackedWallet, label);       break;
      case "SELL":     result = await formatSell(tx, trackedWallet, label);      break;
      case "SWAP":     result = await formatSwap(tx, trackedWallet, label);      break;
      case "TRANSFER": result = await formatTransfer(tx, trackedWallet, label);  break;
      case "NFT_SALE": result = await formatNFTSale(tx, trackedWallet, label);   break;
      default:
        console.log("Skipping UNKNOWN tx type", tx.signature);
        return;
    }
  } catch (err) {
    console.error("Formatter error for", txType, err);
    return;
  }

  if (!result) {
    console.log("Formatter returned null for", tx.signature, txType);
    return;
  }

  if (result.buttons && result.buttons.length > 0) {
    await sendTelegramMessageWithButtons(chatId, result.text, result.buttons);
  } else {
    await sendTelegramMessage(chatId, result.text);
  }
}

// â”€â”€â”€ Webhook Handler (Vercel / Next.js API Route) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handler(req, res) {
  // Liveness probe
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Helius webhook alive" });
  }

  // Optional shared secret validation
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.query?.secret || req.headers?.["x-webhook-secret"];
    if (provided !== secret) {
      console.warn("Helius webhook: invalid secret");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  // Helius sends an array of enriched transactions
  const transactions = Array.isArray(req.body) ? req.body : [req.body];

  if (!supabase) {
    console.error("Helius webhook: Supabase not initialised");
    return res.status(200).json({ ok: true, warning: "Supabase not configured" });
  }

  for (const tx of transactions) {
    if (!tx || !tx.signature) continue;

    // Collect every unique account touched in this transaction
    const accountsInvolved = new Set();

    for (const nt of tx.nativeTransfers || []) {
      if (nt.fromUserAccount) accountsInvolved.add(nt.fromUserAccount);
      if (nt.toUserAccount)   accountsInvolved.add(nt.toUserAccount);
    }
    for (const tt of tx.tokenTransfers || []) {
      if (tt.fromUserAccount) accountsInvolved.add(tt.fromUserAccount);
      if (tt.toUserAccount)   accountsInvolved.add(tt.toUserAccount);
    }

    // For each account, check if any of our users are tracking it
    for (const walletAddress of accountsInvolved) {
      let subscribers;
      try {
        subscribers = await getActiveSubscribersForWallet(walletAddress);
      } catch (dbErr) {
        console.error("DB lookup error", dbErr);
        continue;
      }

      for (const sub of subscribers) {
        const chatId = sub.telegram_chat_id;
        const label  = sub.label || null;
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
