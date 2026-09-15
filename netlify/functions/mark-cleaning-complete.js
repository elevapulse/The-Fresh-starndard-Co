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
  /*
    Only allow POST requests.
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
    Load private server environment variables.
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
        error: "Server configuration is incomplete."
      },
      500
    );
  }

  /*
    Protect this function with the same
    owner password used by the admin dashboard.
  */
  const suppliedPassword =
    request.headers.get(
      "x-admin-password"
    );

  if (
    !suppliedPassword ||
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
    Read request body.
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

  if (!quoteId) {
    return json(
      {
        ok: false,
        error: "Quote ID is required."
      },
      400
    );
  }

  /*
    Retrieve the quote directly from Supabase.

    We do NOT trust the browser to tell us
    the current status, price, customer ID,
    payment method, etc.
  */
  const quoteEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}` +
    `&select=*`;

  let quoteResponse;

  try {
    quoteResponse = await fetch(
      quoteEndpoint,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization:
            `Bearer ${serviceRoleKey}`
        }
      }
    );
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Could not connect to database.",
        detail: error?.message || null
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
        error: "Booking not found."
      },
      404
    );
  }

  /*
    A cleaning can only be marked complete
    after the customer has successfully
    saved a payment method.

    We also allow "booked" here for the
    future scheduling stage.
  */
  const allowedStatuses = [
    "card_saved",
    "booked"
  ];

  if (!allowedStatuses.includes(quote.status)) {
    return json(
      {
        ok: false,
        error:
          `This booking cannot be completed while its status is "${quote.status}".`
      },
      400
    );
  }

  /*
    Safety check:

    Do not allow completion if we do not
    actually have a saved Stripe payment
    method associated with the booking.
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
    Record completion in Supabase.
  */
  const completedAt =
    new Date().toISOString();

  const updateEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}`;

  let updateResponse;

  try {
    updateResponse = await fetch(
      updateEndpoint,
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
          status: "completed",
          completed_at: completedAt
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

  return json({
    ok: true,

    message:
      "Cleaning marked complete. Customer has not been charged.",

    quote_id:
      quoteId,

    status:
      updatedQuote?.status ||
      "completed",

    completed_at:
      updatedQuote?.completed_at ||
      completedAt,

    quoted_price:
      quote.quoted_price
  });
};
