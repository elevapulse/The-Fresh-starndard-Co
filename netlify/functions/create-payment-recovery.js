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


async function getQuoteByToken(
  token,
  supabaseUrl,
  serviceRoleKey
) {
  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?quote_token=eq.${encodeURIComponent(token)}` +
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
    CUSTOMER PAYMENT RECOVERY ENDPOINT.

    The customer supplies ONLY the secure
    quote token.

    The amount, customer, quote ID and status
    are all retrieved directly from Supabase.
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


  const supabaseUrl =
    process.env.SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  const stripeSecretKey =
    process.env.STRIPE_SECRET_KEY;


  if (
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


  const token =
    String(
      body.token || ""
    ).trim();


  if (!token) {
    return json(
      {
        ok: false,
        error:
          "Secure payment token is required."
      },
      400
    );
  }


  /*
    Retrieve booking using the secure
    customer token.
  */

  let quote;

  try {

    quote =
      await getQuoteByToken(
        token,
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
        error:
          "This payment link is invalid."
      },
      404
    );
  }


  /*
    Never create another payment for an
    already-charged booking.
  */

  if (quote.status === "charged") {
    return json(
      {
        ok: false,
        already_paid: true,
        error:
          "This booking has already been paid."
      },
      409
    );
  }


  /*
    Recovery payment is available ONLY after
    the cleaning has actually been completed.
  */

  if (quote.status !== "completed") {
    return json(
      {
        ok: false,
        error:
          "This booking is not currently available for payment."
      },
      400
    );
  }


  /*
    Validate locked SERVER-SIDE amount.
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
    Customer must already exist in Stripe
    from the original card-saving flow.
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
          "Payment information is unavailable for this booking."
      },
      400
    );
  }


  /*
    Create Stripe Checkout in PAYMENT mode.

    This Checkout can handle:
    - customer authentication
    - 3D Secure
    - entering another card

    Stripe handles the sensitive card UI.
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
    Save the successfully used payment
    method to the Stripe customer.
  */

  params.set(
    "payment_intent_data[setup_future_usage]",
    "off_session"
  );


  params.set(
    "success_url",
    "https://thefreshstandardco.com/payment/success/" +
    "?session_id={CHECKOUT_SESSION_ID}"
  );


  params.set(
    "cancel_url",
    "https://thefreshstandardco.com/payment/" +
    "?token=" +
    encodeURIComponent(token)
  );


  /*
    Metadata used by our verified Stripe
    webhook after successful payment.
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
    token
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
    DUPLICATE PAYMENT PROTECTION.

    Every recovery Checkout creation for this
    quote uses the same Stripe idempotency key.

    If the customer:
    - double-clicks
    - opens multiple tabs
    - uses multiple devices
    - sends simultaneous requests

    Stripe will return the same Checkout
    Session instead of creating separate
    payment sessions for the same booking.

    The quote price is already locked before
    this recovery flow can be reached.
  */

  const recoveryIdempotencyKey =
    `fresh-standard-recovery-${quote.id}`;


  let session;

  try {

    session =
      await stripePost(
        "checkout/sessions",
        stripeSecretKey,
        params,
        recoveryIdempotencyKey
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
          "Secure payment could not be opened.",
        detail:
          error.message
      },
      500
    );
  }


  /*
    Return ONLY the server-created Checkout
    URL and server-controlled amount.

    The browser never controls the price.
  */

  return json({
    ok: true,

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

    checkout_url:
      session.url
  });
};
