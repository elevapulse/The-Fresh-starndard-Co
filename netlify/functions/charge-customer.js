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
      `Payment confirmation email failed with status ${response.status}`
    );
  }


  return {
    ok: true,
    email_id:
      data?.id || null
  };
}


function classifyStripeFailure(error) {
  const stripeCode =
    String(
      error?.stripeCode || ""
    ).toLowerCase();

  const declineCode =
    String(
      error?.declineCode || ""
    ).toLowerCase();

  const paymentStatus =
    String(
      error?.paymentIntent?.status || ""
    ).toLowerCase();


  const authenticationRequired =
    stripeCode ===
      "authentication_required" ||

    declineCode ===
      "authentication_required" ||

    paymentStatus ===
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


  const cardDeclined =
    stripeCode ===
      "card_declined" ||

    declineCode ===
      "generic_decline" ||

    declineCode ===
      "insufficient_funds" ||

    declineCode ===
      "lost_card" ||

    declineCode ===
      "stolen_card" ||

    declineCode ===
      "expired_card" ||

    declineCode ===
      "incorrect_cvc" ||

    declineCode ===
      "processing_error";


  if (cardDeclined) {
    return {
      failure_type:
        "card_declined",

      customer_action_required:
        true,

      customer_message:
        "The saved card could not be charged. Send the customer the secure payment link so they can use another payment method."
    };
  }


  return {
    failure_type:
      "payment_failed",

    customer_action_required:
      true,

    customer_message:
      "The payment could not be completed. Send the customer the secure payment link to complete payment."
  };
}


export default async (request) => {

  /*
    ONLY POST
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


  /*
    SERVER CONFIGURATION
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
    ADMIN AUTHENTICATION
  */

  const suppliedPassword =
    String(
      request.headers.get(
        "x-admin-password"
      ) || ""
    );


  if (
    suppliedPassword !==
    adminPassword
  ) {
    return json(
      {
        ok: false,
        error:
          "Unauthorized."
      },
      401
    );
  }


  /*
    REQUEST BODY
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


  const quoteId =
    String(
      body.quote_id || ""
    ).trim();


  if (!quoteId) {
    return json(
      {
        ok: false,
        error:
          "Quote ID is required."
      },
      400
    );
  }


  /*
    LOAD BOOKING FROM DATABASE.

    NEVER trust:
    - browser amount
    - browser customer ID
    - browser payment method
    - browser booking status
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
        error:
          "Booking not found."
      },
      404
    );
  }


  /*
    DUPLICATE CHARGE PROTECTION.

    If our database already says charged,
    NEVER create another PaymentIntent.
  */

  if (
    quote.status === "charged"
  ) {
    return json({
      ok: true,

      already_charged:
        true,

      message:
        "This booking has already been charged.",

      quote_id:
        quote.id,

      quote_number:
        quote.quote_number ||
        null,

      status:
        "charged",

      payment_intent_id:
        quote.stripe_payment_intent_id ||
        null,

      charged_at:
        quote.charged_at ||
        null,

      amount:
        quote.quoted_price,

      amount_formatted:
        formatUsd(
          quote.quoted_price
        )
    });
  }


  /*
    EXTRA DUPLICATE PROTECTION.

    If a PaymentIntent is already recorded,
    do not risk charging again even if the
    status was accidentally not updated.
  */

  if (
    quote.stripe_payment_intent_id
  ) {
    return json(
      {
        ok: false,

        payment_may_have_succeeded:
          true,

        error:
          "A Stripe payment is already associated with this booking. Review the payment before trying again.",

        payment_intent_id:
          quote.stripe_payment_intent_id
      },
      409
    );
  }


  /*
    CUSTOMER MAY ONLY BE CHARGED AFTER
    CLEANING IS MARKED COMPLETE.
  */

  if (
    quote.status !== "completed"
  ) {
    return json(
      {
        ok: false,

        error:
          `This booking cannot be charged while its status is "${quote.status}".`
      },
      409
    );
  }


  /*
    VALIDATE SERVER-SIDE AMOUNT.
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
          "This booking does not have a valid charge amount."
      },
      400
    );
  }


  /*
    VALIDATE SAVED STRIPE CUSTOMER
    AND PAYMENT METHOD.
  */

  const stripeCustomerId =
    String(
      quote.stripe_customer_id || ""
    ).trim();


  const stripePaymentMethodId =
    String(
      quote.stripe_payment_method_id || ""
    ).trim();


  if (
    !stripeCustomerId ||
    !stripePaymentMethodId
  ) {
    return json(
      {
        ok: false,

        error:
          "This booking does not have a saved payment method.",

        customer_action_required:
          true,

        failure_type:
          "requires_payment_method",

        customer_message:
          "The customer needs to provide a valid payment method before payment can be completed."
      },
      400
    );
  }


  /*
    CREATE OFF-SESSION PAYMENTINTENT.

    We use a deterministic idempotency key
    based on the booking ID.

    This prevents accidental duplicate
    PaymentIntent creation if:
    - admin double-clicks
    - browser retries
    - Netlify retries
    - request times out
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
    stripePaymentMethodId
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
    `The Fresh Standard Co. — ${quote.quote_number || quote.id}`
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
    "metadata[payment_type]",
    "cleaning_service"
  );


  const idempotencyKey =
    `fresh-standard-charge-${quote.id}`;


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

      We DO NOT update Supabase to charged.
    */

    console.error(
      "Stripe charge failed:",
      error.message
    );


    const failure =
      classifyStripeFailure(
        error
      );


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
          error.stripeCode ||
          null,

        decline_code:
          error.declineCode ||
          null,

        payment_status:
          error.paymentIntent?.status ||
          null,

        payment_intent_id:
          error.paymentIntent?.id ||
          null
      },
      402
    );
  }


  /*
    STRIPE MUST EXPLICITLY REPORT SUCCESS.
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
    STRIPE SUCCEEDED.

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
      IMPORTANT:

      Stripe already charged successfully.

      Never attempt another payment just
      because Supabase failed to update.
    */

    console.error(
      "Payment succeeded but database update failed:",
      error.message
    );


    return json(
      {
        ok: false,

        payment_succeeded:
          true,

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
    CUSTOMER PAYMENT CONFIRMATION.

    Stripe succeeded AND Supabase says charged.

    Email failure is NON-FATAL.
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
        emailResult?.email_id ||
        null
      );
    }

  } catch (emailError) {

    console.error(
      "Payment confirmation email failed:",
      quoteId,
      emailError.message
    );
  }


  /*
    OWNER PAYMENT SUCCESS NOTIFICATION.

    Payment and database update are already
    complete before this runs.

    Email failure is NON-FATAL.
  */

  let ownerPaymentEmailSent =
    false;


  const resendApiKey =
    process.env.RESEND_API_KEY;


  const fromEmail =
    process.env.FROM_EMAIL;


  if (
    resendApiKey &&
    fromEmail
  ) {

    try {

      const amountFormatted =
        (
          amount / 100
        ).toLocaleString(
          "en-US",
          {
            style:
              "currency",

            currency:
              "USD"
          }
        );


      const finalQuote =
        updatedQuote ||
        quote;


      const quoteNumber =
        finalQuote?.quote_number ||
        quoteId;


      const customerName =
        finalQuote?.customer_name ||
        "";


      const customerEmail =
        finalQuote?.customer_email ||
        "";


      const customerPhone =
        finalQuote?.customer_phone ||
        "";


      const service =
        finalQuote?.service_type ||
        "Cleaning Service";


      const ownerText = [
        "A customer payment has been completed successfully.",
        "",
        `Quote: ${quoteNumber}`,
        `Customer: ${customerName}`,
        `Email: ${customerEmail}`,
        `Phone: ${customerPhone}`,
        `Service: ${service}`,
        `Amount Paid: ${amountFormatted}`,
        "",
        `Stripe PaymentIntent: ${paymentIntent.id}`,
        `Stripe Status: ${paymentIntent.status}`,
        "Booking Status: CHARGED",
        "",
        paymentEmailSent
          ? "Customer payment confirmation email: Sent successfully."
          : "Customer payment confirmation email: Not sent or failed."
      ].join("\n");


      const ownerHtml = `
<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f4f1e9;
    font-family:Arial,Helvetica,sans-serif;
    color:#1c2823;
  "
>

<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
  style="
    width:100%;
    background:#f4f1e9;
    padding:36px 16px;
  "
>

<tr>
<td align="center">

<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
  style="
    width:100%;
    max-width:620px;
    background:#fffdf8;
    border-radius:24px;
    overflow:hidden;
    border:1px solid #dce2dc;
  "
>

<tr>
<td
  style="
    background:#17352b;
    padding:30px 34px;
    color:#ffffff;
  "
>

<div
  style="
    font-family:Georgia,serif;
    font-size:23px;
    letter-spacing:2px;
  "
>
  THE FRESH
</div>

<div
  style="
    margin-top:4px;
    color:#c8d3cc;
    font-size:11px;
    letter-spacing:3px;
    text-transform:uppercase;
  "
>
  Standard Co.
</div>

</td>
</tr>


<tr>
<td
  style="
    padding:42px 36px;
  "
>

<div
  style="
    color:#718679;
    font-size:11px;
    font-weight:700;
    letter-spacing:2px;
    text-transform:uppercase;
    margin-bottom:10px;
  "
>
  Payment Successful
</div>


<h1
  style="
    margin:0;
    color:#17352b;
    font-family:Georgia,serif;
    font-size:34px;
    font-weight:400;
    line-height:1.2;
  "
>
  Customer payment received.
</h1>


<p
  style="
    margin:18px 0 0;
    color:#69756f;
    font-size:15px;
    line-height:1.7;
  "
>
  Stripe successfully processed the cleaning
  payment and the booking has been updated
  to CHARGED.
</p>


<div
  style="
    margin-top:28px;
    padding:24px;
    background:#eef2ed;
    border-radius:18px;
  "
>

<div
  style="
    color:#69756f;
    font-size:10px;
    font-weight:700;
    letter-spacing:1.5px;
    text-transform:uppercase;
  "
>
  Amount Paid
</div>

<div
  style="
    margin-top:7px;
    color:#17352b;
    font-family:Georgia,serif;
    font-size:30px;
  "
>
  ${escapeHtml(amountFormatted)}
</div>

</div>


<table
  role="presentation"
  width="100%"
  cellspacing="0"
  cellpadding="0"
  border="0"
  style="
    margin-top:24px;
    border-collapse:collapse;
  "
>

<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Quote
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${escapeHtml(quoteNumber)}
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Customer
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${escapeHtml(customerName)}
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Email
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${escapeHtml(customerEmail)}
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Phone
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${escapeHtml(customerPhone)}
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Service
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${escapeHtml(service)}
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Payment Status
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#17352b;
    font-size:13px;
    font-weight:700;
  "
>
  SUCCEEDED
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#69756f;
    font-size:13px;
  "
>
  Booking Status
</td>

<td
  align="right"
  style="
    padding:12px 0;
    border-bottom:1px solid #e5e8e3;
    color:#17352b;
    font-size:13px;
    font-weight:700;
  "
>
  CHARGED
</td>

</tr>


<tr>

<td
  style="
    padding:12px 0;
    color:#69756f;
    font-size:13px;
  "
>
  Customer Receipt
</td>

<td
  align="right"
  style="
    padding:12px 0;
    color:#1c2823;
    font-size:13px;
    font-weight:700;
  "
>
  ${
    paymentEmailSent
      ? "Sent successfully"
      : "Not sent or failed"
  }
</td>

</tr>

</table>


<div
  style="
    margin-top:26px;
    padding:18px;
    background:#f7f5ef;
    border:1px solid #e5e8e3;
    border-radius:15px;
  "
>

<div
  style="
    color:#69756f;
    font-size:11px;
    text-transform:uppercase;
    letter-spacing:1.4px;
    margin-bottom:7px;
  "
>
  Stripe PaymentIntent
</div>

<div
  style="
    color:#17352b;
    font-size:13px;
    line-height:1.6;
    word-break:break-all;
  "
>
  ${escapeHtml(paymentIntent.id)}
</div>

</div>

</td>
</tr>


<tr>

<td
  style="
    padding:22px 36px;
    background:#f7f5ef;
    border-top:1px solid #e5e8e3;
    color:#718079;
    font-size:12px;
    line-height:1.6;
  "
>
  The Fresh Standard Co.<br>
  Payment processing notification.
</td>

</tr>

</table>

</td>
</tr>

</table>

</body>
</html>
      `.trim();


      const ownerResponse =
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
                  "thefreshstandardco@outlook.com"
                ],

                subject:
                  `Payment Received — ${quoteNumber}`,

                text:
                  ownerText,

                html:
                  ownerHtml
              })
          }
        );


      ownerPaymentEmailSent =
        ownerResponse.ok;


      if (!ownerResponse.ok) {

        const ownerError =
          await ownerResponse
            .text()
            .catch(() => "");


        console.error(
          "Owner payment notification failed:",
          ownerResponse.status,
          ownerError
        );
      }

    } catch (ownerEmailError) {

      console.error(
        "Owner payment notification error:",
        ownerEmailError
      );
    }
  }


  /*
    FINAL SUCCESS RESPONSE
  */

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
      (
        amount / 100
      ).toLocaleString(
        "en-US",
        {
          style:
            "currency",

          currency:
            "USD"
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
      paymentEmailSent,

    owner_payment_email_sent:
      ownerPaymentEmailSent
  });
};
