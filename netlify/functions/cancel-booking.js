function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
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

  const adminPassword =
    request.headers.get("x-admin-password");

  const expectedPassword =
    process.env.ADMIN_PASSWORD;

  if (
    !expectedPassword ||
    adminPassword !== expectedPassword
  ) {
    return json(
      {
        ok: false,
        error: "Unauthorized"
      },
      401
    );
  }

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

  if (!quoteId) {
    return json(
      {
        ok: false,
        error: "Quote ID is required."
      },
      400
    );
  }

  try {
    /*
      FIRST:
      Get the current booking so we can make sure
      it has not already been charged.
    */

    const getResponse =
      await fetch(
        `${supabaseUrl.replace(/\/$/, "")}` +
        `/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}` +
        `&select=id,quote_number,status,customer_name,customer_email,customer_phone,quoted_price,stripe_payment_intent_id`,
        {
          method: "GET",

          headers: {
            apikey: serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`,

            "content-type":
              "application/json"
          }
        }
      );

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
          error: "Booking not found."
        },
        404
      );
    }

    /*
      NEVER allow cancellation after a successful
      customer charge.
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

    if (quote.status === "cancelled") {
      return json({
        ok: true,
        already_cancelled: true,
        quote_number:
          quote.quote_number || null,
        status: "cancelled"
      });
    }

    /*
      Only bookings that have reached the secured
      booking stage can be cancelled here.

      We also allow "accepted" because older records
      may still use that status.
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
      IMPORTANT:

      We are NOT charging anything here.

      We are NOT deleting the customer.

      We are NOT deleting the quote.

      We simply change the booking status
      to "cancelled".
    */

    const updateResponse =
      await fetch(
        `${supabaseUrl.replace(/\/$/, "")}` +
        `/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}`,
        {
          method: "PATCH",

          headers: {
            apikey: serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`,

            "content-type":
              "application/json",

            Prefer:
              "return=representation"
          },

          body: JSON.stringify({
            status: "cancelled"
          })
        }
      );

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

    /*
      Send owner notification email.

      Cancellation itself should still succeed
      even if the email fails.
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
        const amount =
          quote.quoted_price
            ? (
                Number(
                  quote.quoted_price
                ) / 100
              ).toLocaleString(
                "en-US",
                {
                  style: "currency",
                  currency: "USD"
                }
              )
            : "—";

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

              body: JSON.stringify({
                from: fromEmail,

                to: [
                  "thefreshstandardco@outlook.com"
                ],

                subject:
                  `Booking Cancelled — ${quote.quote_number || quoteId}`,

                text: [
                  "A cleaning booking has been cancelled.",
                  "",
                  `Quote: ${quote.quote_number || quoteId}`,
                  `Customer: ${quote.customer_name || ""}`,
                  `Email: ${quote.customer_email || ""}`,
                  `Phone: ${quote.customer_phone || ""}`,
                  `Amount: ${amount}`,
                  "",
                  "Status: CANCELLED",
                  "",
                  "The customer's card was NOT charged."
                ].join("\\n")
              })
            }
          );

        emailSent =
          emailResponse.ok;

      } catch (error) {
        console.error(
          "Cancellation email error:",
          error
        );
      }
    }

    return json({
      ok: true,

      quote_id:
        updated?.id ||
        quote.id,

      quote_number:
        updated?.quote_number ||
        quote.quote_number ||
        null,

      status: "cancelled",

      charged: false,

      email_sent:
        emailSent
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
