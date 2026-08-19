// Vercel serverless funkce — proxy endpoint pro volání externích API
// s klíči, které nesmí být viditelné ve frontend kódu (např. AI API).
//
// Použití z frontendu: fetch('/api/index')

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const API_KEY = process.env.SECRET_API_KEY;
  if (!API_KEY) {
    res.status(500).json({ error: "SECRET_API_KEY není nastaven na serveru" });
    return;
  }

  try {
    // Příklad: přepošli požadavek na externí službu a vrať odpověď.
    // Uprav podle konkrétního API, které budeš používat.
    const { payload } = req.body;

    // const response = await fetch("https://external-api.example.com/endpoint", {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json",
    //     Authorization: `Bearer ${API_KEY}`,
    //   },
    //   body: JSON.stringify(payload),
    // });
    // const data = await response.json();

    res.status(200).json({ ok: true, received: payload ?? null });
  } catch (err) {
    console.error("API proxy error:", err);
    res.status(500).json({ error: "Interní chyba serveru" });
  }
}
