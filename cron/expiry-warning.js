/**
 * cron/expiry-warning.js
 *
 * Sends a Telegram warning to every user whose paid plan expires within 3 days.
 *
 * Deploy as a Vercel Cron Job (vercel.json):
 *   { "crons": [{ "path": "/api/cron/expiry-warning", "schedule": "0 9 * * *" }] }
 *
 * Or call via a plain HTTP GET from any external cron scheduler (cron-job.org, etc.)
 * Protected by CRON_SECRET in the Authorization header.
 */

const { createClient } = require("@supabase/supabase-js");

// â”€â”€â”€ Supabase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const supabase =
  process.env.SUPABASEURL && process.env.SUPABASESERVICEROLEKEY
    ? createClient(process.env.SUPABASEURL, process.env.SUPABASESERVICEROLEKEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

// â”€â”€â”€ Telegram â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function formatDate(date) {
  return new Date(date).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });
}

const PLAN_LABELS = {
  monthly_50:  "50 Wallets â€” Monthly",
  monthly_100: "100 Wallets â€” Monthly",
  monthly_200: "200 Wallets â€” Monthly",
  yearly_50:   "50 Wallets â€” Yearly",
  yearly_100:  "100 Wallets â€” Yearly",
  yearly_200:  "200 Wallets â€” Yearly",
};

/**
 * Returns every plan row that:
 *   - is not "free"
 *   - has an expires_at between now and (now + WARNING_DAYS days)
 *   - has status "active"
 *   - has NOT already been warned in this window (warned_at within last WARNING_DAYS days)
 */
async function getExpiringPlans(WARNING_DAYS = 3) {
  const now     = new Date();
  const horizon = new Date(now.getTime() + WARNING_DAYS * 24 * 60 * 60 * 1000);

  // Join plans â†’ users to get telegram_chat_id (stored in tracked_wallets)
  // We use a direct supabase query; adapt column names to your schema.
  const { data, error } = await supabase
    .from("plans")
    .select("telegram_user_id, plan_name, wallet_limit, expires_at, warned_at")
    .neq("plan_name", "free")
    .eq("status", "active")
    .lte("expires_at", horizon.toISOString())
    .gte("expires_at", now.toISOString());

  if (error) {
    console.error("getExpiringPlans error", error);
    return [];
  }

  // Filter out users already warned in the past WARNING_DAYS days
  const warningCutoff = new Date(now.getTime() - WARNING_DAYS * 24 * 60 * 60 * 1000);
  return (data || []).filter((row) => {
    if (!row.warned_at) return true;
    return new Date(row.warned_at) < warningCutoff;
  });
}

/**
 * Returns the most recent active chat_id for a telegram_user_id.
 * We look it up from tracked_wallets (which stores telegram_chat_id).
 * Falls back to telegram_user_id itself (works for private chats).
 */
async function getChatIdForUser(telegramUserId) {
  const { data } = await supabase
    .from("tracked_wallets")
    .select("telegram_chat_id")
    .eq("telegram_user_id", telegramUserId)
    .limit(1)
    .maybeSingle();

  return data?.telegram_chat_id || telegramUserId;
}

/**
 * Marks a plan row as warned so we don't spam the same user.
 */
async function markWarned(telegramUserId) {
  const { error } = await supabase
    .from("plans")
    .update({ warned_at: new Date().toISOString() })
    .eq("telegram_user_id", String(telegramUserId));

  if (error) console.error("markWarned error", error);
}

// â”€â”€â”€ Main Job â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runExpiryWarnings() {
  if (!supabase) throw new Error("Supabase not initialised");

  const WARNING_DAYS = parseInt(process.env.EXPIRY_WARNING_DAYS || "3", 10);
  const plans = await getExpiringPlans(WARNING_DAYS);

  console.log("Expiry warning job: found " + plans.length + " plan(s) expiring within " + WARNING_DAYS + " days");

  let sent = 0;
  let failed = 0;

  for (const plan of plans) {
    const userId = plan.telegram_user_id;

    try {
      const chatId     = await getChatIdForUser(userId);
      const planLabel  = PLAN_LABELS[plan.plan_name] || plan.plan_name;
      const expiryStr  = formatDate(plan.expires_at);

      const daysLeft = Math.max(
        1,
        Math.ceil((new Date(plan.expires_at) - new Date()) / (1000 * 60 * 60 * 24))
      );

      const message = [
        "âš ï¸ <b>Plan Expiring Soon</b>",
        "",
        "Your <b>" + planLabel + "</b> plan expires in <b>" + daysLeft + " day" + (daysLeft === 1 ? "" : "s") + "</b>.",
        "ðŸ“… Expiry: " + expiryStr,
        "",
        "To keep tracking your " + plan.wallet_limit + " wallet" + (plan.wallet_limit === 1 ? "" : "s") + " without interruption, renew before it expires.",
        "",
        "Use /plan to view renewal options.",
      ].join("\n");

      await sendTelegramMessage(chatId, message);
      await markWarned(userId);
      sent++;

      console.log("Warning sent to user", userId);
    } catch (err) {
      console.error("Failed to warn user", userId, err);
      failed++;
    }
  }

  return { sent, failed, total: plans.length };
}

// â”€â”€â”€ HTTP Handler (Vercel API route) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

module.exports = async function handler(req, res) {
  // Allow both GET (cron scheduler ping) and POST
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Protect with CRON_SECRET
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    // Vercel cron passes it as Authorization: Bearer <secret>
    const authHeader = req.headers?.authorization || "";
    const provided   = authHeader.replace("Bearer ", "").trim();
    // Also allow query param for external schedulers: ?secret=xxx
    const querySecret = req.query?.secret || "";

    if (provided !== cronSecret && querySecret !== cronSecret) {
      console.warn("Expiry cron: unauthorized request");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  try {
    const result = await runExpiryWarnings();
    console.log("Expiry warning job complete", result);
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Expiry warning job failed", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// â”€â”€â”€ Direct execution (node cron/expiry-warning.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if (require.main === module) {
  runExpiryWarnings()
    .then((result) => { console.log("Done", result); process.exit(0); })
    .catch((err)   => { console.error(err); process.exit(1); });
}
