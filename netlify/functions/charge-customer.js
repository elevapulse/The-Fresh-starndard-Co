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
  Payment confirmation email helpers.
*/

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function formatUsd(cents) {
  const amount =
    Number(cents);

  if (
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    return null;
  }

  return (
    amount / 100
  ).toLocaleString(
    "en-US",
    {
      style: "currency",
      currency: "USD"
    }
  );
}


/*
  Send payment confirmation AFTER:
  1. Stripe confirms the charge succeeded.
  2. Supabase is updated to "charged".

  IMPORTANT:
  Email failure is NON-FATAL.

  The customer has already been charged at
  this point, so an email problem must never
  cause another payment attempt.
*/

async function sendPaymentConfirmation(
  quote,
  paymentIntent,
  resendApiKey,
  fromEmail
) {
  if (
    !resendApiKey ||
    !fromEmail
  ) {
    console.error(
      "Payment confirmation skipped: Resend configuration is incomplete."
    );

    return {
      ok: false,
      skipped: true
    };
  }


  const customerEmail =
    String(
      quote?.customer_email || ""
    ).trim();


  if (!customerEmail) {
    console.error(
      "Payment confirmation skipped: booking has no customer email."
    );

    return {
      ok: false,
      skipped: true
    };
  }


  const customerName =
    String(
      quote?.customer_name || ""
    ).trim();


  const firstName =
    customerName
      ? customerName.split(/\s+/)[0]
      : "there";


  const quoteNumber =
    quote?.quote_number ||
    "—";


  const service =
    quote?.service_type ||
    "Cleaning Service";


  const property =
    quote?.property_type ||
    "—";


  const amount =
    formatUsd(
      quote?.quoted_price
    ) || "—";


  const paymentReference =
    paymentIntent?.id ||
    "—";


  const subject =
    `Payment Received — ${quoteNumber} — The Fresh Standard Co.`;


  const plainText = [
    `Hi ${firstName},`,
    "",
    "Payment complete.",
    "",
    "Your payment for your cleaning service with The Fresh Standard Co. was processed successfully.",
    "",
    `Quote: ${quoteNumber}`,
    `Service: ${service}`,
    `Property: ${property}`,
    `Amount Paid: ${amount}`,
    `Payment Reference: ${paymentReference}`,
    "",
    "No further payment is required for this cleaning service.",
    "",
    "Your payment was processed securely through Stripe.",
    "",
    "If you have any questions, contact us:",
    "",
    "954-379-6765",
    "thefreshstandardco@outlook.com",
    "",
    "Thank you for choosing The Fresh Standard Co."
  ].join("\n");


  const html = `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>

<body style="margin:0;padding:0;background:#f4f1e9;font-family:Arial,Helvetica,sans-serif;color:#17352b;">

  <div style="max-width:620px;margin:0 auto;padding:40px 20px;">

    <div style="background:#fffdf8;border-radius:24px;padding:42px;">

      <div style="text-align:center;margin-bottom:34px;">

        <div style="font-family:Georgia,'Times New Roman',serif;font-size:25px;letter-spacing:2px;font-weight:600;color:#17352b;">
          THE FRESH
        </div>

        <div style="margin-top:6px;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#758b78;">
          Standard Co.
        </div>

      </div>


      <div style="width:54px;height:54px;border-radius:50%;background:#17352b;color:#ffffff;margin:0 auto 22px;line-height:54px;text-align:center;font-size:26px;font-weight:700;">
        ✓
      </div>


      <div style="text-align:center;text-transform:uppercase;letter-spacing:3px;font-size:11px;font-weight:700;color:#758b78;margin-bottom:12px;">
        Payment Complete
      </div>


      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:400;text-align:center;margin:0 0 16px;color:#17352b;">
        Thank you.
      </h1>


      <p style="font-size:16px;line-height:1.7;color:#64716b;text-align:center;margin:0 0 34px;">
        Hi ${escapeHtml(firstName)}, your payment has been completed successfully.
        No further payment is required for this cleaning service.
      </p>


      <div style="border-top:1px solid #e6e5df;border-bottom:1px solid #e6e5df;padding:22px 0;margin-bottom:30px;">

        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">
            Quote:
          </strong>
          ${escapeHtml(quoteNumber)}
        </p>


        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">
            Service:
          </strong>
          ${escapeHtml(service)}
        </p>


        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">
            Property:
          </strong>
          ${escapeHtml(property)}
        </p>


        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">
            Amount Paid:
          </strong>
          ${escapeHtml(amount)}
        </p>


        <p style="margin:8px 0;font-size:15px;color:#64716b;">
          <strong style="color:#17352b;">
            Payment Reference:
          </strong>
          ${escapeHtml(paymentReference)}
        </p>

      </div>


      <div style="background:#f7f7f2;border:1px solid #e1e5de;border-radius:16px;padding:20px;margin-bottom:28px;">

        <div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;margin-bottom:8px;color:#17352b;">
          Payment received
        </div>


        <p style="font-size:14px;line-height:1.65;color:#69736e;margin:0;">
          Your payment was processed securely through Stripe.
          Thank you for choosing The Fresh Standard Co.
        </p>

      </div>


      <p style="font-size:14px;line-height:1.7;color:#69736e;text-align:center;margin:0;">

        Questions about your service or payment?

        <br>

        <a href="tel:+19543796765" style="color:#17352b;font-weight:600;text-decoration:none;">
          954-379-6765
        </a>

        <br>

        <a href="mailto:thefreshstandardco@outlook.com" style="color:#17352b;font-weight:600;text-decoration:none;">
          thefreshstandardco@outlook.com
        </a>

      </p>

    </div>

  </div>

</body>
</html>
  `.trim();


  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${resendApiKey}`,

          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            from:
              fromEmail,

            to: [
              customerEmail
            ],

            subject,

            text:
              plainText,

            html
          })
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
      `Resend returned status ${response.status}.`
    );
  }


  return {
    ok: true,

    email_id:
      data?.id || null
  };
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


  /*
    PAYMENT CONFIRMATION EMAIL

    Stripe has succeeded AND Supabase has
    recorded the booking as charged.

    Email delivery is intentionally non-fatal.
    We must never retry or reverse a successful
    payment merely because an email fails.
  */

  let paymentEmailSent =
    false;


  try {

    const emailResult =
      await sendPaymentConfirmation(
        updatedQuote || quote,
        paymentIntent,
        process.env.RESEND_API_KEY,
        process.env.FROM_EMAIL
      );


    paymentEmailSent =
      !!emailResult?.ok;


    if (paymentEmailSent) {
      console.log(
        "Payment confirmation email sent:",
        quoteId,
        emailResult?.email_id || null
      );
    }

  } catch (emailError) {

    console.error(
      "Payment confirmation email failed:",
      quoteId,
      emailError.message
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
      chargedAt,

    payment_confirmation_email_sent:
      paymentEmailSent
  });
};
