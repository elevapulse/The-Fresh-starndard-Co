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

async function stripePost(path, secretKey, params) {
  const response = await fetch(
    `https://api.stripe.com/v1/${path}`,
    {
      method: "POST",
      headers: stripeHeaders(secretKey),
      body: params.toString()
    }
  );

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `Stripe request failed with status ${response.status}`
    );
  }

  return data;
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
        error: "Server configuration is incomplete."
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

  const quoteEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes` +
    `?quote_token=eq.${encodeURIComponent(token)}` +
    `&select=*`;

  let quoteResponse;

  try {
    quoteResponse = await fetch(
      quoteEndpoint,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`
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
    await quoteResponse.json().catch(() => null);

  if (!quoteResponse.ok) {
    return json(
      {
        ok: false,
        error:
          quoteData?.message ||
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

  if (
    !quote.quoted_price ||
    Number(quote.quoted_price) <= 0
  ) {
    return json(
      {
        ok: false,
        error: "This quote has not been priced."
      },
      400
    );
  }

  const allowedStatuses = [
    "quoted",
    "accepted",
    "card_saved",
    "booked"
  ];

  if (!allowedStatuses.includes(quote.status)) {
    return json(
      {
        ok: false,
        error: "This quote is not available for booking."
      },
      400
    );
  }

  let stripeCustomerId =
    quote.stripe_customer_id;

  /*
   * Create Stripe customer if this quote
   * does not already have one.
   */

  if (!stripeCustomerId) {
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

      customerParams.set(
        "metadata[quote_id]",
        quote.id
      );

      customerParams.set(
        "metadata[quote_number]",
        quote.quote_number || ""
      );

      const customer =
        await stripePost(
          "customers",
          stripeSecretKey,
          customerParams
        );

      stripeCustomerId =
        customer.id;

    } catch (error) {
      return json(
        {
          ok: false,
          error: "Could not create Stripe customer.",
          detail: error.message
        },
        500
      );
    }

    const saveCustomerEndpoint =
      `${supabaseUrl.replace(/\/$/, "")}` +
      `/rest/v1/quotes?id=eq.${encodeURIComponent(quote.id)}`;

    const saveCustomerResponse =
      await fetch(
        saveCustomerEndpoint,
        {
          method: "PATCH",

          headers: {
            apikey: serviceRoleKey,
            Authorization:
              `Bearer ${serviceRoleKey}`,
            "content-type":
              "application/json"
          },

          body: JSON.stringify({
            stripe_customer_id:
              stripeCustomerId
          })
        }
      );

    if (!saveCustomerResponse.ok) {
      const saveError =
        await saveCustomerResponse
          .json()
          .catch(() => null);

      return json(
        {
          ok: false,
          error:
            saveError?.message ||
            "Could not save Stripe customer."
        },
        500
      );
    }
  }

  /*
   * Create Stripe Checkout Session
   * in SETUP mode.
   *
   * This SAVES the card.
   * It DOES NOT charge the quoted amount.
   */

  let session;

  try {
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
      "setup_intent_data[metadata][quote_id]",
      quote.id
    );

    params.set(
      "setup_intent_data[metadata][quote_number]",
      quote.quote_number || ""
    );

    session =
      await stripePost(
        "checkout/sessions",
        stripeSecretKey,
        params
      );

  } catch (error) {
    return json(
      {
        ok: false,
        error: "Could not create secure checkout.",
        detail: error.message
      },
      500
    );
  }

  /*
   * Save session information.
   */

  const updateEndpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes?id=eq.${encodeURIComponent(quote.id)}`;

  const updateResponse =
    await fetch(
      updateEndpoint,
      {
        method: "PATCH",

        headers: {
          apikey: serviceRoleKey,
          Authorization:
            `Bearer ${serviceRoleKey}`,
          "content-type":
            "application/json"
        },

        body: JSON.stringify({
          stripe_setup_session_id:
            session.id,

          quote_accepted_at:
            new Date().toISOString(),

          status:
            "accepted"
        })
      }
    );

  if (!updateResponse.ok) {
    const updateError =
      await updateResponse
        .json()
        .catch(() => null);

    return json(
      {
        ok: false,
        error:
          updateError?.message ||
          "Checkout was created but the quote could not be updated."
      },
      500
    );
  }

  return json({
    ok: true,
    checkout_url: session.url
  });
};
