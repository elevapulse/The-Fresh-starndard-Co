function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}


function stripeHeaders(
  secretKey,
  idempotencyKey = null
) {
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    "content-type": "application/x-www-form-urlencoded"
  };

  if (idempotencyKey) {
    headers["Idempotency-Key"] =
      idempotencyKey;
  }

  return headers;
}


async function stripePost(
  path,
  secretKey,
  params,
  idempotencyKey = null
) {
  const response =
    await fetch(
      `https://api.stripe.com/v1/${path}`,
      {
        method: "POST",

        headers:
          stripeHeaders(
            secretKey,
            idempotencyKey
          ),

        body:
          params.toString()
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
          apikey:
            serviceRoleKey,

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
      data?.error ||
      "Could not retrieve quote."
    );
  }

  return Array.isArray(data)
    ? data[0]
    : null;
}


async function updateQuote(
  quoteId,
  values,
  supabaseUrl,
  serviceRoleKey
) {
  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?id=eq.${encodeURIComponent(quoteId)}`;

  const response =
    await fetch(
      endpoint,
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
          JSON.stringify(values)
      }
    );

  const data =
    await response
      .json()
      .catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Could not update quote."
    );
  }

  return Array.isArray(data)
    ? data[0]
    : data;
}


export default async (request) => {

  /*
    CUSTOMER BOOKING / CARD AUTHORIZATION

    Customer reaches this endpoint using ONLY
    the secure quote token.

    Browser never controls:
    - price
    - quote ID
    - customer ID
    - booking status
  */

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error:
          "Method not allowed."
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


  const token =
    String(
      body.token || ""
    ).trim();


  if (!token) {
    return json(
      {
        ok: false,
        error:
          "Offer token is required."
      },
      400
    );
  }


  /*
    LOAD AUTHORITATIVE QUOTE
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
    console.error(
      "Quote lookup failed:",
      error.message
    );

    return json(
      {
        ok: false,
        error:
          "Could not retrieve quote.",
        detail:
          error.message
      },
      500
    );
  }


  if (!quote) {
    return json(
      {
        ok: false,
        error:
          "This quote link is invalid."
      },
      404
    );
  }


  /*
    VALIDATE SERVER-SIDE PRICE
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
          "This quote has not been priced."
      },
      400
    );
  }


  /*
    DO NOT CREATE ANOTHER SETUP SESSION
    AFTER CARD AUTHORIZATION IS COMPLETE.
  */

  if (
    quote.status === "card_saved" ||
    quote.status === "booked"
  ) {
    return json(
      {
        ok: true,
        already_confirmed: true,
        status:
          quote.status,
        message:
          "This booking has already been confirmed."
      }
    );
  }


  /*
    TERMINAL / LATER STAGES
  */

  if (
    quote.status === "completed" ||
    quote.status === "charged"
  ) {
    return json(
      {
        ok: false,
        already_completed: true,
        error:
          "This booking is no longer available for confirmation."
      },
      409
    );
  }


  if (
    quote.status === "cancelled"
  ) {
    return json(
      {
        ok: false,
        cancelled: true,
        error:
          "This booking has been cancelled."
      },
      409
    );
  }


  /*
    ONLY THESE STATUSES MAY START
    THE CARD AUTHORIZATION FLOW.

    "accepted" is allowed because Stripe
    Checkout may have been created previously
    but not completed.
  */

  const allowedStatuses = [
    "quoted",
    "accepted"
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
          "This quote is not available for booking."
      },
      409
    );
  }


  /*
    CREATE OR REUSE STRIPE CUSTOMER
  */

  let stripeCustomerId =
    String(
      quote.stripe_customer_id ||
      ""
    ).trim();


  if (!stripeCustomerId) {

    try {

      const customerParams =
        new URLSearchParams();


      customerParams.set(
        "name",
        quote.customer_name || ""
      );


      customerParams.set(
        "email",
        quote.customer_email || ""
      );


      customerParams.set(
        "metadata[quote_id]",
        quote.id
      );


      customerParams.set(
        "metadata[quote_number]",
        quote.quote_number || ""
      );


      /*
        IDEMPOTENCY PROTECTION

        Repeated requests for the same quote
        return the same Stripe Customer instead
        of creating duplicates.
      */

      const customer =
        await stripePost(
          "customers",
          stripeSecretKey,
          customerParams,
          `fresh-standard-customer-${quote.id}`
        );


      if (!customer?.id) {
        throw new Error(
          "Stripe did not return a customer ID."
        );
      }


      stripeCustomerId =
        customer.id;


      /*
        SAVE CUSTOMER ID BEFORE CONTINUING
      */

      await updateQuote(
        quote.id,
        {
          stripe_customer_id:
            stripeCustomerId
        },
        supabaseUrl,
        serviceRoleKey
      );


    } catch (error) {

      console.error(
        "Stripe customer creation failed:",
        error.message
      );


      return json(
        {
          ok: false,
          error:
            "Could not create Stripe customer.",
          detail:
            error.message
        },
        500
      );
    }
  }


  /*
    CREATE STRIPE CHECKOUT SESSION

    IMPORTANT:
    mode=setup means the customer is NOT
    charged here.

    Stripe securely collects and authenticates
    the payment method for future off-session
    charging.
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
    CHECKOUT SESSION METADATA
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
    "setup_intent_data[metadata][payment_type]",
    "card_setup"
  );


  /*
    CREATE SESSION WITH IDEMPOTENCY.

    Double-clicking, refreshing or sending
    simultaneous requests will not create
    multiple Setup Checkout Sessions for
    this quote.
  */

  let session;

  try {

    session =
      await stripePost(
        "checkout/sessions",
        stripeSecretKey,
        params,
        `fresh-standard-setup-${quote.id}`
      );


  } catch (error) {

    console.error(
      "Checkout Session creation failed:",
      error.message
    );


    return json(
      {
        ok: false,
        error:
          "Could not create secure checkout.",
        detail:
          error.message
      },
      500
    );
  }


  if (
    !session?.id ||
    !session?.url
  ) {
    return json(
      {
        ok: false,
        error:
          "Stripe did not return a valid Checkout Session."
      },
      500
    );
  }


  /*
    SAVE CHECKOUT SESSION.

    Status becomes accepted because the customer
    has started the booking authorization flow.

    The Stripe webhook is responsible for changing
    this to card_saved ONLY after Stripe confirms
    successful SetupIntent completion.
  */

  let updatedQuote;

  try {

    updatedQuote =
      await updateQuote(
        quote.id,

        {
          stripe_setup_session_id:
            session.id,

          quote_accepted_at:
            quote.quote_accepted_at ||
            new Date().toISOString(),

          status:
            "accepted"
        },

        supabaseUrl,
        serviceRoleKey
      );


  } catch (error) {

    console.error(
      "Could not save Checkout Session:",
      error.message
    );


    return json(
      {
        ok: false,
        error:
          "Checkout was created but the quote could not be updated.",
        detail:
          error.message
      },
      500
    );
  }


  /*
    RETURN ONLY THE STRIPE-HOSTED URL.

    No payment details or server credentials
    are exposed to the browser.
  */

  return json({
    ok: true,

    quote_number:
      updatedQuote?.quote_number ||
      quote.quote_number ||
      null,

    status:
      updatedQuote?.status ||
      "accepted",

    checkout_url:
      session.url
  });
};
