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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(cents) {
  const amount = Number(cents);

  if (!Number.isFinite(amount)) {
    return "—";
  }

  return (amount / 100).toLocaleString(
    "en-US",
    {
      style: "currency",
      currency: "USD"
    }
  );
}

function formatDate(value) {
  if (!value) {
    return "Not scheduled";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Not scheduled";
  }

  return date.toLocaleString(
    "en-US",
    {
      timeZone: "America/New_York",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    }
  );
}

async function sendEmail({
  apiKey,
  from,
  to,
  subject,
  text,
  html
}) {
  const response = await fetch(
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
        from,
        to,
        subject,
        text,
        html
      })
    }
  );

  const data = await response
    .json()
    .catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

export default async (request) => {

  /*
    METHOD
  */

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Method not allowed."
      },
      405
    );
  }


  /*
    SERVER CONFIGURATION
  */

  const adminPassword =
    process.env.ADMIN_PASSWORD;

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (
    !adminPassword ||
    !supabaseUrl ||
    !serviceRoleKey
  ) {
    return json(
      {
        ok: false,
        error:
          "Server configuration is incomplete."
      },
      500
    );
  }


  /*
    ADMIN AUTHENTICATION
  */

  const suppliedPassword =
    String(
      request.headers.get(
        "x-admin-password"
      ) || ""
    );

  if (
    suppliedPassword !== adminPassword
  ) {
    return json(
      {
        ok: false,
        error: "Unauthorized."
      },
      401
    );
  }


  /*
    REQUEST BODY
  */

  let body;

  try {
    body =
      await request.json();
  } catch {
    return json(
      {
        ok: false,
        error:
          "Invalid JSON body."
      },
      400
    );
  }

  const quoteId =
    String(
      body.quote_id || ""
    ).trim();

  if (!quoteId) {
    return json(
      {
        ok: false,
        error:
          "Quote ID is required."
      },
      400
    );
  }


  /*
    GET CURRENT BOOKING

    Never trust status, amount,
    customer or payment information
    supplied by the browser.
  */

  const quoteEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}` +
    `&select=*`;

  let quoteResponse;

  try {

    quoteResponse =
      await fetch(
        quoteEndpoint,
        {
          headers: {
            apikey:
              serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`
          }
        }
      );

  } catch (error) {

    return json(
      {
        ok: false,

        error:
          "Could not connect to database.",

        detail:
          error?.message || null
      },
      500
    );
  }

  const quoteData =
    await quoteResponse
      .json()
      .catch(() => null);

  if (!quoteResponse.ok) {
    return json(
      {
        ok: false,

        error:
          quoteData?.message ||
          quoteData?.error ||
          "Could not retrieve booking."
      },
      500
    );
  }

  const quote =
    Array.isArray(quoteData)
      ? quoteData[0]
      : null;

  if (!quote) {
    return json(
      {
        ok: false,
        error:
          "Booking not found."
      },
      404
    );
  }


  /*
    ALREADY COMPLETED

    Do not update again.
    Do not send duplicate emails.
  */

  if (quote.status === "completed") {
    return json({
      ok: true,

      already_completed:
        true,

      message:
        "Cleaning was already marked complete.",

      quote_id:
        quote.id,

      quote_number:
        quote.quote_number ||
        null,

      status:
        "completed",

      completed_at:
        quote.completed_at ||
        null,

      quoted_price:
        quote.quoted_price,

      customer_email_sent:
        false,

      owner_email_sent:
        false
    });
  }


  /*
    NEVER COMPLETE CANCELLED OR
    CHARGED BOOKINGS.
  */

  if (quote.status === "cancelled") {
    return json(
      {
        ok: false,
        error:
          "A cancelled booking cannot be marked complete."
      },
      409
    );
  }

  if (
    quote.status === "charged" ||
    quote.stripe_payment_intent_id
  ) {
    return json(
      {
        ok: false,
        error:
          "This booking has already been charged."
      },
      409
    );
  }


  /*
    ONLY ACTIVE SECURED BOOKINGS.

    accepted is included for compatibility
    with older records, but a real saved
    Stripe payment method is still required.
  */

  const allowedStatuses = [
    "accepted",
    "card_saved",
    "booked"
  ];

  if (
    !allowedStatuses.includes(
      quote.status
    )
  ) {
    return json(
      {
        ok: false,

        error:
          `This booking cannot be completed while its status is "${quote.status}".`
      },
      409
    );
  }


  /*
    PAYMENT METHOD SAFETY CHECK

    Completing a cleaning does NOT charge
    this payment method.

    We only verify that the secured booking
    actually has one.
  */

  if (
    !quote.stripe_customer_id ||
    !quote.stripe_payment_method_id
  ) {
    return json(
      {
        ok: false,

        error:
          "This booking does not have a saved payment method."
      },
      400
    );
  }


  /*
    MARK CLEANING COMPLETE

    IMPORTANT:

    NO Stripe API call occurs here.
    NO PaymentIntent is created.
    NO charge occurs.

    This ONLY changes our booking record.
  */

  const completedAt =
    new Date().toISOString();

  const updateEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}`;

  let updateResponse;

  try {

    updateResponse =
      await fetch(
        updateEndpoint,
        {
          method: "PATCH",

          headers: {
            apikey:
              serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`,

            "content-type":
              "application/json",

            Prefer:
              "return=representation"
          },

          body:
            JSON.stringify({
              status:
                "completed",

              completed_at:
                completedAt
            })
        }
      );

  } catch (error) {

    return json(
      {
        ok: false,

        error:
          "Could not update booking.",

        detail:
          error?.message || null
      },
      500
    );
  }

  const updatedData =
    await updateResponse
      .json()
      .catch(() => null);

  if (!updateResponse.ok) {
    return json(
      {
        ok: false,

        error:
          updatedData?.message ||
          updatedData?.error ||
          "Could not mark cleaning complete."
      },
      500
    );
  }

  const updatedQuote =
    Array.isArray(updatedData)
      ? updatedData[0]
      : updatedData;

  if (!updatedQuote) {
    return json(
      {
        ok: false,

        error:
          "Cleaning completion could not be confirmed."
      },
      500
    );
  }


  /*
    EMAIL DATA
  */

  const resendApiKey =
    process.env.RESEND_API_KEY;

  const fromEmail =
    process.env.FROM_EMAIL;

  const amount =
    formatMoney(
      quote.quoted_price
    );

  const scheduledDate =
    formatDate(
      quote.scheduled_for
    );

  const completionDate =
    formatDate(
      updatedQuote.completed_at ||
      completedAt
    );

  let customerEmailSent =
    false;

  let ownerEmailSent =
    false;


  /*
    CUSTOMER COMPLETION EMAIL

    IMPORTANT:

    This explicitly tells the customer
    that their card has NOT been charged.

    Email failure does NOT undo the
    completed booking.
  */

  if (
    resendApiKey &&
    fromEmail &&
    quote.customer_email
  ) {

    const customerName =
      quote.customer_name ||
      "there";

    const safeName =
      escapeHtml(
        customerName
      );

    const safeQuote =
      escapeHtml(
        quote.quote_number ||
        quote.id
      );

    const safeService =
      escapeHtml(
        quote.service_type ||
        "Cleaning Service"
      );

    const safeAmount =
      escapeHtml(
        amount
      );

    const safeSchedule =
      escapeHtml(
        scheduledDate
      );

    const customerText = [
      `Hi ${customerName},`,
      "",
      "Your cleaning with The Fresh Standard Co. has been marked complete.",
      "",
      `Service: ${quote.service_type || "Cleaning Service"}`,
      `Booking reference: ${quote.quote_number || quote.id}`,
      `Quoted amount: ${amount}`,
      "",
      "Your saved payment method has NOT been charged yet.",
      "",
      "Thank you for choosing The Fresh Standard Co.",
      "",
      "Phone: 954-379-6765",
      "Email: thefreshstandardco@outlook.com"
    ].join("\n");

    const customerHtml = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f4f1e9;
    font-family:Arial,sans-serif;
    color:#1c2823;
  "
>

<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
  style="
    width:100%;
    background:#f4f1e9;
    padding:36px 16px;
  "
>

<tr>
<td align="center">

<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
  style="
    width:100%;
    max-width:620px;
    background:#fffdf8;
    border-radius:24px;
    overflow:hidden;
    border:1px solid #dce2dc;
  "
>

<tr>
<td
  style="
    background:#17352b;
    padding:30px 34px;
    color:#ffffff;
  "
>

<div
  style="
    font-family:Georgia,serif;
    font-size:23px;
    letter-spacing:2px;
  "
>
  THE FRESH
</div>

<div
  style="
    margin-top:4px;
    color:#c8d3cc;
    font-size:11px;
    letter-spacing:3px;
    text-transform:uppercase;
  "
>
  Standard Co.
</div>

</td>
</tr>

<tr>
<td
  style="
    padding:42px 36px;
  "
>

<div
  style="
    color:#718679;
    font-size:11px;
    font-weight:700;
    letter-spacing:2px;
    text-transform:uppercase;
    margin-bottom:10px;
  "
>
  Service Completed
</div>

<h1
  style="
    margin:0;
    color:#17352b;
    font-family:Georgia,serif;
    font-size:34px;
    font-weight:400;
    line-height:1.2;
  "
>
  Your cleaning is complete.
</h1>

<p
  style="
    margin:18px 0 0;
    color:#69756f;
    font-size:16px;
    line-height:1.7;
  "
>
  Hi ${safeName}, thank you for choosing
  The Fresh Standard Co. Your cleaning
  has now been marked complete.
</p>

<div
  style="
    margin-top:28px;
    padding:24px;
    background:#eef2ed;
    border-radius:18px;
  "
>

<div
  style="
    color:#69756f;
    font-size:10px;
    font-weight:700;
    letter-spacing:1.5px;
    text-transform:uppercase;
  "
>
  Service Status
</div>

<div
  style="
    margin-top:7px;
    color:#17352b;
    font-family:Georgia,serif;
    font-size:26px;
  "
>
  Cleaning Completed ✓
</div>

</div>

<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
  style="
    margin-top:24px;
    border-collapse:collapse;
  "
>

<tr>
<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Service
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${safeService}
</td>
</tr>

<tr>
<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Scheduled Appointment
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${safeSchedule}
</td>
</tr>

<tr>
<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Service Amount
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${safeAmount}
</td>
</tr>

<tr>
<td
  style="
    padding:12px 0;
    color:#69756f;
    font-size:13px;
  "
>
  Booking Reference
</td>

<td
  align="right"
  style="
    padding:12px 0;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${safeQuote}
</td>
</tr>

</table>

<div
  style="
    margin-top:26px;
    padding:18px;
    background:#f7f5ef;
    border:1px solid #e5e8e3;
    border-radius:15px;
    color:#17352b;
    font-size:14px;
    line-height:1.65;
  "
>
  <strong>Payment status:</strong>
  Your saved payment method has
  <strong>not been charged yet.</strong>
</div>

<p
  style="
    margin:24px 0 0;
    color:#69756f;
    font-size:14px;
    line-height:1.7;
  "
>
  If you have any questions about your
  cleaning, please contact us.
</p>

<p
  style="
    margin:18px 0 0;
    color:#69756f;
    font-size:14px;
    line-height:1.7;
  "
>
  Phone:
  <strong style="color:#17352b;">
    954-379-6765
  </strong>
  <br>

  Email:
  <strong style="color:#17352b;">
    thefreshstandardco@outlook.com
  </strong>
</p>

</td>
</tr>

<tr>
<td
  style="
    padding:22px 36px;
    background:#f7f5ef;
    border-top:1px solid #e5e8e3;
    color:#718079;
    font-size:12px;
    line-height:1.6;
  "
>
  The Fresh Standard Co.<br>
  Professional cleaning, held to a higher standard.
</td>
</tr>

</table>

</td>
</tr>

</table>

</body>
</html>
`;

    try {

      const result =
        await sendEmail({
          apiKey:
            resendApiKey,

          from:
            fromEmail,

          to: [
            quote.customer_email
          ],

          subject:
            `Your cleaning is complete — ${quote.quote_number || "The Fresh Standard Co."}`,

          text:
            customerText,

          html:
            customerHtml
        });

      customerEmailSent =
        result.ok;

      if (!result.ok) {
        console.error(
          "Customer completion email failed:",
          result.status,
          result.data
        );
      }

    } catch (error) {

      console.error(
        "Customer completion email error:",
        error
      );
    }
  }


  /*
    OWNER COMPLETION EMAIL
  */

  if (
    resendApiKey &&
    fromEmail
  ) {

    const ownerText = [
      "A cleaning has been marked complete.",
      "",
      `Quote: ${quote.quote_number || quoteId}`,
      `Customer: ${quote.customer_name || ""}`,
      `Email: ${quote.customer_email || ""}`,
      `Phone: ${quote.customer_phone || ""}`,
      "",
      `Service: ${quote.service_type || ""}`,
      `Scheduled Date: ${scheduledDate}`,
      `Completed At: ${completionDate}`,
      `Amount Due: ${amount}`,
      "",
      "Status: COMPLETED",
      "Customer charged: NO",
      "",
      customerEmailSent
        ? "Customer completion email: Sent successfully."
        : "Customer completion email: Not sent or failed.",
      "",
      "The booking is now ready for the separate Charge Customer step."
    ].join("\n");

    const ownerHtml = `
<div
  style="
    font-family:Arial,sans-serif;
    max-width:620px;
    margin:auto;
    color:#1c2823;
  "
>

<h2
  style="
    color:#17352b;
  "
>
  Cleaning Completed
</h2>

<p>
  <strong>Quote:</strong>
  ${escapeHtml(
    quote.quote_number ||
    quoteId
  )}
</p>

<p>
  <strong>Customer:</strong>
  ${escapeHtml(
    quote.customer_name ||
    ""
  )}
</p>

<p>
  <strong>Email:</strong>
  ${escapeHtml(
    quote.customer_email ||
    ""
  )}
</p>

<p>
  <strong>Phone:</strong>
  ${escapeHtml(
    quote.customer_phone ||
    ""
  )}
</p>

<hr
  style="
    border:0;
    border-top:1px solid #dce2dc;
    margin:24px 0;
  "
>

<p>
  <strong>Service:</strong><br>
  ${escapeHtml(
    quote.service_type ||
    "—"
  )}
</p>

<p>
  <strong>Scheduled date:</strong><br>
  ${escapeHtml(
    scheduledDate
  )}
</p>

<p>
  <strong>Completed at:</strong><br>
  ${escapeHtml(
    completionDate
  )}
</p>

<p>
  <strong>Amount due:</strong><br>
  ${escapeHtml(
    amount
  )}
</p>

<p>
  <strong>Customer charged:</strong><br>
  NO
</p>

<p>
  <strong>Customer completion email:</strong><br>
  ${
    customerEmailSent
      ? "Sent successfully"
      : "Not sent or failed"
  }
</p>

<div
  style="
    margin-top:24px;
    padding:16px;
    border-radius:12px;
    background:#eef2ed;
    color:#17352b;
    line-height:1.6;
  "
>
  The cleaning is complete and is now
  ready for the separate
  <strong>Charge Customer</strong> step.
</div>

</div>
`;

    try {

      const result =
        await sendEmail({
          apiKey:
            resendApiKey,

          from:
            fromEmail,

          to: [
            "thefreshstandardco@outlook.com"
          ],

          subject:
            `Cleaning Completed — ${quote.quote_number || quoteId}`,

          text:
            ownerText,

          html:
            ownerHtml
        });

      ownerEmailSent =
        result.ok;

      if (!result.ok) {
        console.error(
          "Owner completion email failed:",
          result.status,
          result.data
        );
      }

    } catch (error) {

      console.error(
        "Owner completion email error:",
        error
      );
    }
  }


  /*
    FINAL RESPONSE

    No payment has been created
    or processed by this function.
  */

  return json({
    ok: true,

    message:
      "Cleaning marked complete. Customer has not been charged.",

    quote_id:
      updatedQuote.id ||
      quoteId,

    quote_number:
      updatedQuote.quote_number ||
      quote.quote_number ||
      null,

    status:
      updatedQuote.status ||
      "completed",

    completed_at:
      updatedQuote.completed_at ||
      completedAt,

    quoted_price:
      quote.quoted_price,

    charged:
      false,

    customer_email_sent:
      customerEmailSent,

    owner_email_sent:
      ownerEmailSent
  });
};
