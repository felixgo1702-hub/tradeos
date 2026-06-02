const allowedHosts = new Set([
  "push2.eastmoney.com",
  "push2his.eastmoney.com",
  "web.ifzq.gtimg.cn",
  "qt.gtimg.cn",
  "vip.stock.finance.sina.com.cn",
  "money.finance.sina.com.cn",
]);

export default async function handler(request, response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  try {
    const target = request.query?.url;
    if (!target) {
      response.status(400).json({ error: "missing url" });
      return;
    }

    const parsed = new URL(target);
    if (!allowedHosts.has(parsed.hostname)) {
      response.status(400).json({ error: "target not allowed" });
      return;
    }

    const upstream = await fetch(target, {
      headers: {
        "user-agent": "Mozilla/5.0",
        referer: "https://finance.sina.com.cn/",
      },
    });

    const body = await upstream.text();
    response.setHeader(
      "content-type",
      upstream.headers.get("content-type") || "application/json; charset=utf-8",
    );
    response.setHeader("cache-control", "s-maxage=15, stale-while-revalidate=30");
    response.status(upstream.status).send(body);
  } catch (error) {
    response.status(500).json({ error: "proxy failed" });
  }
}
