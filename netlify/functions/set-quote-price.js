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

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return json({
      ok: false,
      error: "Database environment variables are missing."
    }, 500);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const quoteId = String(body.quote_id || "").trim();
  const price = Number(body.price);

  if (!quoteId) {
    return json({ ok: false, error: "Quote ID is required." }, 400);
  }

  if (!Number.isFinite(price) || price <= 0) {
    return json({ ok: false, error: "Valid price is required." }, 400);
  }

  // Convert dollars to cents server-side.
  const quotedPrice = Math.round(price * 100);

  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}`;

  let dbRes;

  try {
    dbRes = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        quoted_price: quotedPrice,
        status: "quoted"
      })
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Could not connect to database.",
      detail: error?.message || null
    }, 500);
  }

  const dbData = await dbRes.json().catch(() => null);

  if (!dbRes.ok) {
    return json({
      ok: false,
      error:
        dbData?.message ||
        dbData?.error ||
        "Could not update quote."
    }, 500);
  }

  const quote = Array.isArray(dbData) ? dbData[0] : dbData;

  if (!quote) {
    return json({ ok: false, error: "Quote not found." }, 404);
  }

  return json({
    ok: true,
    quote_id: quote.id,
    quote_number: quote.quote_number,
    quoted_price: quote.quoted_price,
    offer_url:
      `https://thefreshstandardco.com/offer/?token=${quote.quote_token}`
  });
};
