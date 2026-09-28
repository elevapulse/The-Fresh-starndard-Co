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
  const headers = stripeHeaders(secretKey);

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(
    `https://api.stripe.com/v1/${path}`,
    {
      method: "POST",
      headers,
      body: params.toString()
    }
  );

  const data = await response
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

export default async (request) => {
  /*
    ONLY POST
  */

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Method not allowed"
      },
      405
    );
  }

  /*
    SERVER CONFIGURATION
  */

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

  const token =
    String(body.token || "").trim();

  if (!token) {
    return json(
      {
        ok: false,
        error: "Offer token is required."
      },
      400
    );
  }

  /*
    LOAD QUOTE DIRECTLY FROM DATABASE.

    The browser supplies ONLY the secure token.

    We do not trust the browser for:
    - quote ID
    - price
    - customer
    - status
    - Stripe customer ID
  */

  const quoteEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?quote_token=eq.${encodeURIComponent(token)}` +
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
          "Could not retrieve quote."
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
        error: "Quote not found."
      },
      404
    );
  }

  /*
    VERIFY LOCKED QUOTE PRICE
  */

  const quotedPrice =
    Number(quote.quoted_price);

  if (
    !Number.isInteger(quotedPrice) ||
    quotedPrice <= 0
  ) {
    return json(
      {
        ok: false,
        error:
          "This quote has not been priced."
      },
      400
    );
  }

  /*
    IMPORTANT STATUS PROTECTION

    A new Stripe card setup should ONLY
    be created while the quote is:

    - quoted
    - accepted

    "accepted" is allowed because the customer
    may have started Stripe Checkout previously
    and then cancelled or closed the page before
    actually saving the card.

    Once the webhook successfully saves the card,
    the quote should become card_saved/booked.

    At that point we MUST NOT create another
    card setup from an old offer link.
  */

  const allowedStatuses = [
    "quoted",
    "accepted"
  ];

  if (!allowedStatuses.includes(quote.status)) {
    if (
      quote.status === "card_saved" ||
      quote.status === "booked"
    ) {
      return json(
        {
          ok: false,
          already_confirmed: true,
          error:
            "This booking has already been confirmed and the payment method has already been secured."
        },
        409
      );
    }

    if (
      quote.status === "completed" ||
      quote.status === "charged"
    ) {
      return json(
        {
          ok: false,
          already_confirmed: true,
          error:
            "This booking has already progressed beyond the confirmation stage."
        },
        409
      );
    }

    if (quote.status === "cancelled") {
      return json(
        {
          ok: false,
          error:
            "This booking has been cancelled."
        },
        409
      );
    }

    return json(
      {
        ok: false,
        error:
          "This quote is not available for booking."
      },
      409
    );
  }

  /*
    STRIPE CUSTOMER

    Reuse the existing Stripe customer whenever
    one has already been created.
  */

  let stripeCustomerId =
    String(
      quote.stripe_customer_id || ""
    ).trim();

  if (!stripeCustomerId) {
    let customer;

    try {
      const customerParams =
        new URLSearchParams();

      if (quote.customer_name) {
        customerParams.set(
          "name",
          quote.customer_name
        );
      }

      if (quote.customer_email) {
        customerParams.set(
          "email",
          quote.customer_email
        );
      }

      if (quote.customer_phone) {
        customerParams.set(
          "phone",
          quote.customer_phone
        );
      }

      customerParams.set(
        "metadata[quote_id]",
        quote.id
      );

      customerParams.set(
        "metadata[quote_number]",
        quote.quote_number || ""
      );

      /*
        Prevent duplicate Stripe customers if
        multiple requests arrive at nearly the
        same time for the same quote.
      */

      const customerIdempotencyKey =
        `fresh-standard-customer-${quote.id}`;

      customer =
        await stripePost(
          "customers",
          stripeSecretKey,
          customerParams,
          customerIdempotencyKey
        );

      stripeCustomerId =
        customer.id;

    } catch (error) {
      return json(
        {
          ok: false,
          error:
            "Could not create Stripe customer.",
          detail:
            error?.message || null
        },
        500
      );
    }

    /*
      SAVE STRIPE CUSTOMER TO DATABASE
    */

    const saveCustomerEndpoint =
      `${supabaseUrl.replace(/\/$/, "")}` +
      `/rest/v1/quotes` +
      `?id=eq.${encodeURIComponent(quote.id)}`;

    let saveCustomerResponse;

    try {
      saveCustomerResponse =
        await fetch(
          saveCustomerEndpoint,
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
                stripe_customer_id:
                  stripeCustomerId
              })
          }
        );
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            "Stripe customer was created but could not be saved.",
          detail:
            error?.message || null
        },
        500
      );
    }

    const saveCustomerData =
      await saveCustomerResponse
        .json()
        .catch(() => null);

    if (!saveCustomerResponse.ok) {
      return json(
        {
          ok: false,
          error:
            saveCustomerData?.message ||
            saveCustomerData?.error ||
            "Could not save Stripe customer."
        },
        500
      );
    }
  }

  /*
    CREATE STRIPE CHECKOUT SESSION

    SETUP MODE ONLY.

    This securely collects and saves the
    customer's card.

    NO MONEY IS CHARGED HERE.
  */

  const params =
    new URLSearchParams();

  params.set(
    "mode",
    "setup"
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
    "success_url",
    "https://thefreshstandardco.com/offer/success/" +
    "?session_id={CHECKOUT_SESSION_ID}"
  );

  params.set(
    "cancel_url",
    "https://thefreshstandardco.com/offer/" +
    "?token=" +
    encodeURIComponent(token)
  );

  /*
    SESSION METADATA

    The verified Stripe webhook uses this
    information to connect the completed
    Checkout Session back to the quote.
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
    "metadata[checkout_type]",
    "card_setup"
  );

  /*
    SETUP INTENT METADATA
  */

  params.set(
    "setup_intent_data[metadata][quote_id]",
    quote.id
  );

  params.set(
    "setup_intent_data[metadata][quote_number]",
    quote.quote_number || ""
  );

  params.set(
    "setup_intent_data[metadata][checkout_type]",
    "card_setup"
  );

  /*
    DUPLICATE SESSION PROTECTION

    This protects against:
    - double-clicks
    - repeated requests
    - multiple browser tabs
    - simultaneous requests

    For the same quote, Stripe returns the
    same Checkout Session rather than creating
    multiple identical setup sessions.
  */

  const checkoutIdempotencyKey =
    `fresh-standard-card-setup-${quote.id}`;

  let session;

  try {
    session =
      await stripePost(
        "checkout/sessions",
        stripeSecretKey,
        params,
        checkoutIdempotencyKey
      );
  } catch (error) {
    return json(
      {
        ok: false,
        error:
          "Could not create secure checkout.",
        detail:
          error?.message || null
      },
      500
    );
  }

  if (
    !session ||
    !session.id ||
    !session.url
  ) {
    return json(
      {
        ok: false,
        error:
          "Stripe did not return a valid secure checkout session."
      },
      500
    );
  }

  /*
    SAVE CHECKOUT SESSION.

    Status becomes "accepted" because the
    customer has accepted the quote and entered
    the secure card-confirmation process.

    The Stripe webhook is responsible for
    moving the record forward after the card
    is actually saved.
  */

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

          body:
            JSON.stringify({
              stripe_setup_session_id:
                session.id,

              quote_accepted_at:
                quote.quote_accepted_at ||
                new Date().toISOString(),

              status:
                "accepted"
            })
        }
      );
  } catch (error) {
    return json(
      {
        ok: false,
        error:
          "Secure checkout was created but the booking could not be updated.",
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
          "Checkout was created but the quote could not be updated."
      },
      500
    );
  }

  const updatedQuote =
    Array.isArray(updateData)
      ? updateData[0]
      : updateData;

  if (!updatedQuote) {
    return json(
      {
        ok: false,
        error:
          "Checkout was created but the booking update could not be confirmed."
      },
      500
    );
  }

  /*
    RETURN ONLY THE STRIPE-HOSTED CHECKOUT URL.

    Card information never passes through
    our website or database.
  */

  return json({
    ok: true,

    checkout_url:
      session.url,

    checkout_session_id:
      session.id,

    quote_number:
      updatedQuote.quote_number ||
      quote.quote_number ||
      null,

    status:
      updatedQuote.status ||
      "accepted"
  });
};
