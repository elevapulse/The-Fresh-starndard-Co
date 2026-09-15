function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

export default async (request) => {
  if (request.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Server configuration error." }, 500);
  }

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();

  if (!token) {
    return json({ ok: false, error: "Offer token is required." }, 400);
  }

  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?quote_token=eq.${encodeURIComponent(token)}` +
    `&select=id,quote_number,customer_name,service_type,property_type,frequency,bedrooms,bathrooms,square_feet,zip_code,quoted_price,status`;

  let dbRes;

  try {
    dbRes = await fetch(endpoint, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    });
  } catch {
    return json({ ok: false, error: "Could not connect to database." }, 500);
  }

  const data = await dbRes.json().catch(() => null);

  if (!dbRes.ok) {
    return json({ ok: false, error: "Could not retrieve offer." }, 500);
  }

  const quote = Array.isArray(data) ? data[0] : null;

  if (!quote || !quote.quoted_price) {
    return json({ ok: false, error: "Offer not found." }, 404);
  }

  return json({
    ok: true,
    offer: {
      quote_number: quote.quote_number,
      customer_name: quote.customer_name,
      service_type: quote.service_type,
      property_type: quote.property_type,
      frequency: quote.frequency,
      bedrooms: quote.bedrooms,
      bathrooms: quote.bathrooms,
      square_feet: quote.square_feet,
      zip_code: quote.zip_code,
      quoted_price: quote.quoted_price,
      status: quote.status
    }
  });
};
