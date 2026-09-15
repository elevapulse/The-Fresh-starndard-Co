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
    const error =
      new Error(
        data?.error?.message ||
        `Stripe request failed with status ${response.status}`
      );

    error.stripeCode =
      data?.error?.code || null;

    error.paymentIntent =
      data?.error?.payment_intent || null;

    throw error;
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
          apikey: serviceRoleKey,

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
      "Could not update booking."
    );
  }

  return Array.isArray(data)
    ? data[0]
    : data;
}


export default async (request) => {

  /*
    Only the owner dashboard should POST
    to this function.
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
    Require the owner password.

    The Stripe secret and Supabase service
    key never leave the server.
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
    Read the quote ID.

    IMPORTANT:
    The browser does NOT send us the amount.
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
    Get the authoritative booking record
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
    Prevent duplicate charges.

    A booking must be COMPLETED before
    this endpoint will attempt payment.
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
          `This booking cannot be charged while its status is "${quote.status}".`
      },
      400
    );
  }


  /*
    Validate the SERVER-SIDE amount.

    quoted_price is stored in cents.
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
    The card must already have been saved
    through Stripe Checkout.
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
    Build the Stripe PaymentIntent.

    off_session=true:
    The customer is not actively entering
    their card during this charge.

    confirm=true:
    Stripe immediately attempts payment.

    The amount comes ONLY from Supabase.
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
    "off_session",
    "true"
  );


  params.set(
    "confirm",
    "true"
  );


  params.set(
    "description",
    `The Fresh Standard Co. cleaning ${quote.quote_number || quoteId}`
  );


  params.set(
    "metadata[quote_id]",
    quoteId
  );


  params.set(
    "metadata[quote_number]",
    quote.quote_number || ""
  );


  /*
    Idempotency protects against accidental
    duplicate Stripe PaymentIntents if the
    owner double-clicks or the request retries.

    Each booking gets one deterministic
    completion charge key.
  */

  const idempotencyKey =
    `fresh-standard-charge-${quoteId}`;


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

    /*
      Some cards can require additional
      customer authentication.

      In that case we do NOT mark the
      booking as charged.
    */

    console.error(
      "Stripe charge failed:",
      error.message
    );


    return json(
      {
        ok: false,

        error:
          "The customer could not be charged.",

        detail:
          error.message,

        stripe_code:
          error.stripeCode || null,

        payment_intent_id:
          error.paymentIntent?.id || null
      },
      402
    );
  }


  /*
    We only mark the booking charged if
    Stripe explicitly reports success.
  */

  if (
    paymentIntent.status !==
    "succeeded"
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
    Stripe succeeded.

    NOW update Supabase.
  */

  const chargedAt =
    new Date().toISOString();


  let updatedQuote;


  try {

    updatedQuote =
      await updateQuote(
        quoteId,

        {
          status:
            "charged",

          stripe_payment_intent_id:
            paymentIntent.id,

          charged_at:
            chargedAt
        },

        supabaseUrl,
        serviceRoleKey
      );

  } catch (error) {

    /*
      Important:
      Stripe already charged successfully.

      Return a special error instead of
      attempting another payment.
    */

    console.error(
      "Payment succeeded but database update failed:",
      error.message
    );


    return json(
      {
        ok: false,

        payment_succeeded: true,

        error:
          "Stripe charged the customer, but the booking record could not be updated.",

        detail:
          error.message,

        payment_intent_id:
          paymentIntent.id
      },
      500
    );
  }


  return json({
    ok: true,

    message:
      "Customer charged successfully.",

    quote_id:
      quoteId,

    status:
      updatedQuote?.status ||
      "charged",

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

    payment_intent_id:
      paymentIntent.id,

    payment_status:
      paymentIntent.status,

    charged_at:
      updatedQuote?.charged_at ||
      chargedAt
  });
};
