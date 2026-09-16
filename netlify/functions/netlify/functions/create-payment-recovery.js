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
  idempotencyKey
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
    throw new Error(
      data?.error?.message ||
      `Stripe request failed with status ${response.status}`
    );
  }

  return data;
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

  const response =
    await fetch(
      endpoint,
      {
        headers: {
          apikey: serviceRoleKey,

          Authorization:
            `Bearer ${serviceRoleKey}`
        }
      }
    );

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      "Could not retrieve booking."
    );
  }

  return Array.isArray(data)
    ? data[0]
    : null;
}


export default async (request) => {

  /*
    OWNER-ONLY ENDPOINT.

    This creates a secure Stripe Checkout
    payment link after the normal saved-card
    charge could not be completed.

    The browser NEVER supplies the amount.
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
    Require owner authentication.
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
    Read ONLY the quote ID from the dashboard.
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
    Retrieve the authoritative quote
    directly from Supabase.
  */

  let quote;

  try {
    quote =
      await getQuote(
        quoteId,
        supabaseUrl,
        serviceRoleKey
      );

  } catch (error) {
    return json(
      {
        ok: false,

        error:
          error.message ||
          "Could not retrieve booking."
      },
      500
    );
  }


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
    Recovery payment is ONLY allowed after
    the cleaning has been marked completed.

    If it is already charged, absolutely
    no new Checkout Session is created.
  */

  if (quote.status === "charged") {
    return json(
      {
        ok: false,

        error:
          "This customer has already been charged."
      },
      409
    );
  }


  if (quote.status !== "completed") {
    return json(
      {
        ok: false,

        error:
          `A recovery payment cannot be created while this booking is "${quote.status}".`
      },
      400
    );
  }


  /*
    Validate the SERVER-SIDE locked price.

    quoted_price is stored in cents.
  */

  const amount =
    Number(
      quote.quoted_price
    );


  if (
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return json(
      {
        ok: false,

        error:
          "This booking does not have a valid payment amount."
      },
      400
    );
  }


  /*
    This quote should already have a Stripe
    customer because the customer previously
    saved a card during booking.
  */

  const stripeCustomerId =
    String(
      quote.stripe_customer_id || ""
    ).trim();


  if (!stripeCustomerId) {
    return json(
      {
        ok: false,

        error:
          "This booking does not have a Stripe customer."
      },
      400
    );
  }


  /*
    The existing quote token becomes the
    customer-facing recovery authorization.

    We do NOT expose the quote ID alone in
    the recovery URL.
  */

  const quoteToken =
    String(
      quote.quote_token || ""
    ).trim();


  if (!quoteToken) {
    return json(
      {
        ok: false,

        error:
          "This booking does not have a secure customer token."
      },
      400
    );
  }


  /*
    Create Stripe Checkout in PAYMENT mode.

    Unlike the original booking Checkout,
    this actually charges the customer.

    Stripe hosts the card/authentication UI,
    so 3DS and replacement-card entry happen
    securely on Stripe's side.
  */

  const params =
    new URLSearchParams();


  params.set(
    "mode",
    "payment"
  );


  params.set(
    "customer",
    stripeCustomerId
  );


  params.set(
    "payment_method_types[0]",
    "card"
  );


  /*
    Charge the exact server-side amount.
  */

  params.set(
    "line_items[0][price_data][currency]",
    "usd"
  );


  params.set(
    "line_items[0][price_data][product_data][name]",
    "Cleaning Service"
  );


  params.set(
    "line_items[0][price_data][product_data][description]",
    `The Fresh Standard Co. — ${quote.quote_number || "Cleaning"}`
  );


  params.set(
    "line_items[0][price_data][unit_amount]",
    String(amount)
  );


  params.set(
    "line_items[0][quantity]",
    "1"
  );


  /*
    Save the newly used payment method to
    the existing Stripe customer for future
    permitted payments.
  */

  params.set(
    "payment_intent_data[setup_future_usage]",
    "off_session"
  );


  /*
    Customer returns to our branded page
    after successful payment.
  */

  params.set(
    "success_url",
    "https://thefreshstandardco.com/payment/success/" +
    "?session_id={CHECKOUT_SESSION_ID}"
  );


  /*
    If the customer cancels Stripe Checkout,
    return them to our recovery page.
  */

  params.set(
    "cancel_url",
    "https://thefreshstandardco.com/payment/" +
    "?token=" +
    encodeURIComponent(quoteToken)
  );


  /*
    Metadata allows the Stripe webhook to
    connect this payment back to the quote.
  */

  params.set(
    "metadata[quote_id]",
    quote.id
  );


  params.set(
    "metadata[quote_number]",
    quote.quote_number || ""
  );


  params.set(
    "metadata[quote_token]",
    quoteToken
  );


  params.set(
    "metadata[payment_type]",
    "recovery"
  );


  params.set(
    "payment_intent_data[metadata][quote_id]",
    quote.id
  );


  params.set(
    "payment_intent_data[metadata][quote_number]",
    quote.quote_number || ""
  );


  params.set(
    "payment_intent_data[metadata][payment_type]",
    "recovery"
  );


  /*
    Create the Stripe Checkout Session.

    The idempotency key prevents accidental
    duplicate session creation from rapid
    repeated dashboard clicks.
  */

  let session;

  try {

    session =
      await stripePost(
        "checkout/sessions",
        stripeSecretKey,
        params,
        `fresh-standard-recovery-${quote.id}-${amount}`
      );

  } catch (error) {

    console.error(
      "Recovery Checkout creation failed:",
      error.message
    );


    return json(
      {
        ok: false,

        error:
          "Could not create the secure payment link.",

        detail:
          error.message
      },
      500
    );
  }


  /*
    Return the Stripe-hosted URL to the
    OWNER dashboard.

    The dashboard can then copy/send it
    to the customer.
  */

  return json({
    ok: true,

    quote_id:
      quote.id,

    quote_number:
      quote.quote_number || null,

    amount:
      amount,

    amount_formatted:
      (amount / 100)
        .toLocaleString(
          "en-US",
          {
            style: "currency",
            currency: "USD"
          }
        ),

    checkout_session_id:
      session.id,

    checkout_url:
      session.url
  });
};
