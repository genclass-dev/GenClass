import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A small JSON API served by the same server as the app (dev and preview).
function api() {
  let orders = 0;
  let cart = 0;
  let notifications = 3;
  let profile = { name: "" };
  const items = {
    lamp: { id: "lamp", title: "Lamp", price: 39, stock: 12 },
    desk: { id: "desk", title: "Desk", price: 249, stock: 4 },
    chair: { id: "chair", title: "Chair", price: 129, stock: 9 },
  };
  const handler = async (req, res, next) => {
    const url = new URL(req.url, "http://local");
    if (!url.pathname.startsWith("/api/")) return next();
    const send = (obj, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    const raw = await new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
    const body = raw ? JSON.parse(raw) : {};
    await new Promise((r) => setTimeout(r, 15));
    const p = url.pathname;
    if (p === "/api/reset") { orders = 0; cart = 0; notifications = 3; profile = { name: "" }; return send({ ok: true }); }
    if (p === "/api/me") return send({ user: "demo" });
    if (p === "/api/notifications") { notifications += 1; return send({ count: notifications }); }
    if (p === "/api/search") { const q = url.searchParams.get("q") ?? ""; return send({ q, items: q ? [`${q} lamp`, `${q} desk`] : [] }); }
    if (p === "/api/orders" && req.method === "POST") { orders += 1; return send({ id: orders, total: orders }); }
    if (p.startsWith("/api/items/")) { const it = items[p.slice("/api/items/".length)]; return it ? send(it) : send({ error: "not found" }, 404); }
    if (p === "/api/profile" && req.method === "PUT") { profile = { name: String(body.name ?? "") }; return send({ name: profile.name, savedAt: Date.now() }); }
    if (p === "/api/cart" && req.method === "POST") { cart += Number(body.qty ?? 1); return send({ total: cart }); }
    return send({ error: "not found" }, 404);
  };
  return {
    name: "tiny-desk-api",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({ plugins: [react(), api()] });
