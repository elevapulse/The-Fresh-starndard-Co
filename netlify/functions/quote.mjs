function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function clean(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function sendResend(apiKey, fromEmail, lead) {
  if (!apiKey || !fromEmail) return { ok: false, skipped: true };

  const subject = `New cleaning quote request — ${lead.customer_name}`;
  const lines = [
    `Quote: ${lead.quote_number}`,
    `Name: ${lead.customer_name}`,
    `Email: ${lead.customer_email}`,
    `Phone: ${lead.customer_phone || ""}`,
    `Service: ${lead.service_type}`,
    `Property: ${lead.property_type || ""}`,
    `Frequency: ${lead.frequency || ""}`,
    `Bedrooms: ${lead.bedrooms ?? ""}`,
    `Bathrooms: ${lead.bathrooms ?? ""}`,
    `Sq Ft: ${lead.square_feet ?? ""}`,
    `ZIP: ${lead.zip_code || ""}`,
    `Notes: ${lead.notes || ""}`
  ];

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: fromEmail,
      to: ["thefreshstandardco@outlook.com"],
      subject,
      text: lines.join("\n")
    })
  });

  return { ok: r.ok, status: r.status };
}

async function sendTwilio(accountSid, authToken, fromNumber, lead) {
  if (!accountSid || !authToken || !fromNumber) return { ok: false, skipped: true };

  const body = `New quote ${lead.quote_number}: ${lead.customer_name} — ${lead.service_type} — ${lead.customer_phone || lead.customer_email}`;
  const form = new URLSearchParams();
  form.set("To", "+19543796765");
  form.set("From", fromNumber);
  form.set("Body", body);

  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form.toString()
  });

  return { ok: r.ok, status: r.status };
}

export default async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ ok: false, error: "Database environment variables are missing." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const now = new Date();
  const quoteNumber = `FS-${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;

  const lead = {
    quote_number: quoteNumber,
    customer_name: clean(body.name, 120),
    customer_email: clean(body.email, 320).toLowerCase(),
    customer_phone: clean(body.phone, 50),
    service_type: clean(body.service || body.service_type, 160),
    property_type: clean(body.property || body.property_type, 120),
    frequency: clean(body.frequency, 120),
    bedrooms: toInt(body.bedrooms),
    bathrooms: Number.isFinite(Number(body.bathrooms)) ? Number(body.bathrooms) : null,
    square_feet: toInt(body.sqft || body.square_feet),
    zip_code: clean(body.zip || body.zip_code, 20),
    notes: clean(body.notes, 2000),
    status: "new"
  };

  if (!lead.customer_name || !lead.customer_email.includes("@") || !lead.service_type) {
    return json({ ok: false, error: "Name, email, and service are required." }, 400);
  }

  const dbRes = await fetch(`${supabaseUrl.replace(/\/$/,"")}/rest/v1/quotes`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(lead)
  });

  const dbData = await dbRes.json().catch(() => null);

  if (!dbRes.ok) {
    return json({
      ok: false,
      error: dbData?.message || dbData?.error || "Could not save quote to database."
    }, 500);
  }

  const saved = Array.isArray(dbData) ? dbData[0] : dbData;

  let emailResult = { ok: false, skipped: true };
  let smsResult = { ok: false, skipped: true };

  try {
    emailResult = await sendResend(process.env.RESEND_API_KEY, process.env.FROM_EMAIL, lead);
  } catch {}

  try {
    smsResult = await sendTwilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      process.env.TWILIO_FROM_NUMBER,
      lead
    );
  } catch {}

  return json({
    ok: true,
    quote_number: saved?.quote_number || quoteNumber,
    quote_id: saved?.id || null,
    email_sent: !!emailResult.ok,
    sms_sent: !!smsResult.ok
  });
};