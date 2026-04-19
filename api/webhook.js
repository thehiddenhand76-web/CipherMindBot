// /pay <plan> monthly
if (text.startsWith("/pay ")) {
  // split on whitespace
  const parts = text.split(/s+/);
  const plan = Number(parts[1]);
  const duration = (parts[2] || "").toLowerCase();

  if (!PLANS[plan] || duration !== "monthly") {
    await sendTelegramMessage(
      chatId,
      `Invalid payment command.

Use:
/pay 50 monthly
/pay 100 monthly
/pay 200 monthly`
    );
    return res.status(200).json({ ok: true });
  }

  const amount = PLANS[plan].monthly;
  const reference = generatePaymentReference(chatId, plan);

  // Keep in‑memory tracking for now
  pendingPayments.set(reference, {
    chatId,
    plan,
    duration,
    amount,
    wallet: PAYMENT_WALLET,
    createdAt: new Date().toISOString(),
    status: "pending",
  });

  // Supabase pending_payments insert
  try {
    const telegramUserId = String(chatId);

    const { error: payError } = await supabase
      .from("pending_payments")
      .insert({
        telegram_user_id: telegramUserId,
        plan_requested: String(plan),
        amount,
        billing_cycle: duration,
        status: "pending",
      });

    if (payError) {
      console.error("Supabase insert pending_payments failed", payError);
    }
  } catch (e) {
    console.error("Supabase pending_payments insert error", e);
  }

  await sendTelegramMessage(
    chatId,
    `Subscription Payment

Plan: ${plan} wallets
Price: ${amount.toFixed(2)} SOL
Duration: monthly

Send payment to:
${PAYMENT_WALLET}

Reference:
${reference}

After manual confirmation, activate with:
/activate ${reference}`
  );
  return res.status(200).json({ ok: true });
}
