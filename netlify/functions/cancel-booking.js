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

function formatCleaningDate(value) {
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
          from,
          to,
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
    ADMIN AUTHENTICATION
  */

  const suppliedPassword =
    String(
      request.headers.get(
        "x-admin-password"
      ) || ""
    );

  const expectedPassword =
    process.env.ADMIN_PASSWORD;

  if (
    !expectedPassword ||
    suppliedPassword !== expectedPassword
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
    DATABASE CONFIGURATION
  */

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (
    !supabaseUrl ||
    !serviceRoleKey
  ) {
    return json(
      {
        ok: false,
        error:
          "Database environment variables are missing."
      },
      500
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


  try {

    /*
      GET CURRENT BOOKING

      We retrieve everything needed BEFORE
      cancellation so we can:

      - verify status
      - verify it has not been charged
      - preserve payment information
      - send customer notification
      - send owner notification
      - include original schedule
    */

    const getEndpoint =
      `${supabaseUrl.replace(/\/$/, "")}` +
      `/rest/v1/quotes` +
      `?id=eq.${encodeURIComponent(quoteId)}` +
      `&select=` +
      [
        "id",
        "quote_number",
        "status",
        "customer_name",
        "customer_email",
        "customer_phone",
        "service_type",
        "property_type",
        "frequency",
        "zip_code",
        "quoted_price",
        "scheduled_for",
        "stripe_customer_id",
        "stripe_payment_method_id",
        "stripe_payment_intent_id"
      ].join(",");

    let getResponse;

    try {
      getResponse =
        await fetch(
          getEndpoint,
          {
            method: "GET",

            headers: {
              apikey:
                serviceRoleKey,

              Authorization:
                `Bearer ${serviceRoleKey}`,

              "content-type":
                "application/json"
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

    const getData =
      await getResponse
        .json()
        .catch(() => null);

    if (!getResponse.ok) {
      return json(
        {
          ok: false,

          error:
            getData?.message ||
            getData?.error ||
            "Could not load booking."
        },
        500
      );
    }

    const quote =
      Array.isArray(getData)
        ? getData[0]
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
      NEVER CANCEL A CHARGED BOOKING.

      We check BOTH status and payment
      intent ID as an extra safety layer.
    */

    if (
      quote.status === "charged" ||
      quote.stripe_payment_intent_id
    ) {
      return json(
        {
          ok: false,

          error:
            "This booking has already been charged and cannot be cancelled from the dashboard."
        },
        409
      );
    }


    /*
      ALREADY CANCELLED

      Do not send duplicate emails.
      Do not update anything again.
    */

    if (
      quote.status === "cancelled"
    ) {
      return json({
        ok: true,

        already_cancelled:
          true,

        quote_id:
          quote.id,

        quote_number:
          quote.quote_number ||
          null,

        status:
          "cancelled",

        charged:
          false,

        customer_email_sent:
          false,

        owner_email_sent:
          false
      });
    }


    /*
      COMPLETED SERVICES CANNOT
      BE CANCELLED HERE.

      Only active secured bookings
      may be cancelled.
    */

    const cancellableStatuses = [
      "accepted",
      "card_saved",
      "booked"
    ];

    if (
      !cancellableStatuses.includes(
        quote.status
      )
    ) {
      return json(
        {
          ok: false,

          error:
            `This booking cannot be cancelled while its status is "${quote.status}".`
        },
        409
      );
    }


    /*
      CANCEL BOOKING

      IMPORTANT:

      - NO Stripe charge
      - NO payment-method deletion
      - NO Stripe customer deletion
      - NO quote deletion
      - NO price modification
      - NO schedule deletion

      We preserve the booking record
      and simply mark it cancelled.
    */

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
                  "cancelled"
              })
          }
        );
    } catch (error) {
      return json(
        {
          ok: false,

          error:
            "Could not cancel booking.",

          detail:
            error?.message || null
        },
        500
      );
    }

    const updateData =
      await updateResponse
        .json()
        .catch(() => null);

    if (!updateResponse.ok) {
      return json(
        {
          ok: false,

          error:
            updateData?.message ||
            updateData?.error ||
            "Could not cancel booking."
        },
        500
      );
    }

    const updated =
      Array.isArray(updateData)
        ? updateData[0]
        : updateData;

    if (!updated) {
      return json(
        {
          ok: false,

          error:
            "Booking cancellation could not be confirmed."
        },
        500
      );
    }


    /*
      EMAIL DATA
    */

    const amount =
      formatMoney(
        quote.quoted_price
      );

    const scheduledDate =
      formatCleaningDate(
        quote.scheduled_for
      );

    const resendApiKey =
      process.env.RESEND_API_KEY;

    const fromEmail =
      process.env.FROM_EMAIL;

    let customerEmailSent =
      false;

    let ownerEmailSent =
      false;


    /*
      CUSTOMER CANCELLATION EMAIL

      Cancellation remains successful
      even if this email fails.
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

      const safeDate =
        escapeHtml(
          scheduledDate
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

      const customerText = [
        `Hi ${customerName},`,
        "",
        "Your cleaning appointment with The Fresh Standard Co. has been cancelled.",
        "",
        `Booking reference: ${quote.quote_number || quote.id}`,
        `Cleaning date: ${scheduledDate}`,
        `Service: ${quote.service_type || "Cleaning Service"}`,
        `Quoted amount: ${amount}`,
        "",
        "Your card was not charged for this cancellation.",
        "",
        "If you believe this cancellation was made in error or you would like to arrange another cleaning, please contact us.",
        "",
        "Phone: 954-379-6765",
        "Email: thefreshstandardco@outlook.com",
        "",
        "The Fresh Standard Co."
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

<body style="
  margin:0;
  padding:0;
  background:#f4f1e9;
  font-family:Arial,sans-serif;
  color:#1c2823;
">

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
    color:#8f3d3d;
    font-size:11px;
    font-weight:700;
    letter-spacing:2px;
    text-transform:uppercase;
    margin-bottom:10px;
  "
>
  Booking Cancelled
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
  Your cleaning has been cancelled.
</h1>

<p
  style="
    margin:18px 0 0;
    color:#69756f;
    font-size:16px;
    line-height:1.7;
  "
>
  Hi ${safeName}, this email confirms
  that your cleaning appointment with
  The Fresh Standard Co. has been cancelled.
</p>

<div
  style="
    margin-top:28px;
    padding:24px;
    background:#f4eaea;
    border-radius:18px;
  "
>

<div
  style="
    color:#8f3d3d;
    font-size:10px;
    font-weight:700;
    letter-spacing:1.5px;
    text-transform:uppercase;
  "
>
  Cancelled Appointment
</div>

<div
  style="
    margin-top:7px;
    color:#17352b;
    font-family:Georgia,serif;
    font-size:23px;
    line-height:1.35;
  "
>
  ${safeDate}
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
  Quoted Amount
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
    background:#eef2ed;
    border-radius:15px;
    color:#17352b;
    font-size:14px;
    line-height:1.6;
  "
>
  <strong>No payment was processed.</strong><br>
  Your card was not charged for this cancellation.
</div>

<p
  style="
    margin:24px 0 0;
    color:#69756f;
    font-size:14px;
    line-height:1.7;
  "
>
  If you believe this cancellation was made
  in error or you would like to arrange
  another cleaning, please contact us.
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
              `Your cleaning has been cancelled — ${quote.quote_number || "The Fresh Standard Co."}`,

            text:
              customerText,

            html:
              customerHtml
          });

        customerEmailSent =
          result.ok;

        if (!result.ok) {
          console.error(
            "Customer cancellation email failed:",
            result.status,
            result.data
          );
        }

      } catch (error) {

        console.error(
          "Customer cancellation email error:",
          error
        );
      }
    }


    /*
      OWNER CANCELLATION EMAIL
    */

    if (
      resendApiKey &&
      fromEmail
    ) {

      const ownerText = [
        "A cleaning booking has been cancelled.",
        "",
        `Quote: ${quote.quote_number || quoteId}`,
        `Customer: ${quote.customer_name || ""}`,
        `Email: ${quote.customer_email || ""}`,
        `Phone: ${quote.customer_phone || ""}`,
        "",
        `Service: ${quote.service_type || ""}`,
        `Scheduled Date: ${scheduledDate}`,
        `Quoted Amount: ${amount}`,
        "",
        "Status: CANCELLED",
        "Customer charged: NO",
        "",
        customerEmailSent
          ? "Customer cancellation email: Sent successfully."
          : "Customer cancellation email: Not sent or failed.",
        "",
        "The quote, Stripe customer and saved payment information were preserved for business records."
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
    Booking Cancelled
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
    <strong>Cancelled cleaning date:</strong><br>
    ${escapeHtml(
      scheduledDate
    )}
  </p>

  <p>
    <strong>Quoted amount:</strong><br>
    ${escapeHtml(
      amount
    )}
  </p>

  <p>
    <strong>Customer charged:</strong><br>
    NO
  </p>

  <p>
    <strong>Customer cancellation email:</strong><br>
    ${
      customerEmailSent
        ? "Sent successfully"
        : "Not sent or failed"
    }
  </p>

  <p
    style="
      color:#69756f;
      line-height:1.6;
    "
  >
    The booking record, quote information,
    Stripe customer and saved payment information
    were preserved.
  </p>

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
              `Booking Cancelled — ${quote.quote_number || quoteId}`,

            text:
              ownerText,

            html:
              ownerHtml
          });

        ownerEmailSent =
          result.ok;

        if (!result.ok) {
          console.error(
            "Owner cancellation email failed:",
            result.status,
            result.data
          );
        }

      } catch (error) {

        console.error(
          "Owner cancellation email error:",
          error
        );
      }
    }


    /*
      FINAL RESPONSE

      Email failures DO NOT change
      the successful cancellation.
    */

    return json({
      ok: true,

      quote_id:
        updated?.id ||
        quote.id,

      quote_number:
        updated?.quote_number ||
        quote.quote_number ||
        null,

      status:
        "cancelled",

      charged:
        false,

      customer_email_sent:
        customerEmailSent,

      owner_email_sent:
        ownerEmailSent,

      message:
        "Booking cancelled successfully."
    });

  } catch (error) {

    console.error(
      "Cancel booking error:",
      error
    );

    return json(
      {
        ok: false,

        error:
          error?.message ||
          "Could not cancel booking."
      },
      500
    );
  }
};
