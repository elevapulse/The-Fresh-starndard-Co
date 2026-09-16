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

    error.declineCode =
      data?.error?.decline_code || null;

    error.stripeType =
      data?.error?.type || null;

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


/*
  Classify Stripe failures.

  Any failure that requires the customer to
  authenticate, replace their card, contact
  their bank, or use another payment method
  should open the secure recovery flow.
*/

function classifyStripeFailure(error) {
  const stripeCode =
    String(
      error?.stripeCode || ""
    ).toLowerCase();

  const declineCode =
    String(
      error?.declineCode || ""
    ).toLowerCase();

  const stripeType =
    String(
      error?.stripeType || ""
    ).toLowerCase();

  const paymentIntentStatus =
    String(
      error?.paymentIntent?.status || ""
    ).toLowerCase();


  /*
    Authentication / 3D Secure required.
  */

  const authenticationRequired =
    stripeCode ===
      "authentication_required" ||

    declineCode ===
      "authentication_required" ||

    paymentIntentStatus ===
      "requires_action";


  if (authenticationRequired) {
    return {
      failure_type:
        "authentication_required",

      customer_action_required:
        true,

      customer_message:
        "The customer's bank requires additional authentication. Send the customer the secure payment link to complete the payment."
    };
  }


  /*
    Insufficient funds.

    The saved card cannot complete the charge.
    The customer should be sent back through
    secure Stripe Checkout so they can use
    another payment method.
  */

  if (
    declineCode ===
      "insufficient_funds" ||

    stripeCode ===
      "insufficient_funds"
  ) {
    return {
      failure_type:
        "insufficient_funds",

      customer_action_required:
        true,

      customer_message:
        "The customer's saved payment method has insufficient funds. Send the customer the secure payment link so they can use another payment method."
    };
  }


  /*
    Other card declines.

    Stripe commonly returns:
      code = card_declined
      decline_code = the specific reason

    These should also use the recovery link.
  */

  const cardDeclined =
    stripeCode ===
      "card_declined" ||

    stripeType ===
      "card_error";


  if (cardDeclined) {
    return {
      failure_type:
        declineCode ||
        "card_declined",

      customer_action_required:
        true,

      customer_message:
        "The customer's saved payment method was declined. Send the customer the secure payment link so they can use another payment method."
    };
  }


  /*
    PaymentIntent states where Stripe is
    explicitly waiting for a different or
    corrected payment method.
  */

  if (
    paymentIntentStatus ===
      "requires_payment_method"
  ) {
    return {
      failure_type:
        "requires_payment_method",

      customer_action_required:
        true,

      customer_message:
        "The saved payment method could not complete the payment. Send the customer the secure payment link so they can use another payment method."
    };
  }


  /*
    Unknown/system failure.

    Do NOT automatically send the customer
    through recovery because this may be an
    API/configuration/server problem rather
    than a card problem.
  */

  return {
    failure_type:
      "payment_failed",

    customer_action_required:
      false,

    customer_message:
      "Stripe could not complete this payment. Review the payment before trying again."
  };
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
      Stripe did NOT report a successful charge.

      Classify the failure so the dashboard
      knows whether the customer needs to
      authenticate or replace their card.

      We do NOT mark the booking charged.
    */

    console.error(
      "Stripe charge failed:",
      error.message
    );


    const failure =
      classifyStripeFailure(error);


    return json(
      {
        ok: false,

        error:
          "The customer could not be charged.",

        detail:
          error.message,

        failure_type:
          failure.failure_type,

        customer_action_required:
          failure.customer_action_required,

        customer_message:
          failure.customer_message,

        stripe_code:
          error.stripeCode || null,

        decline_code:
          error.declineCode || null,

        payment_status:
          error.paymentIntent?.status || null,

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

    const paymentIntentStatus =
      String(
        paymentIntent.status || ""
      ).toLowerCase();


    const customerActionRequired =
      paymentIntentStatus ===
        "requires_action" ||

      paymentIntentStatus ===
        "requires_payment_method";


    return json(
      {
        ok: false,

        error:
          paymentIntentStatus ===
            "requires_action"
            ? "The customer must authenticate this payment."
            : "Stripe did not confirm the payment.",

        failure_type:
          paymentIntentStatus ===
            "requires_action"
            ? "authentication_required"
            : paymentIntentStatus ===
                "requires_payment_method"
              ? "requires_payment_method"
              : "payment_failed",

        customer_action_required:
          customerActionRequired,

        customer_message:
          paymentIntentStatus ===
            "requires_action"
            ? "The customer's bank requires additional authentication. Send the customer the secure payment link to complete the payment."
            : paymentIntentStatus ===
                "requires_payment_method"
              ? "The saved payment method could not complete the payment. Send the customer the secure payment link so they can use another payment method."
              : "Stripe could not complete this payment. Review the payment before trying again.",

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
