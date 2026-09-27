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
    body = await request.json();
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

  const scheduledFor =
    String(body.scheduled_for || "").trim();

  if (!quoteId) {
    return json(
      {
        ok: false,
        error: "Quote ID is required."
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

  /*
    DON'T ALLOW A DATE IN THE PAST
  */

  if (
    parsedDate.getTime() <= Date.now()
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
    `&select=id,quote_number,status,customer_name,customer_email,customer_phone,quoted_price,scheduled_for`;

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
    CAN BE RESCHEDULED.

    Never reschedule completed,
    charged or cancelled services.
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
    UPDATE SCHEDULE ONLY.

    We do NOT change:
    - quote price
    - Stripe customer
    - saved payment method
    - payment status
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
    OWNER EMAIL NOTIFICATION

    Rescheduling still succeeds if
    notification email fails.
  */

  let emailSent = false;

  const resendApiKey =
    process.env.RESEND_API_KEY;

  const fromEmail =
    process.env.FROM_EMAIL;

  if (
    resendApiKey &&
    fromEmail
  ) {
    try {
      const formattedDate =
        parsedDate.toLocaleString(
          "en-US",
          {
            timeZone:
              "America/New_York",

            weekday:
              "long",

            year:
              "numeric",

            month:
              "long",

            day:
              "numeric",

            hour:
              "numeric",

            minute:
              "2-digit",

            timeZoneName:
              "short"
          }
        );

      const emailResponse =
        await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${resendApiKey}`,

              "content-type":
                "application/json"
            },

            body:
              JSON.stringify({
                from:
                  fromEmail,

                to: [
                  "thefreshstandardco@outlook.com"
                ],

                subject:
                  `Booking Rescheduled — ${quote.quote_number || quoteId}`,

                text: [
                  "A cleaning booking has been rescheduled.",
                  "",
                  `Quote: ${quote.quote_number || quoteId}`,
                  `Customer: ${quote.customer_name || ""}`,
                  `Email: ${quote.customer_email || ""}`,
                  `Phone: ${quote.customer_phone || ""}`,
                  "",
                  `New Cleaning Date: ${formattedDate}`,
                  "",
                  "The quote price and saved payment method were not changed."
                ].join("\n")
              })
          }
        );

      emailSent =
        emailResponse.ok;

    } catch (error) {
      console.error(
        "Reschedule notification error:",
        error
      );
    }
  }

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

    email_sent:
      emailSent,

    message:
      "Booking rescheduled successfully."
  });
};
