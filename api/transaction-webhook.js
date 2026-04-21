const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Transaction webhook alive" });
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    console.warn("transaction-webhook: unauthorized request");
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const supabaseUrl = process.env.SUPABASEURL;
  const supabaseKey = process.env.SUPABASESERVICEROLEKEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error("transaction-webhook: missing Supabase env vars");
    return res.status(200).json({ ok: false, message: "DB not configured" });
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  let body = req.body;

  if (!body) {
    return res.status(200).json({ ok: true, message: "Empty body" });
  }

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(200).json({ ok: false, message: "Invalid JSON body" });
    }
  }

  if (!Array.isArray(body)) {
    return res.status(200).json({ ok: true, message: "Expected array body" });
  }

  const transactions = body.map(parseTransaction);

  console.log("transaction-webhook: processing", transactions.length, "tx(s)");

  for (const tx of transactions) {
    await Promise.allSettled(
      (tx.accountsInvolved || []).map((wallet) =>
        dispatchAlertsForWallet(supabase, wallet, tx)
      )
    );
  }

  return res.status(200).json({ ok: true, processed: transactions.length });
};

function parseTransaction(event) {
  const signature = event.signature || "unknown";
  const type = event.type || "UNKNOWN";
  const source = event.source || "unknown";
  const fee = typeof event.fee === "number" ? event.fee / 1e9 : null;
  const timestamp = event.timestamp ? new Date(event.timestamp * 1000).toISOString() : null;

  const nativeTransfers = (event.nativeTransfers || []).map((t) => ({
    from: t.fromUserAccount || null,
    to: t.toUserAccount || null,
    amountSol: typeof t.amount === "number" ? t.amount / 1e9 : 0,
  }));

  const tokenTransfers = (event.tokenTransfers || []).map((t) => ({
    from: t.fromUserAccount || null,
    to: t.toUserAccount || null,
    mint: t.mint || null,
    amount: t.tokenAmount || 0,
    decimals: t.decimals || 0,
  }));

  const accounts = new Set();
  (event.accountData || []).forEach((a) => { if (a.account) accounts.add(a.account); });
  nativeTransfers.forEach((t) => { if (t.from) accounts.add(t.from); if (t.to) accounts.add(t.to); });
  tokenTransfers.forEach((t) => { if (t.from) accounts.add(t.from); if (t.to) accounts.add(t.to); });

  return {
    signature,
    type,
    source,
    fee,
    timestamp,
    nativeTransfers,
    tokenTransfers,
    accountsInvolved: Array.from(accounts),
  };
}

function shorten(str, len = 6) {
  if (!str || str.length <= len * 2 + 3) return str;
  return str.slice(0, len) + "..." + str.slice(-len);
}

function formatTokenAmount(amount, decimals) {
  if (!decimals) return String(amount);
  return (amount / Math.pow(10, decimals)).toFixed(Math.min(decimals, 6));
}

function formatAlertMessage(tx, trackedWallet) {
  const lines = [];
  lines.push("CipherMind Alert");
  lines.push("Wallet: " + shorten(trackedWallet));
  lines.push("Type: " + tx.type);
  lines.push("Source: " + tx.source);
  if (tx.timestamp) lines.push("Time: " + tx.timestamp);
  if (tx.fee !== null) lines.push("Fee: " + tx.fee.toFixed(6) + " SOL");

  if (tx.nativeTransfers && tx.nativeTransfers.length > 0) {
    lines.push("");
    lines.push("SOL Transfers:");
    tx.nativeTransfers.forEach((t) => {
      const dir = t.to && trackedWallet && t.to.toLowerCase() === trackedWallet.toLowerCase() ? "Received" : "Sent";
      lines.push(dir + " " + t.amountSol.toFixed(4) + " SOL" + (t.from ? " from " + shorten(t.from) : "") + (t.to ? " to " + shorten(t.to) : ""));
    });
  }

  if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
    lines.push("");
    lines.push("Token Transfers:");
    tx.tokenTransfers.forEach((t) => {
      const dir = t.to && trackedWallet && t.to.toLowerCase() === trackedWallet.toLowerCase() ? "Received" : "Sent";
      const amount = formatTokenAmount(t.amount, t.decimals);
      lines.push(dir + " " + amount + " of " + shorten(t.mint || "unknown") + (t.from ? " from " + shorten(t.from) : "") + (t.to ? " to " + shorten(t.to) : ""));
    });
  }

  lines.push("");
  lines.push("Sig: " + shorten(tx.signature, 12));
  return lines.join("\n");
}

async function sendTelegramAlert(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.error("Missing TELEGRAM_BOT_TOKEN"); return; }
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    console.error("sendTelegramAlert failed", { chatId, status: res.status, data });
  }
}

async function dispatchAlertsForWallet(supabase, walletAddress, tx) {
  const { data: rows, error } = await supabase
    .from("tracked_wallets")
    .select("telegram_chat_id")
    .eq("wallet_address", walletAddress)
    .eq("active", true);

  if (error) { console.error("dispatchAlertsForWallet error", error); return; }
  if (!rows || rows.length === 0) return;

  const message = formatAlertMessage(tx, walletAddress);
  await Promise.allSettled(rows.map((row) => sendTelegramAlert(row.telegram_chat_id, message)));
}
