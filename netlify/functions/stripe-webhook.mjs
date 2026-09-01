import crypto from "node:crypto";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function verifyStripeSignature(payload, sigHeader, secret, tolerance = 300) {
  if (!sigHeader || !secret) return false;

  const parts = Object.fromEntries(
    sigHeader.split(",").map(part => {
      const i = part.indexOf("=");
      return [part.slice(0, i), part.slice(i + 1)];
    })
  );

  const timestamp = Number(parts.t);
  const signature = parts.v1;

  if (!timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async (request) => {
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ ok: false, error: "Missing STRIPE_WEBHOOK_SECRET" }, 500);

  const payload = await request.text();
  const sig = request.headers.get("stripe-signature");

  if (!verifyStripeSignature(payload, sig, secret)) {
    return json({ ok: false, error: "Invalid Stripe signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ ok: false, error: "Invalid JSON payload" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;
    console.log("Stripe setup completed", {
      session_id: session?.id,
      quote_id: session?.client_reference_id || session?.metadata?.quote_id,
      customer: session?.customer,
      setup_intent: session?.setup_intent
    });
  }

  return json({ received: true });
};