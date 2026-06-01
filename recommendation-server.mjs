import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://localhost:${port}`);

    if (url.pathname === "/api/proxy") {
      const target = url.searchParams.get("url");
      const targetHost = target ? new URL(target).hostname : "";
      const allowedHosts = new Set([
        "push2.eastmoney.com",
        "push2his.eastmoney.com",
        "web.ifzq.gtimg.cn",
        "qt.gtimg.cn",
        "vip.stock.finance.sina.com.cn",
        "money.finance.sina.com.cn",
      ]);
      if (!target || !allowedHosts.has(targetHost)) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "bad target" }));
        return;
      }

      const upstream = await fetch(target, {
        headers: {
          "user-agent": "Mozilla/5.0",
          referer: "https://finance.sina.com.cn/",
        },
      });
      const body = await upstream.text();
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      });
      response.end(body);
      return;
    }

    const pathname = url.pathname === "/" ? "/review-dashboard.html" : url.pathname;
    const filepath = normalize(join(root, decodeURIComponent(pathname)));
    if (!filepath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const body = await readFile(filepath);
    response.writeHead(200, { "content-type": types[extname(filepath)] || "text/plain" });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, () => {
  console.log(`短线推荐页面已启动：http://localhost:${port}/review-dashboard.html#recommend`);
});
