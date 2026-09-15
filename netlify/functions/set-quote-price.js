function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}


export default async (request) => {

  /*
    Only POST requests are allowed.
  */

  if (request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Method not allowed"
      },
      405
    );
  }


  /*
    ADMIN AUTHENTICATION
  */

  const adminPassword =
    process.env.ADMIN_PASSWORD;


  const suppliedPassword =
    String(
      request.headers.get(
        "x-admin-password"
      ) || ""
    );


  if (!adminPassword) {
    return json(
      {
        ok: false,
        error:
          "Admin authentication is not configured."
      },
      500
    );
  }


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
    DATABASE CONFIGURATION
  */

  const supabaseUrl =
    process.env.SUPABASE_URL;


  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY;


  if (
    !supabaseUrl ||
    !serviceRoleKey
  ) {
    return json(
      {
        ok: false,
        error:
          "Database environment variables are missing."
      },
      500
    );
  }


  /*
    READ REQUEST
  */

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


  const quoteId =
    String(
      body.quote_id || ""
    ).trim();


  const price =
    Number(body.price);


  if (!quoteId) {
    return json(
      {
        ok: false,
        error: "Quote ID is required."
      },
      400
    );
  }


  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    price > 100000
  ) {
    return json(
      {
        ok: false,
        error:
          "Enter a valid quote price."
      },
      400
    );
  }


  /*
    Convert dollars to cents.

    Example:
    $159.00 → 15900
  */

  const quotedPrice =
    Math.round(price * 100);


  const baseUrl =
    supabaseUrl.replace(/\/$/, "");


  const endpoint =
    `${baseUrl}` +
    `/rest/v1/quotes?id=eq.${encodeURIComponent(
      quoteId
    )}`;


  /*
    STEP 1:
    GET THE CURRENT QUOTE FIRST.

    We do this BEFORE changing the price.

    This is what prevents someone from
    bypassing the dashboard and changing
    an already accepted price.
  */

  let existingRes;


  try {

    existingRes =
      await fetch(
        `${endpoint}&select=*`,
        {
          method: "GET",

          headers: {
            apikey:
              serviceRoleKey,

            Authorization:
              `Bearer ${serviceRoleKey}`,

            "content-type":
              "application/json"
          }
        }
      );

  } catch (error) {

    return json(
      {
        ok: false,
        error:
          "Could not connect to database.",

        detail:
          error?.message || null
      },
      500
    );
  }


  const existingData =
    await existingRes
      .json()
      .catch(() => null);


  if (!existingRes.ok) {

    return json(
      {
        ok: false,

        error:
          existingData?.message ||
          existingData?.error ||
          "Could not retrieve quote."
      },
      500
    );
  }


  const existingQuote =
    Array.isArray(existingData)
      ? existingData[0]
      : existingData;


  if (!existingQuote) {

    return json(
      {
        ok: false,
        error: "Quote not found."
      },
      404
    );
  }


  /*
    PRICE LOCK

    ONLY these statuses may have
    their quote price changed:

    new
    quoted

    Everything after acceptance
    is locked.
  */

  const editableStatuses = [
    "new",
    "quoted"
  ];


  if (
    !editableStatuses.includes(
      existingQuote.status
    )
  ) {

    return json(
      {
        ok: false,

        error:
          "This quote is locked and the agreed price can no longer be changed.",

        status:
          existingQuote.status
      },
      409
    );
  }


  /*
    PRESERVE EXISTING OFFER TOKEN.

    If this quote already has a customer
    offer link, keep that same link.

    Only create a new token if the quote
    does not have one yet.
  */

  const quoteToken =
    existingQuote.quote_token ||
    crypto.randomUUID();


  /*
    STEP 2:
    UPDATE THE QUOTE
  */

  let dbRes;


  try {

    dbRes =
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
            JSON.stringify({
              quoted_price:
                quotedPrice,

              quote_token:
                quoteToken,

              quote_sent_at:
                new Date().toISOString(),

              status:
                "quoted"
            })
        }
      );

  } catch (error) {

    return json(
      {
        ok: false,

        error:
          "Could not connect to database.",

        detail:
          error?.message || null
      },
      500
    );
  }


  const dbData =
    await dbRes
      .json()
      .catch(() => null);


  if (!dbRes.ok) {

    return json(
      {
        ok: false,

        error:
          dbData?.message ||
          dbData?.error ||
          "Could not update quote."
      },
      500
    );
  }


  const quote =
    Array.isArray(dbData)
      ? dbData[0]
      : dbData;


  if (!quote) {

    return json(
      {
        ok: false,
        error: "Quote not found."
      },
      404
    );
  }


  /*
    SUCCESS
  */

  return json({
    ok: true,

    quote_id:
      quote.id,

    quote_number:
      quote.quote_number,

    quoted_price:
      quote.quoted_price,

    quote_token:
      quote.quote_token,

    offer_url:
      `https://thefreshstandardco.com/offer/?token=` +
      encodeURIComponent(
        quote.quote_token
      )
  });
};
