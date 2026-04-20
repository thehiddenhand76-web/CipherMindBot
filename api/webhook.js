const { createClient } = require("@supabase/supabase-js");

const PAYMENT_WALLET = "8Lj1BrUCmbRY1p4PBNsdYyUxmRYKrBj5FZgff3ttjz8j";
const FREE_WALLET_LIMIT = 10;

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

// In-memory session state (resets on redeploy, fine for MVP)
const userSessions = {};

function formatDate(date) {
  return new Date(date).toLocaleString();
}

function isValidSolanaAddress(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function getCommand(text) {
  return (text || "").trim().split(/\s+/)[0].split("@")[0].toLowerCase();
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  const tgRes = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
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
      telegram_user_id: telegramUserId,
      username: username,
    },
    {
      onConflict: "telegram_user_id",
    }
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
  if (!supabase) {
    throw new Error("Supabase client not initialized");
  }

  const { data, error } = await supabase
    .from("plans")
    .select("plan_name, wallet_limit, status, updated_at")
    .eq("telegram_user_id", String(telegramUserId))
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getTrackedWallets(telegramUserId) {
  const { data, error } = await supabase
    .from("trackedwallets")
    .select("id, wallet_address, label, created_at")
    .eq("telegram_user_id", String(telegramUserId))
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function addTrackedWallet(telegramUserId, walletAddress, label) {
  const currentPlan = await getUserPlan(telegramUserId);

  if (!currentPlan) {
    return { ok: false, message: "No saved plan found. Send /start first." };
  }

  const existingWallets = await getTrackedWallets(telegramUserId);

  if (existingWallets.find(function(w) { return w.wallet_address === walletAddress; })) {
    return { ok: false, message: "That wallet is already being tracked." };
  }

  if (existingWallets.length >= currentPlan.wallet_limit) {
    return {
      ok: false,
      message: "You reached your wallet limit of " + currentPlan.wallet_limit + ". Use /pricing or /pay to upgrade.",
    };
  }

  const { error } = await supabase.from("trackedwallets").insert({
    telegram_user_id: String(telegramUserId),
    wallet_address: walletAddress,
    label: label || null,
  });

  if (error) throw error;

  return { ok: true, message: "Wallet added successfully." };
}

async function removeTrackedWallet(telegramUserId, walletAddress) {
  const { data, error } = await supabase
    .from("trackedwallets")
    .delete()
    .eq("telegram_user_id", String(telegramUserId))
    .eq("wallet_address", walletAddress)
    .select("id");

  if (error) throw error;

  if (!data || data.length === 0) {
    return { ok: false, message: "That wallet was not found in your tracked list." };
  }

  return { ok: true, message: "Wallet removed successfully." };
}

module.exports = async function handler(req, res) {
  console.log("Webhook hit", {
    method: req.method,
    hasBody: !!req.body,
  });

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
  const userId = fromUser ? String(fromUser.id) : null;
  const command = getCommand(text);
  const parts = text.split(/\s+/);

  console.log("Incoming message", { chatId, text, command });

  try {
    if (!chatId || !userId) {
      console.error("Missing chatId or userId");
      return res.status(200).json({ ok: true, message: "Missing chatId or userId" });
    }

    if (!supabase) {
      console.error("Missing Supabase environment variables");
      await sendTelegramMessage(
        chatId,
        "Database is not configured yet. Add SUPABASEURL and SUPABASESERVICEROLEKEY in Vercel."
      );
      return res.status(200).json({ ok: true });
    }

    // --- Handle step-by-step /addwallet session ---
    const session = userSessions[userId];

    if (session && session.step === "awaiting_address") {
      // User is entering their wallet address
      const walletAddress = text;

      if (command.startsWith("/")) {
        // User cancelled by sending another command
        delete userSessions[userId];
      } else if (!isValidSolanaAddress(walletAddress)) {
        await sendTelegramMessage(
          chatId,
          "That does not look like a valid Solana wallet address. Please try again or send /cancel to stop."
        );
        return res.status(200).json({ ok: true });
      } else {
        // Valid address — ask for a name
        userSessions[userId] = { step: "awaiting_label", walletAddress: walletAddress };
        await sendTelegramMessage(
          chatId,
          "Step 2: Enter a name for this wallet. Or send /skip to add it without a name."
        );
        return res.status(200).json({ ok: true });
      }
    }

    if (session && session.step === "awaiting_label") {
      // User is entering a label for their wallet
      if (command.startsWith("/") && command !== "/skip") {
        // User cancelled by sending another command
        delete userSessions[userId];
      } else {
        const label = command === "/skip" ? null : text;
        const walletAddress = session.walletAddress;
        delete userSessions[userId];

        const result = await addTrackedWallet(userId, walletAddress, label);

        await sendTelegramMessage(
          chatId,
          result.ok
            ? "Wallet saved! Address: " + walletAddress + (label ? "\nName: " + label : "")
            : result.message
        );
        return res.status(200).json({ ok: true });
      }
    }

    // --- Standard commands ---

    if (command === "/cancel") {
      delete userSessions[userId];
      await sendTelegramMessage(chatId, "Cancelled.");
      return res.status(200).json({ ok: true });
    }

    if (command === "/start") {
      if (fromUser) {
        await ensureUserAndFreePlan(fromUser);
      }

      await sendTelegramMessage(
        chatId,
        "Hello! I'm CipherMind. Your account has been set up. Use /pricing to see plans. Use /payment to see the payment wallet. Use /plan to see your current plan."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pricing") {
      await sendTelegramMessage(
        chatId,
        "Subscription Plans: First 10 wallets free. 50 wallets: " +
          PLANS[50].monthly.toFixed(2) +
          " SOL per month. 100 wallets: " +
          PLANS[100].monthly.toFixed(2) +
          " SOL per month. 200 wallets: " +
          PLANS[200].monthly.toFixed(2) +
          " SOL per month. Use /payment to see the payment wallet."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/payment") {
      await sendTelegramMessage(
        chatId,
        "Payment Wallet: " +
          PAYMENT_WALLET +
          " Send payment in Solana SOL only to this wallet for monthly access."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/plan") {
      const userPlan = await getUserPlan(userId);

      if (!userPlan) {
        await sendTelegramMessage(
          chatId,
          "No saved plan was found yet. Send /start first to create your free plan."
        );
        return res.status(200).json({ ok: true });
      }

      await sendTelegramMessage(
        chatId,
        "Your Current Plan: Plan " +
          userPlan.plan_name +
          ", wallet limit " +
          userPlan.wallet_limit +
          ", status " +
          userPlan.status +
          ", updated " +
          formatDate(userPlan.updated_at)
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/pay") {
      await sendTelegramMessage(
        chatId,
        "To subscribe, send payment in Solana SOL to " +
          PAYMENT_WALLET +
          " and then message support with your requested plan: 50, 100, or 200 wallets."
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/addwallet") {
      // Start the step-by-step flow
      userSessions[userId] = { step: "awaiting_address" };
      await sendTelegramMessage(
        chatId,
        "Step 1: Enter your Solana wallet address:"
      );
      return res.status(200).json({ ok: true });
    }

    if (command === "/wallets") {
      const wallets = await getTrackedWallets(userId);

      if (!wallets.length) {
        await sendTelegramMessage(
          chatId,
          "You are not tracking any wallets yet. Use /addwallet to add one."
        );
        return res.status(200).json({ ok: true });
      }

      const formatted = wallets
        .map(function(wallet, index) {
          return (index + 1) + ". " + wallet.wallet_address + (wallet.label ? " (" + wallet.label + ")" : "");
        })
        .join("\n");

      await sendTelegramMessage(chatId, "Your Tracked Wallets:\n\n" + formatted);
      return res.status(200).json({ ok: true });
    }

    if (command === "/removewallet") {
      if (parts.length < 2) {
        await sendTelegramMessage(chatId, "Usage: /removewallet WALLET_ADDRESS");
        return res.status(200).json({ ok: true });
      }

      const walletAddress = parts[1];
      const result = await removeTrackedWallet(userId, walletAddress);

      await sendTelegramMessage(chatId, result.message);
      return res.status(200).json({ ok: true });
    }

    // --- AI fallback — only for non-commands ---
    if (command.startsWith("/")) {
      await sendTelegramMessage(chatId, "Unknown command. Use /start, /plan, /pricing, /payment, /pay, /addwallet, /wallets, or /removewallet.");
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
        Authorization: "Bearer " + groqKey,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are CipherMind, a helpful Telegram assistant focused on Solana crypto." },
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

    const reply =
      aiData &&
      aiData.choices &&
      aiData.choices[0] &&
      aiData.choices[0].message &&
      aiData.choices[0].message.content
        ? aiData.choices[0].message.content
        : "No response.";

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
