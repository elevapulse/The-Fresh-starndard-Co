import crypto from "node:crypto";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}


/*
  Verify Stripe's webhook signature.

  IMPORTANT:
  STRIPE_WEBHOOK_SECRET must contain the whsec_...
  secret from the Stripe webhook endpoint.
*/

function verifyStripeSignature(
  rawBody,
  signatureHeader,
  webhookSecret
) {
  if (!signatureHeader) {
    throw new Error(
      "Missing Stripe-Signature header."
    );
  }

  const parts =
    signatureHeader.split(",");

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] =
      part.split("=");

    if (key === "t") {
      timestamp = value;
    }

    if (key === "v1") {
      signatures.push(value);
    }
  }

  if (!timestamp || !signatures.length) {
    throw new Error(
      "Invalid Stripe signature header."
    );
  }

  const signedPayload =
    `${timestamp}.${rawBody}`;

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        webhookSecret
      )
      .update(
        signedPayload,
        "utf8"
      )
      .digest("hex");


  const expectedBuffer =
    Buffer.from(
      expectedSignature,
      "hex"
    );


  let valid = false;

  for (const signature of signatures) {
    try {
      const signatureBuffer =
        Buffer.from(
          signature,
          "hex"
        );

      if (
        signatureBuffer.length ===
        expectedBuffer.length
      ) {
        if (
          crypto.timingSafeEqual(
            signatureBuffer,
            expectedBuffer
          )
        ) {
          valid = true;
          break;
        }
      }

    } catch {
      // Ignore malformed signatures.
    }
  }

  if (!valid) {
    throw new Error(
      "Stripe signature verification failed."
    );
  }


  /*
    Reject very old webhook requests.
    Stripe commonly recommends a tolerance window.
  */

  const eventTime =
    Number(timestamp);

  const currentTime =
    Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(eventTime) ||
    Math.abs(currentTime - eventTime) > 300
  ) {
    throw new Error(
      "Stripe webhook timestamp is outside tolerance."
    );
  }

  return true;
}


/*
  Retrieve an object directly from Stripe.
*/

async function stripeGet(
  path,
  stripeSecretKey
) {
  const response =
    await fetch(
      `https://api.stripe.com/v1/${path}`,
      {
        headers: {
          Authorization:
            `Bearer ${stripeSecretKey}`
        }
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


/*
  Update a quote in Supabase.
*/

async function updateQuote(
  quoteId,
  values,
  supabaseUrl,
  serviceRoleKey
) {
  const endpoint =
    `${supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}`;

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
      "Could not update quote in Supabase."
    );
  }


  return Array.isArray(data)
    ? data[0]
    : data;
}


/*
  Main Netlify Function
*/

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


  const webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET;

  const stripeSecretKey =
    process.env.STRIPE_SECRET_KEY;

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;


  if (
    !webhookSecret ||
    !stripeSecretKey ||
    !supabaseUrl ||
    !serviceRoleKey
  ) {
    console.error(
      "Stripe webhook environment variables are incomplete."
    );

    return json(
      {
        received: false,
        error:
          "Webhook configuration is incomplete."
      },
      500
    );
  }


  /*
    Stripe signature verification MUST use
    the exact raw request body.
  */

  const rawBody =
    await request.text();

  const signatureHeader =
    request.headers.get(
      "stripe-signature"
    );


  try {
    verifyStripeSignature(
      rawBody,
      signatureHeader,
      webhookSecret
    );
  } catch (error) {

    console.error(
      "Webhook signature error:",
      error.message
    );

    return json(
      {
        received: false,
        error:
          "Invalid webhook signature."
      },
      400
    );
  }


  let event;

  try {
    event =
      JSON.parse(rawBody);
  } catch {

    return json(
      {
        received: false,
        error:
          "Invalid webhook payload."
      },
      400
    );
  }


  console.log(
    "Stripe event received:",
    event.type,
    event.id
  );


  /*
    We currently care about successful
    Stripe Checkout completion.

    Our Checkout Session uses mode=setup,
    meaning the card is SAVED but NOT charged.
  */

  if (
    event.type ===
    "checkout.session.completed"
  ) {

    const session =
      event.data?.object;


    if (!session) {
      return json({
        received: true
      });
    }


    /*
      Only process our card-saving
      Checkout Sessions.
    */

    if (session.mode !== "setup") {
      console.log(
        "Ignoring non-setup Checkout Session."
      );

      return json({
        received: true
      });
    }


    const quoteId =
      session.metadata?.quote_id;


    if (!quoteId) {
      console.error(
        "Checkout Session has no quote_id metadata."
      );

      return json(
        {
          received: false,
          error:
            "Missing quote metadata."
        },
        400
      );
    }


    const setupIntentId =
      session.setup_intent;


    if (!setupIntentId) {
      console.error(
        "Checkout Session has no SetupIntent."
      );

      return json(
        {
          received: false,
          error:
            "Missing SetupIntent."
        },
        400
      );
    }


    try {

      /*
        Retrieve the SetupIntent so we can
        obtain the saved PaymentMethod ID.
      */

      const setupIntent =
        await stripeGet(
          `setup_intents/${encodeURIComponent(setupIntentId)}`,
          stripeSecretKey
        );


      const paymentMethodId =
        setupIntent.payment_method;


      if (!paymentMethodId) {
        throw new Error(
          "SetupIntent does not contain a payment method."
        );
      }


      const stripeCustomerId =
        session.customer ||
        setupIntent.customer ||
        null;


      /*
        Save Stripe references in Supabase.

        This is what allows us to charge
        this exact customer's saved card later.
      */

      const updatedQuote =
        await updateQuote(
          quoteId,

          {
            stripe_customer_id:
              stripeCustomerId,

            stripe_payment_method_id:
              paymentMethodId,

            stripe_setup_session_id:
              session.id,

            card_saved_at:
              new Date().toISOString(),

            status:
              "card_saved"
          },

          supabaseUrl,
          serviceRoleKey
        );


      console.log(
        "Card saved successfully for quote:",
        quoteId
      );


      return json({
        received: true,
        processed: true,
        quote_id:
          quoteId,
        status:
          updatedQuote?.status ||
          "card_saved"
      });


    } catch (error) {

      console.error(
        "Could not process completed Checkout Session:",
        error.message
      );


      /*
        Return 500 so Stripe knows processing
        failed and can retry the webhook.
      */

      return json(
        {
          received: false,
          error:
            "Could not save payment information.",
          detail:
            error.message
        },
        500
      );
    }
  }


  /*
    Other Stripe events can safely be acknowledged.
  */

  return json({
    received: true
  });
};
