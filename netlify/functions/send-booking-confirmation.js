function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPrice(cents) {
  const amount = Number(cents);

  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }

  return (amount / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD"
  });
}

async function getQuote(
  quoteId,
  supabaseUrl,
  serviceRoleKey
) {
  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}` +
    `&select=*`;

  const response = await fetch(endpoint, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });

  const data = await response
    .json()
    .catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Could not retrieve quote."
    );
  }

  return Array.isArray(data)
    ? data[0]
    : null;
}

async function sendEmail(
  apiKey,
  fromEmail,
  quote
) {
  const customerEmail =
    String(quote.customer_email || "").trim();

  if (!customerEmail) {
    throw new Error(
      "Quote does not contain a customer email."
    );
  }

  const customerName =
    String(quote.customer_name || "").trim();

  const firstName =
    customerName
      ? customerName.split(/\s+/)[0]
      : "there";

  const quoteNumber =
    quote.quote_number || "—";

  const service =
    quote.service_type || "Cleaning Service";

  const property =
    quote.property_type || "—";

  const price =
    formatPrice(quote.quoted_price);

  if (!price) {
    throw new Error(
      "Quote does not contain a valid quoted price."
    );
  }

  const subject =
    "Booking Confirmed — The Fresh Standard Co.";

  const text = [
    `Hi ${firstName},`,
    "",
    "Your cleaning booking with The Fresh Standard Co. has been confirmed.",
    "",
    `Quote: ${quoteNumber}`,
    `Service: ${service}`,
    `Property: ${property}`,
    `Quoted Price: ${price}`,
    "",
    "Your payment method has been securely saved through Stripe.",
    "",
    "You have not been charged at this time.",
    "",
    "After your cleaning service is completed, The Fresh Standard Co. will charge the agreed quoted amount to your saved payment method in accordance with the payment authorization you accepted when confirming your booking.",
    "",
    "If you have any questions or need to make changes to your booking, contact us:",
    "",
    "954-379-6765",
    "thefreshstandardco@outlook.com",
    "",
    "Thank you for choosing The Fresh Standard Co."
  ].join("\n");

  const html = `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f1e9;font-family:Arial,Helvetica,sans-serif;color:#17352b;">

  <div style="max-width:620px;margin:0 auto;padding:40px 20px;">

    <div style="background:#fffdf8;border-radius:24px;padding:42px;">

      <div style="text-align:center;margin-bottom:34px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:25px;letter-spacing:2px;font-weight:600;">
          THE FRESH
        </div>

        <div style="margin-top:6px;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#758b78;">
          Standard Co.
        </div>
      </div>

      <div style="text-align:center;text-transform:uppercase;letter-spacing:3px;font-size:11px;font-weight:700;color:#758b78;margin-bottom:12px;">
        Booking Confirmed
      </div>

      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:400;text-align:center;margin:0 0 16px;color:#17352b;">
        You're all set.
      </h1>

      <p style="font-size:16px;line-height:1.7;color:#64716b;text-align:center;margin:0 0 34px;">
        Hi ${escapeHtml(firstName)}, your cleaning booking with
        The Fresh Standard Co. has been confirmed.
      </p>

      <div style="border-top:1px solid #e6e5df;border-bottom:1px solid #e6e5df;padding:22px 0;margin-bottom:30px;">

        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">Quote:</strong>
          ${escapeHtml(quoteNumber)}
        </p>

        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">Service:</strong>
          ${escapeHtml(service)}
        </p>

        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">Property:</strong>
          ${escapeHtml(property)}
        </p>

        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">Quoted Price:</strong>
          ${escapeHtml(price)}
        </p>

      </div>

      <div style="background:#f7f7f2;border:1px solid #e1e5de;border-radius:16px;padding:20px;margin-bottom:28px;">

        <div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;margin-bottom:8px;color:#17352b;">
          Payment secured
        </div>

        <p style="font-size:14px;line-height:1.65;color:#69736e;margin:0;">
          Your payment method has been securely saved through Stripe.
          You have not been charged at this time. After your cleaning
          service is completed, The Fresh Standard Co. will charge the
          agreed quoted amount to your saved payment method in accordance
          with the payment authorization you accepted when confirming
          your booking.
        </p>

      </div>

      <p style="font-size:14px;line-height:1.7;color:#69736e;text-align:center;margin:0;">
        Need to make a change or have a question?<br>
        <a href="tel:+19543796765" style="color:#17352b;font-weight:600;text-decoration:none;">
          954-379-6765
        </a>
        <br>
        <a href="mailto:thefreshstandardco@outlook.com" style="color:#17352b;font-weight:600;text-decoration:none;">
          thefreshstandardco@outlook.com
        </a>
      </p>

    </div>

  </div>

</body>
</html>
  `.trim();

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${apiKey}`,

          "content-type":
            "application/json"
        },

        body: JSON.stringify({
          from:
            fromEmail,

          to: [
            customerEmail
          ],

          subject,
          text,
          html
        })
      }
    );

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      `Resend returned status ${response.status}.`
    );
  }

  return data;
}

export default async (request) => {
  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Method not allowed"
      },
      405
    );
  }

  const internalSecret =
    process.env.ADMIN_PASSWORD;

  const suppliedSecret =
    String(
      request.headers.get(
        "x-internal-secret"
      ) || ""
    );

  if (
    !internalSecret ||
    !suppliedSecret ||
    suppliedSecret !== internalSecret
  ) {
    return json(
      {
        ok: false,
        error: "Unauthorized."
      },
      401
    );
  }

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  const resendApiKey =
    process.env.RESEND_API_KEY;

  const fromEmail =
    process.env.FROM_EMAIL;

  if (
    !supabaseUrl ||
    !serviceRoleKey ||
    !resendApiKey ||
    !fromEmail
  ) {
    return json(
      {
        ok: false,
        error:
          "Required environment variables are missing."
      },
      500
    );
  }

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        ok: false,
        error: "Invalid JSON body."
      },
      400
    );
  }

  const quoteId =
    String(body.quote_id || "").trim();

  if (!quoteId) {
    return json(
      {
        ok: false,
        error: "quote_id is required."
      },
      400
    );
  }

  try {
    const quote =
      await getQuote(
        quoteId,
        supabaseUrl,
        serviceRoleKey
      );

    if (!quote) {
      return json(
        {
          ok: false,
          error: "Quote not found."
        },
        404
      );
    }

    if (
      quote.status !== "card_saved" &&
      quote.status !== "booked"
    ) {
      return json(
        {
          ok: false,
          error:
            "Booking confirmation can only be sent after the payment method has been saved."
        },
        409
      );
    }

    const email =
      await sendEmail(
        resendApiKey,
        fromEmail,
        quote
      );

    console.log(
      "Booking confirmation email sent:",
      quoteId,
      quote.customer_email,
      email?.id || null
    );

    return json({
      ok: true,
      sent: true,
      quote_id:
        quoteId,
      email_id:
        email?.id || null
    });

  } catch (error) {
    console.error(
      "Booking confirmation email failed:",
      error.message
    );

    return json(
      {
        ok: false,
        sent: false,
        error:
          "Could not send booking confirmation.",
        detail:
          error.message
      },
      500
    );
  }
};
