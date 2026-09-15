function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}


function stripeHeaders(secretKey) {
  return {
    Authorization: `Bearer ${secretKey}`,
    "content-type": "application/x-www-form-urlencoded"
  };
}


async function stripePost(
  path,
  secretKey,
  params,
  idempotencyKey = null
) {
  const headers =
    stripeHeaders(secretKey);

  if (idempotencyKey) {
    headers["Idempotency-Key"] =
      idempotencyKey;
  }

  const response =
    await fetch(
      `https://api.stripe.com/v1/${path}`,
      {
        method: "POST",
        headers,
        body: params.toString()
      }
    );

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    const error =
      new Error(
        data?.error?.message ||
        `Stripe request failed with status ${response.status}`
      );

    error.stripeCode =
      data?.error?.code || null;

    error.declineCode =
      data?.error?.decline_code || null;

    error.paymentIntent =
      data?.error?.payment_intent || null;

    throw error;
  }

  return data;
}


export default async (request) => {

  /*
    Only POST is allowed.
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
    Private server configuration.
  */

  const adminPassword =
    process.env.ADMIN_PASSWORD;

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  const stripeSecretKey =
    process.env.STRIPE_SECRET_KEY;


  if (
    !adminPassword ||
    !supabaseUrl ||
    !serviceRoleKey ||
    !stripeSecretKey
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
    Protect this endpoint with the same
    owner password used by the dashboard.
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

    IMPORTANT:
    The browser sends ONLY the quote ID.

    It does NOT tell us how much to charge.
  */

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
    String(
      body.quote_id || ""
    ).trim();


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
    Retrieve the booking from Supabase.

    Price and Stripe information come
    directly from our database.
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
    CRITICAL SAFETY CHECK:

    The cleaning must have been explicitly
    marked completed before charging.
  */

  if (quote.status !== "completed") {
    return json(
      {
        ok: false,
        error:
          `Customer cannot be charged while booking status is "${quote.status}".`
      },
      400
    );
  }


  /*
    Make sure a valid server-side price exists.
  */

  const amount =
    Number(quote.quoted_price);


  if (
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return json(
      {
        ok: false,
        error:
          "This booking does not have a valid charge amount."
      },
      400
    );
  }


  /*
    Verify saved Stripe information exists.
  */

  const stripeCustomerId =
    quote.stripe_customer_id;

  const paymentMethodId =
    quote.stripe_payment_method_id;


  if (
    !stripeCustomerId ||
    !paymentMethodId
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
    Create and immediately confirm an
    off-session PaymentIntent.

    This attempts to charge the saved card.

    Currency is USD.

    off_session=true tells Stripe that
    the customer is not actively entering
    their card at this moment.
  */

  const params =
    new URLSearchParams();


  params.set(
    "amount",
    String(amount)
  );


  params.set(
    "currency",
    "usd"
  );


  params.set(
    "customer",
    stripeCustomerId
  );


  params.set(
    "payment_method",
    paymentMethodId
  );


  params.set(
    "confirm",
    "true"
  );


  params.set(
    "off_session",
    "true"
  );


  params.set(
    "description",
    `The Fresh Standard Co. cleaning ${quote.quote_number || quote.id}`
  );


  params.set(
    "metadata[quote_id]",
    quote.id
  );


  params.set(
    "metadata[quote_number]",
    quote.quote_number || ""
  );


  /*
    Idempotency prevents accidental duplicate
    charges if the request is retried.

    For this booking's completion cycle,
    Stripe will treat retries with this key
    as the same payment request.
  */

  const idempotencyKey =
    `fresh-standard-charge-${quote.id}-${quote.completed_at || "completed"}`;


  let paymentIntent;


  try {

    paymentIntent =
      await stripePost(
        "payment_intents",
        stripeSecretKey,
        params,
        idempotencyKey
      );

  } catch (error) {

    console.error(
      "Stripe charge failed:",
      error.message
    );


    /*
      IMPORTANT:
      We leave the booking as COMPLETED.

      We do NOT mark it charged when
      Stripe declines or requires additional
      customer authentication.
    */

    return json(
      {
        ok: false,

        error:
          error.message ||
          "Customer payment could not be completed.",

        stripe_code:
          error.stripeCode || null,

        decline_code:
          error.declineCode || null,

        requires_customer_action:
          error.stripeCode ===
            "authentication_required"
      },
      402
    );
  }


  /*
    Stripe must explicitly report success.
  */

  if (
    paymentIntent.status !== "succeeded"
  ) {
    return json(
      {
        ok: false,

        error:
          "Stripe did not confirm the payment.",

        payment_status:
          paymentIntent.status,

        payment_intent_id:
          paymentIntent.id
      },
      402
    );
  }


  /*
    Stripe successfully charged the card.

    Now update Supabase.
  */

  const chargedAt =
    new Date().toISOString();


  const updateEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quote.id)}`;


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

          body: JSON.stringify({
            status:
              "charged",

            charged_at:
              chargedAt,

            stripe_payment_intent_id:
              paymentIntent.id
          })
        }
      );

  } catch (error) {

    /*
      IMPORTANT:

      Stripe already succeeded at this point.

      Because we used an idempotency key,
      retrying the same request will NOT
      create a second Stripe charge.
    */

    return json(
      {
        ok: false,

        payment_succeeded:
          true,

        error:
          "Payment succeeded, but the booking could not be updated.",

        payment_intent_id:
          paymentIntent.id,

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

        payment_succeeded:
          true,

        error:
          updatedData?.message ||
          updatedData?.error ||
          "Payment succeeded, but the booking could not be updated.",

        payment_intent_id:
          paymentIntent.id
      },
      500
    );
  }


  const updatedQuote =
    Array.isArray(updatedData)
      ? updatedData[0]
      : updatedData;


  /*
    Everything succeeded.
  */

  return json({
    ok: true,

    message:
      "Customer charged successfully.",

    quote_id:
      quote.id,

    quote_number:
      quote.quote_number,

    amount:
      amount,

    amount_formatted:
      `$${(amount / 100).toFixed(2)}`,

    payment_intent_id:
      paymentIntent.id,

    payment_status:
      paymentIntent.status,

    status:
      updatedQuote?.status ||
      "charged",

    charged_at:
      updatedQuote?.charged_at ||
      chargedAt
  });
};
