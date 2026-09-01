function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ ok: false, error: "Missing STRIPE_SECRET_KEY" }, 500);

  // Safety lock: this test endpoint must never run with a live Stripe key.
  if (!key.startsWith("sk_test_")) {
    return json({ ok: false, error: "Sandbox only: STRIPE_SECRET_KEY must be a test key." }, 403);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const name = String(body?.name || "Test Customer").slice(0, 200);
  const email = String(body?.email || "").trim().slice(0, 320);
  const quoteId = String(body?.quoteId || "TEST-001").slice(0, 200);

  if (!email || !email.includes("@")) {
    return json({ ok: false, error: "A valid email is required." }, 400);
  }

  const origin = new URL(request.url).origin;
  const successUrl = `${origin}/stripe-test.html?status=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/stripe-test.html?status=cancelled`;

  const params = new URLSearchParams();
  params.set("mode", "setup");
  params.append("payment_method_types[]", "card");
  params.set("customer_email", email);
  params.set("client_reference_id", quoteId);
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("metadata[quote_id]", quoteId);
  params.set("metadata[customer_name]", name);
  params.set("consent_collection[terms_of_service]", "required");

  try {
    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await stripeRes.json();

    if (!stripeRes.ok) {
      return json({
        ok: false,
        error: data?.error?.message || "Stripe Checkout session creation failed"
      }, stripeRes.status);
    }

    return json({ ok: true, url: data.url, id: data.id });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
};