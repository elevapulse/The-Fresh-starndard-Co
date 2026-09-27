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
  Verify Stripe webhook signature.
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

  const eventTime =
    Number(timestamp);

  const currentTime =
    Math.floor(
      Date.now() / 1000
    );

  if (
    !Number.isFinite(eventTime) ||
    Math.abs(
      currentTime - eventTime
    ) > 300
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
  Retrieve quote from Supabase.
*/

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
      "Could not retrieve quote from Supabase."
    );
  }

  return Array.isArray(data)
    ? data[0]
    : null;
}


/*
  Update quote in Supabase.
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
  Email helpers.
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
  Send booking confirmation.

  IMPORTANT:
  Email failure must NOT cause Stripe
  to retry an otherwise successful
  card-saving webhook.
*/

async function sendBookingConfirmation(
  quote,
  resendApiKey,
  fromEmail
) {
  if (
    !resendApiKey ||
    !fromEmail
  ) {
    console.error(
      "Booking confirmation skipped: Resend configuration is incomplete."
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
      "Booking confirmation skipped: quote has no customer email."
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

  const price =
    formatUsd(
      quote?.quoted_price
    ) || "—";

  const subject =
    "Booking Confirmed — The Fresh Standard Co.";

  const plainText = [
    `Hi ${firstName},`,
    "",
    "Your cleaning booking with The Fresh Standard Co. has been confirmed.",
    "",
    `Quote: ${quoteNumber}`,
    `Service: ${service}`,
    `Property: ${property}`,
    `Quoted Price: ${price}`,
    "",
    "Your payment method has been securely saved through Stripe.",
    "",
    "You have not been charged at this time.",
    "",
    "After your cleaning service is completed, The Fresh Standard Co. will charge the agreed quoted amount to your saved payment method in accordance with the payment authorization you accepted when confirming your booking.",
    "",
    "If you have any questions or need to make changes to your booking, contact us:",
    "",
    "954-379-6765",
    "thefreshstandardco@outlook.com",
    "",
    "Thank you for choosing The Fresh Standard Co."
  ].join("\n");

  const html = `
<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f4f1e9;font-family:Arial,Helvetica,sans-serif;color:#17352b;">

<div style="max-width:620px;margin:0 auto;padding:40px 20px;">

<div style="background:#fffdf8;border-radius:24px;padding:42px;">

<div style="text-align:center;margin-bottom:34px;">

<div style="font-family:Georgia,'Times New Roman',serif;font-size:25px;letter-spacing:2px;font-weight:600;">
THE FRESH
</div>

<div style="margin-top:6px;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#758b78;">
Standard Co.
</div>

</div>

<div style="text-align:center;text-transform:uppercase;letter-spacing:3px;font-size:11px;font-weight:700;color:#758b78;margin-bottom:12px;">
Booking Confirmed
</div>

<h1 style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:400;text-align:center;margin:0 0 16px;color:#17352b;">
You're all set.
</h1>

<p style="font-size:16px;line-height:1.7;color:#64716b;text-align:center;margin:0 0 34px;">
Hi ${escapeHtml(firstName)}, your cleaning booking with
The Fresh Standard Co. has been confirmed.
</p>

<div style="border-top:1px solid #e6e5df;border-bottom:1px solid #e6e5df;padding:22px 0;margin-bottom:30px;">

<p style="margin:8px 0;font-size:15px;color:#64716b;">
<strong style="color:#17352b;">Quote:</strong>
${escapeHtml(quoteNumber)}
</p>

<p style="margin:8px 0;font-size:15px;color:#64716b;">
<strong style="color:#17352b;">Service:</strong>
${escapeHtml(service)}
</p>

<p style="margin:8px 0;font-size:15px;color:#64716b;">
<strong style="color:#17352b;">Property:</strong>
${escapeHtml(property)}
</p>

<p style="margin:8px 0;font-size:15px;color:#64716b;">
<strong style="color:#17352b;">Quoted Price:</strong>
${escapeHtml(price)}
</p>

</div>

<div style="background:#f7f7f2;border:1px solid #e1e5de;border-radius:16px;padding:20px;margin-bottom:28px;">

<div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;margin-bottom:8px;color:#17352b;">
Payment secured
</div>

<p style="font-size:14px;line-height:1.65;color:#69736e;margin:0;">
Your payment method has been securely saved through Stripe.
You have not been charged at this time. After your cleaning
service is completed, The Fresh Standard Co. will charge the
agreed quoted amount to your saved payment method in accordance
with the payment authorization you accepted when confirming
your booking.
</p>

</div>

<p style="font-size:14px;line-height:1.7;color:#69736e;text-align:center;margin:0;">
Need to make a change or have a question?<br>

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
  Main Netlify Function
*/

export default async (request) => {

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error:
          "Method not allowed"
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
    Signature verification MUST use
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
    We care about completed Checkout Sessions.
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
      ==================================================
      CARD-SAVING CHECKOUT
      ==================================================

      mode=setup

      Customer saves card.
      Customer is NOT charged here.
    */

    if (
      session.mode ===
      "setup"
    ) {

      const quoteId =
        session.metadata?.quote_id;

      if (!quoteId) {

        console.error(
          "Setup Checkout Session has no quote_id metadata."
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
          Retrieve SetupIntent.
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
          Retrieve current quote BEFORE changing it.

          Stripe can send the same webhook
          more than once.
        */

        const existingQuote =
          await getQuote(
            quoteId,
            supabaseUrl,
            serviceRoleKey
          );


        if (!existingQuote) {
          throw new Error(
            "Setup quote does not exist."
          );
        }


        /*
          Duplicate setup protection.

          If this exact Checkout Session was
          already processed, acknowledge it.

          Do NOT:
          - rewrite card_saved_at
          - resend confirmation email
        */

        if (
          (
            existingQuote.status ===
              "card_saved" ||

            existingQuote.status ===
              "booked" ||

            existingQuote.status ===
              "completed" ||

            existingQuote.status ===
              "charged"
          ) &&

          existingQuote
            .stripe_setup_session_id ===
              session.id
        ) {

          console.log(
            "Card setup already processed:",
            quoteId,
            session.id
          );


          return json({
            received: true,

            processed: true,

            already_processed: true,

            payment_type:
              "card_setup",

            quote_id:
              quoteId,

            status:
              existingQuote.status
          });
        }


        /*
          Save Stripe references.
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
                new Date()
                  .toISOString(),

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


        /*
          Send customer confirmation.

          IMPORTANT:
          This is NON-FATAL.

          If Resend fails, the card was still
          saved correctly and Stripe receives
          a successful webhook response.
        */

        let confirmationEmailSent =
          false;


        try {

          const emailResult =
            await sendBookingConfirmation(
              updatedQuote,
              process.env.RESEND_API_KEY,
              process.env.FROM_EMAIL
            );


          confirmationEmailSent =
            !!emailResult?.ok;


          if (
            confirmationEmailSent
          ) {

            console.log(
              "Booking confirmation email sent:",
              quoteId,
              emailResult?.email_id ||
                null
            );
          }

        } catch (emailError) {

          console.error(
            "Booking confirmation email failed:",
            quoteId,
            emailError.message
          );
        }


        return json({
          received: true,

          processed: true,

          payment_type:
            "card_setup",

          quote_id:
            quoteId,

          status:
            updatedQuote?.status ||
            "card_saved",

          confirmation_email_sent:
            confirmationEmailSent
        });


      } catch (error) {

        console.error(
          "Could not process completed setup Checkout Session:",
          error.message
        );


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
      ==================================================
      RECOVERY PAYMENT CHECKOUT
      ==================================================

      This is the payment page used when
      the original saved-card charge failed.

      Customer enters another payment method
      through Stripe Checkout.
    */

    if (
      session.mode ===
        "payment" &&

      session.metadata
        ?.payment_type ===
        "recovery"
    ) {

      const quoteId =
        session.metadata?.quote_id;


      if (!quoteId) {

        console.error(
          "Recovery Checkout Session has no quote_id metadata."
        );


        return json(
          {
            received: false,

            error:
              "Missing recovery quote metadata."
          },
          400
        );
      }


      const paymentIntentId =
        session.payment_intent;


      if (!paymentIntentId) {

        console.error(
          "Recovery Checkout Session has no PaymentIntent."
        );


        return json(
          {
            received: false,

            error:
              "Missing recovery PaymentIntent."
          },
          400
        );
      }


      try {

        /*
          Retrieve authoritative PaymentIntent.
        */

        const paymentIntent =
          await stripeGet(
            `payment_intents/${encodeURIComponent(paymentIntentId)}`,
            stripeSecretKey
          );


        /*
          Retrieve authoritative quote.
        */

        const quote =
          await getQuote(
            quoteId,
            supabaseUrl,
            serviceRoleKey
          );


        if (!quote) {
          throw new Error(
            "Recovery quote does not exist."
          );
        }


        /*
          Exact duplicate webhook.

          Same quote.
          Same successful PaymentIntent.
          Already recorded as charged.
        */

        if (
          quote.status ===
            "charged" &&

          quote
            .stripe_payment_intent_id ===
            paymentIntent.id
        ) {

          console.log(
            "Recovery payment already processed:",
            quoteId,
            paymentIntent.id
          );


          return json({
            received: true,

            processed: true,

            already_processed: true,

            payment_type:
              "recovery",

            quote_id:
              quoteId,

            status:
              "charged",

            payment_intent_id:
              paymentIntent.id
          });
        }


        /*
          Quote already paid by a different
          PaymentIntent.

          Never overwrite it.
        */

        if (
          quote.status ===
          "charged"
        ) {

          console.error(
            "Quote is already charged by another payment:",
            quoteId
          );


          return json({
            received: true,

            processed: false,

            already_paid: true,

            payment_type:
              "recovery",

            quote_id:
              quoteId,

            status:
              "charged"
          });
        }


        /*
          Recovery should only complete
          after service completion.
        */

        if (
          quote.status !==
          "completed"
        ) {

          throw new Error(
            `Recovery payment cannot be applied while quote status is "${quote.status}".`
          );
        }


        /*
          Confirm Stripe says the payment
          actually succeeded.
        */

        if (
          paymentIntent.status !==
          "succeeded"
        ) {

          throw new Error(
            `Recovery PaymentIntent status is "${paymentIntent.status}", not "succeeded".`
          );
        }


        /*
          Confirm payment belongs to the
          correct Stripe customer.
        */

        const expectedCustomer =
          String(
            quote.stripe_customer_id ||
            ""
          ).trim();


        const actualCustomer =
          String(
            paymentIntent.customer ||
            session.customer ||
            ""
          ).trim();


        if (
          !expectedCustomer ||
          !actualCustomer ||
          expectedCustomer !==
            actualCustomer
        ) {

          throw new Error(
            "Recovery payment customer does not match quote customer."
          );
        }


        /*
          Confirm amount matches the
          server-side quote exactly.
        */

        const expectedAmount =
          Number(
            quote.quoted_price
          );


        const paidAmount =
          Number(
            paymentIntent
              .amount_received
          );


        if (
          !Number.isInteger(
            expectedAmount
          ) ||
          expectedAmount <= 0
        ) {

          throw new Error(
            "Quote has an invalid payment amount."
          );
        }


        if (
          !Number.isInteger(
            paidAmount
          ) ||
          paidAmount !==
            expectedAmount
        ) {

          throw new Error(
            `Recovery payment amount mismatch. Expected ${expectedAmount}, received ${paidAmount}.`
          );
        }


        /*
          Confirm currency.
        */

        if (
          String(
            paymentIntent.currency ||
            ""
          ).toLowerCase() !==
          "usd"
        ) {

          throw new Error(
            "Recovery payment currency is not USD."
          );
        }


        /*
          Confirm PaymentIntent metadata.
        */

        if (
          paymentIntent.metadata
            ?.quote_id !==
          quoteId
        ) {

          throw new Error(
            "Recovery PaymentIntent quote metadata does not match."
          );
        }


        if (
          paymentIntent.metadata
            ?.payment_type !==
          "recovery"
        ) {

          throw new Error(
            "Recovery PaymentIntent type metadata does not match."
          );
        }


        /*
          Stripe Checkout can save the
          newly used payment method.

          If available, replace the old
          saved payment method so future
          authorized charges use the
          successful method.
        */

        const successfulPaymentMethodId =
          paymentIntent
            .payment_method ||
          null;


        const updateValues = {
          stripe_payment_intent_id:
            paymentIntent.id,

          charged_at:
            new Date()
              .toISOString(),

          status:
            "charged"
        };


        if (
          successfulPaymentMethodId
        ) {

          updateValues
            .stripe_payment_method_id =
              successfulPaymentMethodId;
        }


        /*
          Record successful recovery payment.
        */

        const updatedQuote =
          await updateQuote(
            quoteId,
            updateValues,
            supabaseUrl,
            serviceRoleKey
          );


        console.log(
          "Recovery payment recorded successfully:",
          quoteId,
          paymentIntent.id
        );


        return json({
          received: true,

          processed: true,

          payment_type:
            "recovery",

          quote_id:
            quoteId,

          status:
            updatedQuote?.status ||
            "charged",

          payment_intent_id:
            paymentIntent.id
        });


      } catch (error) {

        console.error(
          "Could not process recovery payment:",
          error.message
        );


        /*
          Return 500 so Stripe retries.

          IMPORTANT:
          Stripe may already have received
          the customer's money at this point.

          We NEVER create another charge
          from inside this webhook.
        */

        return json(
          {
            received: false,

            error:
              "Could not record recovery payment.",

            detail:
              error.message
          },
          500
        );
      }
    }


    /*
      Checkout completed, but it was neither
      our setup flow nor our recovery flow.
    */

    console.log(
      "Ignoring unrelated Checkout Session."
    );


    return json({
      received: true
    });
  }


  /*
    Other Stripe events can safely
    be acknowledged.
  */

  return json({
    received: true
  });
};
