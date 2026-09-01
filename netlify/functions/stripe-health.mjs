export default async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: "Missing STRIPE_SECRET_KEY" }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }

  try {
    const res = await fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${key}` }
    });
    const data = await res.json();

    if (!res.ok) {
      return new Response(JSON.stringify({
        ok: false,
        error: data?.error?.message || "Stripe account check failed"
      }), {
        status: res.status,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      livemode: !!data.livemode,
      business_name:
        data?.business_profile?.name ||
        data?.settings?.dashboard?.display_name ||
        data?.display_name ||
        null
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
};