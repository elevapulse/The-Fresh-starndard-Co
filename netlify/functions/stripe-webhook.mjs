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
  VERIFY STRIPE WEBHOOK SIGNATURE
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
  STRIPE GET
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
  GET QUOTE
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
  UPDATE QUOTE
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
  EMAIL HELPERS
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


async function sendResendEmail({
  apiKey,
  from,
  to,
  subject,
  text,
  html
}) {
  if (
    !apiKey ||
    !from ||
    !to
  ) {
    return {
      ok: false,
      skipped: true
    };
  }

  const response =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${apiKey}`,

          "content-type":
            "application/json"
        },

        body:
          JSON.stringify({
            from,
            to: Array.isArray(to)
              ? to
              : [to],
            subject,
            text,
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
  BOOKING CONFIRMATION EMAIL
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

  return await sendResendEmail({
    apiKey:
      resendApiKey,

    from:
      fromEmail,

    to: [
      customerEmail
    ],

    subject,

    text:
      plainText,

    html
  });
}


/*
  RECOVERY PAYMENT CUSTOMER EMAIL
*/

async function sendRecoveryPaymentConfirmation(
  quote,
  paymentIntent,
  resendApiKey,
  fromEmail
) {
  const customerEmail =
    String(
      quote?.customer_email || ""
    ).trim();

  if (
    !resendApiKey ||
    !fromEmail ||
    !customerEmail
  ) {
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
    quote?.id ||
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

  const text = [
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
<strong style="color:#17352b;">Amount Paid:</strong>
${escapeHtml(amount)}
</p>

<p style="margin:8px 0;font-size:15px;color:#64716b;">
<strong style="color:#17352b;">Payment Reference:</strong>
${escapeHtml(paymentReference)}
</p>

</div>

<div style="background:#f7f7f2;border:1px solid #e1e5de;border-radius:16px;padding:20px;margin-bottom:28px;">

<div style="font-family:Georgia,'Times New Roman',serif;font-size:18px;margin-bottom:8px;color:#17352b;">
Payment received
</div>

<p style="font-size:14px;line-height:1.65;color:#69736e;margin:0;">
Your secure payment was processed through Stripe.
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

  return await sendResendEmail({
    apiKey:
      resendApiKey,

    from:
      fromEmail,

    to: [
      customerEmail
    ],

    subject,

    text,

    html
  });
}


/*
  RECOVERY PAYMENT OWNER EMAIL
*/

async function sendRecoveryOwnerNotification(
  quote,
  paymentIntent,
  customerEmailSent,
  resendApiKey,
  fromEmail
) {
  if (
    !resendApiKey ||
    !fromEmail
  ) {
    return {
      ok: false,
      skipped: true
    };
  }

  const quoteNumber =
    quote?.quote_number ||
    quote?.id ||
    "—";

  const customerName =
    quote?.customer_name ||
    "";

  const customerEmail =
    quote?.customer_email ||
    "";

  const customerPhone =
    quote?.customer_phone ||
    "";

  const service =
    quote?.service_type ||
    "Cleaning Service";

  const amount =
    formatUsd(
      quote?.quoted_price
    ) || "—";

  const paymentReference =
    paymentIntent?.id ||
    "—";

  const text = [
    "A recovery payment has been completed successfully.",
    "",
    `Quote: ${quoteNumber}`,
    `Customer: ${customerName}`,
    `Email: ${customerEmail}`,
    `Phone: ${customerPhone}`,
    `Service: ${service}`,
    `Amount Paid: ${amount}`,
    "",
    `Stripe PaymentIntent: ${paymentReference}`,
    `Stripe Status: ${paymentIntent?.status || "succeeded"}`,
    "Booking Status: CHARGED",
    "Payment Type: RECOVERY",
    "",
    customerEmailSent
      ? "Customer payment confirmation email: Sent successfully."
      : "Customer payment confirmation email: Not sent or failed."
  ].join("\n");

  const html = `
<!doctype html>
<html lang="en">

<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>

<body style="margin:0;padding:0;background:#f4f1e9;font-family:Arial,Helvetica,sans-serif;color:#1c2823;">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
style="width:100%;background:#f4f1e9;padding:36px 16px;">

<tr>
<td align="center">

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
style="width:100%;max-width:620px;background:#fffdf8;border-radius:24px;overflow:hidden;border:1px solid #dce2dc;">

<tr>
<td style="background:#17352b;padding:30px 34px;color:#ffffff;">

<div style="font-family:Georgia,serif;font-size:23px;letter-spacing:2px;">
THE FRESH
</div>

<div style="margin-top:4px;color:#c8d3cc;font-size:11px;letter-spacing:3px;text-transform:uppercase;">
Standard Co.
</div>

</td>
</tr>

<tr>
<td style="padding:42px 36px;">

<div style="color:#718679;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">
Recovery Payment Successful
</div>

<h1 style="margin:0;color:#17352b;font-family:Georgia,serif;font-size:34px;font-weight:400;line-height:1.2;">
Customer payment received.
</h1>

<p style="margin:18px 0 0;color:#69756f;font-size:15px;line-height:1.7;">
The customer completed the secure recovery payment through Stripe Checkout.
The booking has been updated to CHARGED.
</p>

<div style="margin-top:28px;padding:24px;background:#eef2ed;border-radius:18px;">

<div style="color:#69756f;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">
Amount Paid
</div>

<div style="margin-top:7px;color:#17352b;font-family:Georgia,serif;font-size:30px;">
${escapeHtml(amount)}
</div>

</div>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
style="margin-top:24px;border-collapse:collapse;">

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Quote
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#1c2823;font-size:13px;font-weight:700;">
${escapeHtml(quoteNumber)}
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Customer
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#1c2823;font-size:13px;font-weight:700;">
${escapeHtml(customerName)}
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Email
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#1c2823;font-size:13px;font-weight:700;">
${escapeHtml(customerEmail)}
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Phone
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#1c2823;font-size:13px;font-weight:700;">
${escapeHtml(customerPhone)}
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Service
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#1c2823;font-size:13px;font-weight:700;">
${escapeHtml(service)}
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Payment Type
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#17352b;font-size:13px;font-weight:700;">
RECOVERY
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Payment Status
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#17352b;font-size:13px;font-weight:700;">
SUCCEEDED
</td>
</tr>

<tr>
<td style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#69756f;font-size:13px;">
Booking Status
</td>

<td align="right" style="padding:12px 0;border-bottom:1px solid #e5e8e3;color:#17352b;font-size:13px;font-weight:700;">
CHARGED
</td>
</tr>

<tr>
<td style="padding:12px 0;color:#69756f;font-size:13px;">
Customer Receipt
</td>

<td align="right" style="padding:12px 0;color:#1c2823;font-size:13px;font-weight:700;">
${
  customerEmailSent
    ? "Sent successfully"
    : "Not sent or failed"
}
</td>
</tr>

</table>

<div style="margin-top:26px;padding:18px;background:#f7f5ef;border:1px solid #e5e8e3;border-radius:15px;">

<div style="color:#69756f;font-size:11px;text-transform:uppercase;letter-spacing:1.4px;margin-bottom:7px;">
Stripe PaymentIntent
</div>

<div style="color:#17352b;font-size:13px;line-height:1.6;word-break:break-all;">
${escapeHtml(paymentReference)}
</div>

</div>

</td>
</tr>

<tr>
<td style="padding:22px 36px;background:#f7f5ef;border-top:1px solid #e5e8e3;color:#718079;font-size:12px;line-height:1.6;">
The Fresh Standard Co.<br>
Recovery payment notification.
</td>
</tr>

</table>

</td>
</tr>

</table>

</body>
</html>
  `.trim();

  return await sendResendEmail({
    apiKey:
      resendApiKey,

    from:
      fromEmail,

    to: [
      "thefreshstandardco@outlook.com"
    ],

    subject:
      `Recovery Payment Received — ${quoteNumber}`,

    text,

    html
  });
}


/*
  MAIN NETLIFY FUNCTION
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
    SIGNATURE VERIFICATION MUST USE
    THE EXACT RAW REQUEST BODY
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
    WE CARE ABOUT COMPLETED
    CHECKOUT SESSIONS
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
          DUPLICATE SETUP PROTECTION
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
          SAVE STRIPE REFERENCES
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
          CUSTOMER BOOKING CONFIRMATION

          NON-FATAL
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

      Customer enters another payment method
      through Stripe Checkout after the
      original saved-card charge failed.
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
          RETRIEVE AUTHORITATIVE PAYMENTINTENT
        */

        const paymentIntent =
          await stripeGet(
            `payment_intents/${encodeURIComponent(paymentIntentId)}`,
            stripeSecretKey
          );


        /*
          RETRIEVE AUTHORITATIVE QUOTE
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
          EXACT DUPLICATE WEBHOOK

          DO NOT:
          - update again
          - resend customer receipt
          - resend owner notification
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
          QUOTE ALREADY PAID BY
          ANOTHER PAYMENTINTENT
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
          RECOVERY PAYMENT ONLY AFTER
          SERVICE COMPLETION
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
          CONFIRM STRIPE PAYMENT SUCCEEDED
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
          CONFIRM CORRECT STRIPE CUSTOMER
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
          CONFIRM EXACT SERVER-SIDE AMOUNT
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
          CONFIRM CURRENCY
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
          CONFIRM PAYMENTINTENT METADATA
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
          SAVE SUCCESSFULLY USED PAYMENT METHOD
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
          RECORD SUCCESSFUL RECOVERY PAYMENT
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


        /*
          CUSTOMER PAYMENT CONFIRMATION

          NON-FATAL.

          IMPORTANT:
          Database is already CHARGED before
          we attempt this email.
        */

        let customerEmailSent =
          false;


        try {

          const emailResult =
            await sendRecoveryPaymentConfirmation(
              updatedQuote || quote,
              paymentIntent,
              process.env.RESEND_API_KEY,
              process.env.FROM_EMAIL
            );


          customerEmailSent =
            !!emailResult?.ok;


          if (
            customerEmailSent
          ) {

            console.log(
              "Recovery payment confirmation email sent:",
              quoteId,
              emailResult?.email_id ||
                null
            );
          }

        } catch (emailError) {

          console.error(
            "Recovery customer payment email failed:",
            quoteId,
            emailError.message
          );
        }


        /*
          OWNER RECOVERY PAYMENT NOTIFICATION

          ALSO NON-FATAL.
        */

        let ownerEmailSent =
          false;


        try {

          const ownerEmailResult =
            await sendRecoveryOwnerNotification(
              updatedQuote || quote,
              paymentIntent,
              customerEmailSent,
              process.env.RESEND_API_KEY,
              process.env.FROM_EMAIL
            );


          ownerEmailSent =
            !!ownerEmailResult?.ok;


          if (
            ownerEmailSent
          ) {

            console.log(
              "Recovery owner notification sent:",
              quoteId,
              ownerEmailResult?.email_id ||
                null
            );
          }

        } catch (emailError) {

          console.error(
            "Recovery owner notification failed:",
            quoteId,
            emailError.message
          );
        }


        /*
          SUCCESS

          Email failures DO NOT make Stripe
          retry a payment that was successfully
          recorded.
        */

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
            paymentIntent.id,

          customer_email_sent:
            customerEmailSent,

          owner_email_sent:
            ownerEmailSent
        });


      } catch (error) {

        console.error(
          "Could not process recovery payment:",
          error.message
        );


        /*
          RETURN 500 SO STRIPE RETRIES
          DATABASE/VALIDATION FAILURES.

          WE NEVER CREATE A NEW CHARGE HERE.
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
      UNRELATED CHECKOUT SESSION
    */

    console.log(
      "Ignoring unrelated Checkout Session."
    );


    return json({
      received: true
    });
  }


  /*
    ACKNOWLEDGE OTHER STRIPE EVENTS
  */

  return json({
    received: true
  });
};
