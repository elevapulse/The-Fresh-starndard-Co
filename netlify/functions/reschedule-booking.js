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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatCleaningDate(date) {
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

        body:
          JSON.stringify({
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

  const adminPassword =
    process.env.ADMIN_PASSWORD;

  const suppliedPassword =
    getAdminPassword(request);

  if (
    !adminPassword ||
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
          "Database configuration is missing."
      },
      500
    );
  }


  /*
    READ REQUEST
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

  const scheduledFor =
    String(
      body.scheduled_for || ""
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

  if (!scheduledFor) {
    return json(
      {
        ok: false,
        error:
          "New cleaning date and time are required."
      },
      400
    );
  }


  /*
    VALIDATE DATE
  */

  const parsedDate =
    new Date(scheduledFor);

  if (
    Number.isNaN(
      parsedDate.getTime()
    )
  ) {
    return json(
      {
        ok: false,
        error:
          "The cleaning date and time are invalid."
      },
      400
    );
  }

  if (
    parsedDate.getTime() <=
    Date.now()
  ) {
    return json(
      {
        ok: false,
        error:
          "The cleaning date must be in the future."
      },
      400
    );
  }


  /*
    GET CURRENT BOOKING
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
      "scheduled_for"
    ].join(",");

  let getResponse;

  try {

    getResponse =
      await fetch(
        getEndpoint,
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
          "Could not retrieve booking."
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
    ONLY ACTIVE SECURED BOOKINGS
    MAY BE RESCHEDULED.
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
          `This booking cannot be rescheduled while its status is "${quote.status}".`
      },
      409
    );
  }


  /*
    STORE OLD SCHEDULE FOR
    OWNER NOTIFICATION.
  */

  let oldFormattedDate =
    "Not previously scheduled";

  if (quote.scheduled_for) {

    const oldDate =
      new Date(
        quote.scheduled_for
      );

    if (
      !Number.isNaN(
        oldDate.getTime()
      )
    ) {
      oldFormattedDate =
        formatCleaningDate(
          oldDate
        );
    }
  }


  /*
    UPDATE SCHEDULE ONLY.

    DO NOT CHANGE:
    - PRICE
    - STRIPE CUSTOMER
    - PAYMENT METHOD
    - PAYMENT STATUS
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
              scheduled_for:
                parsedDate.toISOString()
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
          "Could not reschedule booking."
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
          "Booking update could not be confirmed."
      },
      500
    );
  }


  /*
    EMAIL CONFIGURATION

    EMAIL FAILURE MUST NEVER
    ROLL BACK A SUCCESSFUL
    RESCHEDULE.
  */

  const resendApiKey =
    process.env.RESEND_API_KEY;

  const fromEmail =
    process.env.FROM_EMAIL;

  const newFormattedDate =
    formatCleaningDate(
      parsedDate
    );

  let customerEmailSent =
    false;

  let ownerEmailSent =
    false;


  /*
    CUSTOMER RESCHEDULE EMAIL
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

    const safeQuoteNumber =
      escapeHtml(
        quote.quote_number ||
        quote.id
      );

    const safeDate =
      escapeHtml(
        newFormattedDate
      );

    const safeService =
      escapeHtml(
        quote.service_type ||
        "Cleaning Service"
      );

    const safeProperty =
      escapeHtml(
        quote.property_type ||
        ""
      );

    const safeZip =
      escapeHtml(
        quote.zip_code ||
        ""
      );

    const customerText = [
      `Hi ${customerName},`,
      "",
      "Your cleaning appointment with The Fresh Standard Co. has been rescheduled.",
      "",
      `New cleaning date: ${newFormattedDate}`,
      "",
      quote.service_type
        ? `Service: ${quote.service_type}`
        : "",
      quote.quote_number
        ? `Booking reference: ${quote.quote_number}`
        : "",
      "",
      "Your quoted price and saved payment method have not changed.",
      "",
      "If you have any questions or need to make another change, please contact us:",
      "Phone: 954-379-6765",
      "Email: thefreshstandardco@outlook.com",
      "",
      "Thank you for choosing The Fresh Standard Co."
    ]
    .filter(
      line => line !== ""
    )
    .join("\n");

    const customerHtml = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
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
                  color:#718679;
                  font-size:11px;
                  font-weight:700;
                  letter-spacing:2px;
                  text-transform:uppercase;
                  margin-bottom:10px;
                "
              >
                Booking Updated
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
                Your cleaning has been rescheduled.
              </h1>

              <p
                style="
                  margin:18px 0 0;
                  color:#69756f;
                  font-size:16px;
                  line-height:1.7;
                "
              >
                Hi ${safeName}, your cleaning appointment with
                The Fresh Standard Co. has been updated.
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
                  New Cleaning Date
                </div>

                <div
                  style="
                    margin-top:7px;
                    color:#17352b;
                    font-family:Georgia,serif;
                    font-size:24px;
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

                ${
                  safeProperty
                    ? `
                      <tr>
                        <td
                          style="
                            padding:12px 0;
                            border-bottom:1px solid #e5e8e3;
                            color:#69756f;
                            font-size:13px;
                          "
                        >
                          Property
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
                          ${safeProperty}
                        </td>
                      </tr>
                    `
                    : ""
                }

                ${
                  safeZip
                    ? `
                      <tr>
                        <td
                          style="
                            padding:12px 0;
                            border-bottom:1px solid #e5e8e3;
                            color:#69756f;
                            font-size:13px;
                          "
                        >
                          ZIP Code
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
                          ${safeZip}
                        </td>
                      </tr>
                    `
                    : ""
                }

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
                    ${safeQuoteNumber}
                  </td>
                </tr>

              </table>

              <p
                style="
                  margin:26px 0 0;
                  color:#69756f;
                  font-size:14px;
                  line-height:1.7;
                "
              >
                Your quoted price and saved payment method have
                not changed.
              </p>

              <p
                style="
                  margin:20px 0 0;
                  color:#69756f;
                  font-size:14px;
                  line-height:1.7;
                "
              >
                Need to make another change?<br>
                Call us at
                <strong style="color:#17352b;">
                  954-379-6765
                </strong>
                or email
                <strong style="color:#17352b;">
                  thefreshstandardco@outlook.com
                </strong>.
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
            `Your cleaning has been rescheduled — ${quote.quote_number || "The Fresh Standard Co."}`,

          text:
            customerText,

          html:
            customerHtml
        });

      customerEmailSent =
        result.ok;

      if (!result.ok) {
        console.error(
          "Customer reschedule email failed:",
          result.status,
          result.data
        );
      }

    } catch (error) {

      console.error(
        "Customer reschedule email error:",
        error
      );
    }
  }


  /*
    OWNER RESCHEDULE EMAIL
  */

  if (
    resendApiKey &&
    fromEmail
  ) {

    const ownerText = [
      "A cleaning booking has been rescheduled.",
      "",
      `Quote: ${quote.quote_number || quoteId}`,
      `Customer: ${quote.customer_name || ""}`,
      `Email: ${quote.customer_email || ""}`,
      `Phone: ${quote.customer_phone || ""}`,
      "",
      `Previous Cleaning Date: ${oldFormattedDate}`,
      `New Cleaning Date: ${newFormattedDate}`,
      "",
      quote.service_type
        ? `Service: ${quote.service_type}`
        : "",
      quote.quoted_price
        ? `Quoted Price: $${(
            Number(quote.quoted_price) / 100
          ).toFixed(2)}`
        : "",
      "",
      "The quote price and saved payment method were not changed.",
      "",
      customerEmailSent
        ? "Customer reschedule email: Sent successfully."
        : "Customer reschedule email: Not sent or failed."
    ]
    .filter(
      line => line !== ""
    )
    .join("\n");

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
            `Booking Rescheduled — ${quote.quote_number || quoteId}`,

          text:
            ownerText,

          html: `
            <div style="
              font-family:Arial,sans-serif;
              max-width:620px;
              margin:auto;
              color:#1c2823;
            ">

              <h2 style="color:#17352b;">
                Booking Rescheduled
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
                <strong>
                  Previous cleaning date:
                </strong><br>
                ${escapeHtml(
                  oldFormattedDate
                )}
              </p>

              <p>
                <strong>
                  New cleaning date:
                </strong><br>
                ${escapeHtml(
                  newFormattedDate
                )}
              </p>

              <p>
                <strong>
                  Customer notification:
                </strong>
                ${
                  customerEmailSent
                    ? "Sent successfully"
                    : "Not sent or failed"
                }
              </p>

              <p style="color:#69756f;">
                The quote price and saved payment method
                were not changed.
              </p>

            </div>
          `
        });

      ownerEmailSent =
        result.ok;

      if (!result.ok) {
        console.error(
          "Owner reschedule email failed:",
          result.status,
          result.data
        );
      }

    } catch (error) {

      console.error(
        "Owner reschedule email error:",
        error
      );
    }
  }


  /*
    SUCCESS

    IMPORTANT:
    A FAILED EMAIL DOES NOT TURN
    A SUCCESSFUL DATABASE UPDATE
    INTO A FAILED RESCHEDULE.
  */

  return json({
    ok: true,

    quote_id:
      updated.id ||
      quote.id,

    quote_number:
      updated.quote_number ||
      quote.quote_number,

    status:
      updated.status ||
      quote.status,

    scheduled_for:
      updated.scheduled_for ||
      parsedDate.toISOString(),

    customer_email_sent:
      customerEmailSent,

    owner_email_sent:
      ownerEmailSent,

    message:
      "Booking rescheduled successfully."
  });
};
