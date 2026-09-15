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
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return json({
      ok: false,
      error: "Admin authentication is not configured."
    }, 500);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid request." }, 400);
  }

  const password = String(body.password || "");

  if (!password || password !== adminPassword) {
    return json({
      ok: false,
      error: "Incorrect password."
    }, 401);
  }

  return json({
    ok: true
  });
};
