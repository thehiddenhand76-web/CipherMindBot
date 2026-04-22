/**
 * cron/auto-verify.js
 *
 * AUTO PAYMENT VERIFICATION   Future Feature
 * 
 * Instead of asking users to paste a transaction hash via /verify,
 * this cron job polls the Solana blockchain for inbound payments to
 * PAYMENT_WALLET and automatically activates the matching user's plan.
 *
 * Flow:
 *   1. User selects a plan with /plan  plan key stored in users.selected_plan
 *   2. User sends SOL to PAYMENT_WALLET (no /verify needed)
 *   3. This cron runs every N minutes, fetches recent transactions to PAYMENT_WALLET
 *   4. For each unprocessed payment it finds a user whose:
 *        a. selected_plan amount matches the SOL sent
 *        b. payment arrived after the plan was selected (pending_intent.created_at)
 *   5. Plan is activated automatically, user gets a Telegram confirmation
 *
 *   KNOWN LIMITATIONS TO ADDRESS BEFORE GOING LIVE:
 *   - Two users selecting the same plan at the same time and sending the same
 *     SOL amount creates an ambiguous match. Mitigate by assigning a unique
 *     memo/reference field per payment intent (see TODO below).
 *   - The cron window must be tight enough that no tx is double-processed.
 *     The pending_payments table is the dedup guard.
 *   - Solana RPC rate limits apply. Use your own Helius RPC endpoint.
 *
 * Deploy as a Vercel Cron (vercel.json):
 *   { "crons": [{ "path": "/api/cron/auto-verify", "schedule": "* /5 * * * *" }] }
 *   (every 5 minutes)
 *
 * Required env vars:
 *   SUPABASEURL, SUPABASESERVICEROLEKEY
 *   TELEGRAM_BOT_TOKEN
 *   PAYMENT_WALLET              your SOL receiving address
 *   HELIUS_API_KEY              for RPC calls (higher rate limits than public)
 *   CRON_SECRET                 protects the endpoint
 *   AUTO_VERIFY_LOOKBACK_SECS   how many seconds back to scan (default: 360)
 */

const { createClient } = require("@supabase/supabase-js");

//  Config 

const PAYMENT_WALLET   = process.env.PAYMENT_WALLET || "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const LAMPORTS_PER_SOL = 1_000_000_000;

const PLANS = {
  monthly_50:  { label: "50 Wallets  Monthly",  sol: 0.30, wallet_limit: 50,  billing: "monthly" },
  monthly_100: { label: "100 Wallets  Monthly", sol: 0.40, wallet_limit: 100, billing: "monthly" },
  monthly_200: { label: "200 Wallets  Monthly", sol: 0.50, wallet_limit: 200, billing: "monthly" },
  yearly_50:   { label: "50 Wallets  Yearly",   sol: 1.20, wallet_limit: 50,  billing: "yearly"  },
  yearly_100:  { label: "100 Wallets  Yearly",  sol: 1.60, wallet_limit: 100, billing: "yearly"  },
  yearly_200:  { label: "200 Wallets  Yearly",  sol: 2.00, wallet_limit: 200, billing: "yearly"  },
};

//  Supabase 

const supabase =
  process.env.SUPABASEURL && process.env.SUPABASESERVICEROLEKEY
    ? createClient(process.env.SUPABASEURL, process.env.SUPABASESERVICEROLEKEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

//  Telegram 

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

async function getChatIdForUser(telegramUserId) {
  const { data } = await supabase
    .from("tracked_wallets")
    .select("telegram_chat_id")
    .eq("telegram_user_id", String(telegramUserId))
    .limit(1)
    .maybeSingle();
  return data?.telegram_chat_id || telegramUserId;
}

//  Solana RPC 

function rpcEndpoint() {
  const apiKey = process.env.HELIUS_API_KEY;
  return apiKey
    ? "https://mainnet.helius-rpc.com/?api-key=" + apiKey
    : "https://api.mainnet-beta.solana.com";
}

/**
 * Fetches recent signatures for PAYMENT_WALLET.
 * Returns up to `limit` signatures (max 1000 per Solana RPC).
 */
async function getRecentSignatures(limit = 50) {
  const res = await fetch(rpcEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [
        PAYMENT_WALLET,
        { limit, commitment: "confirmed" },
      ],
    }),
  });
  const json = await res.json();
  return json?.result || [];
}

/**
 * Fetches a single transaction in jsonParsed encoding.
 */
async function getTransaction(signature) {
  const res = await fetch(rpcEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
      ],
    }),
  });
  const json = await res.json();
  return json?.result || null;
}

//  Payment Parsing 

/**
 * Extracts the SOL amount received by PAYMENT_WALLET in a transaction.
 * Returns { lamports, sol, sender } or null if PAYMENT_WALLET wasn't the receiver.
 */
function extractPaymentToWallet(tx) {
  const instructions = tx?.transaction?.message?.instructions || [];
  let totalLamports = 0;
  let sender = null;

  for (const ix of instructions) {
    if (
      ix.parsed?.type === "transfer" &&
      ix.parsed?.info?.destination === PAYMENT_WALLET
    ) {
      totalLamports += ix.parsed.info.lamports || 0;
      if (!sender) sender = ix.parsed.info.source;
    }
  }

  if (totalLamports === 0) return null;
  return { lamports: totalLamports, sol: totalLamports / LAMPORTS_PER_SOL, sender };
}

//  Pending Payment Intent Matching 

/**
 * TODO (before going live): Add a `pending_intents` table:
 *
 *   CREATE TABLE pending_intents (
 *     id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     telegram_user_id   text NOT NULL REFERENCES users(telegram_user_id),
 *     plan_key           text NOT NULL,
 *     expected_sol       numeric NOT NULL,
 *     memo               text,          -- unique 4-char suffix user must include in tx memo
 *     created_at         timestamptz DEFAULT now(),
 *     expires_at         timestamptz,   -- intent expires after 30 minutes
 *     matched_tx         text,          -- filled when matched
 *     status             text DEFAULT 'pending'  -- pending | matched | expired
 *   );
 *
 * With a memo field, matching is unambiguous even when two users send the same amount.
 * The bot tells the user: "Send exactly 0.30 SOL with memo: XJ7K"
 * This cron then fetches tx memos via getTransaction and matches on (sol_amount + memo).
 *
 * For now (Phase 1) we match by amount alone, using the time window as a safeguard.
 */

/**
 * Returns users who have selected a plan and are awaiting payment.
 * Reads from users.selected_plan  reuses existing schema, no new tables needed for Phase 1.
 *
 * @param {number} lookbackSecs   only consider intents created within this window
 */
async function getPendingPaymentIntents(lookbackSecs) {
  const cutoff = new Date(Date.now() - lookbackSecs * 1000).toISOString();

  // users.selected_plan_at must exist for time-windowed matching.
  // If the column doesn't exist yet, add it:
  //   ALTER TABLE users ADD COLUMN selected_plan_at timestamptz;
  // And update setSelectedPlan() in bot.js to also write it.
  const { data, error } = await supabase
    .from("users")
    .select("telegram_user_id, selected_plan, selected_plan_at")
    .not("selected_plan", "is", null)
    .gte("selected_plan_at", cutoff);

  if (error) {
    console.error("getPendingPaymentIntents error", error);
    return [];
  }

  return (data || []).filter((row) => PLANS[row.selected_plan]);
}

//  Plan Activation 

async function activatePlan(telegramUserId, planKey, txSignature, receivedSol) {
  const plan = PLANS[planKey];
  const now       = new Date();
  const days      = plan.billing === "yearly" ? 365 : 30;
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // 1. Upgrade plan row
  await supabase.from("plans").update({
    plan_name:    planKey,
    wallet_limit: plan.wallet_limit,
    status:       "active",
    expires_at:   expiresAt.toISOString(),
  }).eq("telegram_user_id", String(telegramUserId));

  // 2. Record payment
  await supabase.from("pending_payments").upsert({
    id:               txSignature,
    telegram_user_id: String(telegramUserId),
    plan_requested:   planKey,
    amount:           receivedSol,
    bill_cycle:       plan.billing,
    status:           "confirmed",
  });

  // 3. Clear selected_plan
  await supabase.from("users").update({ selected_plan: null, selected_plan_at: null })
    .eq("telegram_user_id", String(telegramUserId));

  // 4. Notify user
  const chatId = await getChatIdForUser(telegramUserId);
  const expiryStr = expiresAt.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });

  await sendTelegramMessage(
    chatId,
    [
      " <b>Payment Confirmed  Auto Verified</b>",
      "",
      "Plan: <b>" + plan.label + "</b>",
      "Wallet limit: " + plan.wallet_limit,
      "Expires: " + expiryStr,
      "",
      "Use /add to start tracking wallets.",
    ].join("\n")
  );

  console.log("Plan activated", { telegramUserId, planKey, txSignature });
}

//  Main Job 

async function runAutoVerify() {
  if (!supabase) throw new Error("Supabase not initialised");

  const LOOKBACK_SECS = parseInt(process.env.AUTO_VERIFY_LOOKBACK_SECS || "360", 10);
  const TX_FETCH_LIMIT = parseInt(process.env.AUTO_VERIFY_TX_LIMIT || "50", 10);

  // Step 1: Get pending intents
  const intents = await getPendingPaymentIntents(LOOKBACK_SECS);
  if (intents.length === 0) {
    console.log("Auto-verify: no pending intents");
    return { matched: 0, checked: 0 };
  }

  console.log("Auto-verify: " + intents.length + " pending intent(s)");

  // Step 2: Fetch recent transactions to PAYMENT_WALLET
  const signatures = await getRecentSignatures(TX_FETCH_LIMIT);
  console.log("Auto-verify: fetched " + signatures.length + " recent signatures");

  // Step 3: Filter out already-processed transactions
  const sigList = signatures.map((s) => s.signature);
  const { data: alreadyDone } = await supabase
    .from("pending_payments")
    .select("id")
    .in("id", sigList)
    .eq("status", "confirmed");

  const processedSigs = new Set((alreadyDone || []).map((r) => r.id));
  const newSigs = sigList.filter((s) => !processedSigs.has(s));
  console.log("Auto-verify: " + newSigs.length + " unprocessed signature(s)");

  // Step 4: For each new transaction, extract payment amount and match to an intent
  let matched = 0;

  for (const sig of newSigs) {
    let tx;
    try {
      tx = await getTransaction(sig);
    } catch (e) {
      console.error("getTransaction error", sig, e);
      continue;
    }
    if (!tx) continue;
    if (tx.meta?.err) continue; // failed on-chain

    const txTimestamp = tx.blockTime ? new Date(tx.blockTime * 1000) : null;

    const payment = extractPaymentToWallet(tx);
    if (!payment) continue;

    console.log("Auto-verify: payment found", { sig: sig.slice(0, 12), sol: payment.sol });

    // Find an intent that matches this SOL amount within the time window
    const matchingIntent = intents.find((intent) => {
      const plan = PLANS[intent.selected_plan];
      if (!plan) return false;

      // Amount must match exactly (within 0.001 SOL rounding tolerance)
      if (Math.abs(payment.sol - plan.sol) > 0.001) return false;

      // Transaction must be after the intent was created
      if (txTimestamp && intent.selected_plan_at) {
        const intentTime = new Date(intent.selected_plan_at);
        if (txTimestamp < intentTime) return false;
      }

      return true;
    });

    if (!matchingIntent) {
      console.log("Auto-verify: no matching intent for", payment.sol, "SOL");
      continue;
    }

    // Prevent double-activation  check again right before writing
    const { data: alreadyActivated } = await supabase
      .from("pending_payments")
      .select("id")
      .eq("id", sig)
      .maybeSingle();

    if (alreadyActivated) {
      console.log("Auto-verify: already activated", sig);
      continue;
    }

    try {
      await activatePlan(
        matchingIntent.telegram_user_id,
        matchingIntent.selected_plan,
        sig,
        payment.sol
      );
      matched++;

      // Remove this intent from in-memory list so it can't be double-matched
      const idx = intents.indexOf(matchingIntent);
      if (idx !== -1) intents.splice(idx, 1);
    } catch (activateErr) {
      console.error("activatePlan error", activateErr);
    }
  }

  return { matched, checked: newSigs.length };
}

//  HTTP Handler (Vercel API route) 

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Auth guard
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader  = req.headers?.authorization || "";
    const provided    = authHeader.replace("Bearer ", "").trim();
    const querySecret = req.query?.secret || "";
    if (provided !== cronSecret && querySecret !== cronSecret) {
      console.warn("Auto-verify cron: unauthorized");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  try {
    const result = await runAutoVerify();
    console.log("Auto-verify job complete", result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Auto-verify job failed", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

//  Direct execution 

if (require.main === module) {
  runAutoVerify()
    .then((result) => { console.log("Done", result); process.exit(0); })
    .catch((err)   => { console.error(err); process.exit(1); });
}

module.exports = handler;
