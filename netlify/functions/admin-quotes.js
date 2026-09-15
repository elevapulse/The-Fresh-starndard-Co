function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

function getAdminPassword(request) {
  return String(
    request.headers.get("x-admin-password") || ""
  );
}

export default async (request) => {
  if (request.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  const suppliedPassword = getAdminPassword(request);

  if (!adminPassword) {
    return json({
      ok: false,
      error: "Admin authentication is not configured."
    }, 500);
  }

  if (
    !suppliedPassword ||
    suppliedPassword !== adminPassword
  ) {
    return json({
      ok: false,
      error: "Unauthorized."
    }, 401);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return json({
      ok: false,
      error: "Database configuration is missing."
    }, 500);
  }

  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?select=` +
    [
      "id",
      "quote_number",
      "customer_name",
      "customer_email",
      "customer_phone",
      "service_type",
      "property_type",
      "frequency",
      "bedrooms",
      "bathrooms",
      "square_feet",
      "zip_code",
      "notes",
      "status",
      "quoted_price",
      "quote_token",
      "quote_sent_at",
      "quote_accepted_at",
      "stripe_customer_id",
      "stripe_setup_session_id",
      "stripe_payment_method_id",
      "card_saved_at",
      "scheduled_for",
      "completed_at",
      "charged_at",
      "created_at"
    ].join(",") +
    `&order=created_at.desc` +
    `&limit=100`;

  let response;

  try {
    response = await fetch(endpoint, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`
      }
    });
  } catch (error) {
    return json({
      ok: false,
      error: "Could not connect to database.",
      detail: error?.message || null
    }, 500);
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return json({
      ok: false,
      error:
        data?.message ||
        data?.error ||
        "Could not retrieve quotes."
    }, 500);
  }

  return json({
    ok: true,
    quotes: Array.isArray(data) ? data : []
  });
};
