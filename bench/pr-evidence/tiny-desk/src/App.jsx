import { useEffect, useRef, useState } from "react";

const params = new URLSearchParams(location.search);
const fixed = params.get("v") === "fixed";
const widget = params.get("w") ?? "search";
const json = { "content-type": "application/json" };

// ---- shell: on every page -------------------------------------------------

function useMe() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then((d) => setUser(d.user));
  }, []);
  return user;
}

function Header() {
  const user = useMe();
  return <header data-testid="header">Tiny Desk {user ? `· signed in as ${user}` : ""}</header>;
}

function Sidebar() {
  const user = useMe();
  return <aside data-testid="sidebar">{user ? `Account: ${user}` : "…"}</aside>;
}

// plain polling, as most apps write it: no guard on the order of answers
function Notifications() {
  const [count, setCount] = useState(null);
  useEffect(() => {
    const tick = async () => {
      const r = await fetch("/api/notifications");
      const d = await r.json();
      setCount(d.count);
    };
    tick();
    const t = setInterval(tick, 400);
    return () => clearInterval(t);
  }, []);
  return <span data-testid="badge">{count === null ? "" : `${count} notifications`}</span>;
}

// ---- widgets ---------------------------------------------------------------

function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const ctl = useRef(null);
  async function onChange(e) {
    const value = e.target.value;
    setQ(value);
    if (fixed) {
      ctl.current?.abort();
      const c = (ctl.current = new AbortController());
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(value)}`, { signal: c.signal });
        const d = await r.json();
        if (!c.signal.aborted) setResults(d.items);
      } catch {
        /* superseded */
      }
      return;
    }
    const r = await fetch(`/api/search?q=${encodeURIComponent(value)}`);
    const d = await r.json();
    setResults(d.items); // whichever answer lands last wins
  }
  return (
    <section>
      <label>
        Search <input value={q} onChange={onChange} />
      </label>
      <ul data-testid="results">
        {results.map((x) => (
          <li key={x}>
            <button onClick={() => setPicked(x)}>{x}</button>
          </li>
        ))}
      </ul>
      <p data-testid="picked">{picked ? `Picked: ${picked}` : ""}</p>
    </section>
  );
}

function Checkout() {
  const [status, setStatus] = useState("idle");
  const [total, setTotal] = useState(0);
  const busy = useRef(false);
  async function place() {
    if (fixed && busy.current) return;
    busy.current = true;
    setStatus("pending");
    const r = await fetch("/api/orders", { method: "POST", headers: json, body: JSON.stringify({ sku: "desk", qty: 1 }) });
    const d = await r.json();
    setTotal(d.total);
    setStatus("done");
    busy.current = false;
  }
  return (
    <section>
      <button onClick={place} disabled={fixed && status === "pending"}>Place order</button>
      <p data-testid="order-status">{status === "done" ? "Order placed" : status === "pending" ? "Placing…" : ""}</p>
      <p data-testid="order-total">{total ? `Orders on file: ${total}` : ""}</p>
    </section>
  );
}

function Detail() {
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const current = useRef(null);
  async function pick(id) {
    setSelected(id);
    current.current = id;
    const r = await fetch(`/api/items/${id}`);
    const d = await r.json();
    if (fixed && current.current !== id) return;
    setDetail(d); // the answer for an item the user already left can land last
  }
  return (
    <section>
      {["lamp", "desk", "chair"].map((id) => (
        <button key={id} onClick={() => pick(id)} aria-pressed={selected === id}>{id}</button>
      ))}
      <h2 data-testid="detail-title">{detail ? detail.title : ""}</h2>
      <p data-testid="detail-price">{detail ? `$${detail.price}` : ""}</p>
    </section>
  );
}

function Profile() {
  const [name, setName] = useState("");
  const [savedAt, setSavedAt] = useState(null);
  const seq = useRef(0);
  async function onChange(e) {
    const value = e.target.value;
    setName(value);
    const mine = ++seq.current;
    const r = await fetch("/api/profile", { method: "PUT", headers: json, body: JSON.stringify({ name: value }) });
    const d = await r.json();
    if (fixed) {
      if (mine === seq.current) setSavedAt(d.savedAt);
      return;
    }
    setName(d.name); // the server's echo replaces what was typed since
    setSavedAt(d.savedAt);
  }
  return (
    <section>
      <label>
        Display name <input value={name} onChange={onChange} />
      </label>
      <p data-testid="saved">{savedAt ? "Saved" : ""}</p>
    </section>
  );
}

// two clicks mean two items: both requests are wanted, and each success adds one
function Cart() {
  const [count, setCount] = useState(0);
  async function add() {
    await fetch("/api/cart", { method: "POST", headers: json, body: JSON.stringify({ sku: "lamp", qty: 1 }) });
    setCount((c) => c + 1);
  }
  return (
    <section>
      <button onClick={add}>Add to cart</button>
      <p data-testid="cart">{count} in cart</p>
    </section>
  );
}

const widgets = { search: Search, checkout: Checkout, detail: Detail, profile: Profile, cart: Cart };

export function App() {
  const Widget = widgets[widget] ?? Search;
  return (
    <>
      <Header />
      <Sidebar />
      <Notifications />
      <main>
        <Widget />
      </main>
    </>
  );
}
