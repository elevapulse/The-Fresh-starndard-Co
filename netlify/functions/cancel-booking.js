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

  if (!adminPassword) {
    return json(
      {
        ok: false,
        error:
          "Admin authentication is not configured."
      },
      500
    );
  }

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
    ENVIRONMENT VARIABLES
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
    GET CURRENT BOOKING

    We check the current status before
    allowing cancellation.
  */

  const quoteEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}` +
    `&select=id,quote_number,status,quoted_price`;

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
        error: "Booking not found."
      },
      404
    );
  }

  /*
    NEVER CANCEL A BOOKING THAT HAS
    ALREADY BEEN CHARGED.

    This protects us from changing the
    database status while a completed
    Stripe payment already exists.
  */

  if (quote.status === "charged") {
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
    DON'T CANCEL THE SAME BOOKING TWICE.
  */

  if (quote.status === "cancelled") {
    return json({
      ok: true,
      already_cancelled: true,
      quote_id: quote.id,
      quote_number: quote.quote_number,
      status: "cancelled"
    });
  }

  /*
    COMPLETED SERVICES SHOULD NOT BE
    CANCELLED THROUGH THIS ACTION.

    Once a cleaning is marked completed,
    it belongs in the payment workflow.
  */

  if (quote.status === "completed") {
    return json(
      {
        ok: false,
        error:
          "This cleaning has already been marked complete and cannot be cancelled."
      },
      409
    );
  }

  /*
    ONLY ACTIVE PRE-SERVICE BOOKINGS
    CAN BE CANCELLED.
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
          "This booking is not currently eligible for cancellation."
      },
      409
    );
  }

  /*
    UPDATE BOOKING STATUS.

    IMPORTANT:
    This does NOT call Stripe and does
    NOT charge the customer's card.
  */

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
          status: "cancelled"
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
          "Could not cancel booking."
      },
      500
    );
  }

  const updated =
    Array.isArray(updatedData)
      ? updatedData[0]
      : updatedData;

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

  return json({
    ok: true,
    quote_id: updated.id,
    quote_number:
      updated.quote_number ||
      quote.quote_number,
    status: updated.status,
    message:
      "Booking cancelled successfully. No payment was processed."
  });
};
