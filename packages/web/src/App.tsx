import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  Globe2,
  LayoutDashboard,
  LineChart,
  LogIn,
  LogOut,
  Menu,
  RefreshCw,
  Search,
  Settings2,
  Star,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Quote = {
  symbol: string;
  name: string;
  type: "stock" | "index" | "currency";
  exchange: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  marketOpen: boolean | null;
  updatedAt: string | null;
};

type Health = {
  status: string;
  provider: string;
  lastRefreshAt: string | null;
  lastRefreshError: string | null;
  refreshing: boolean;
  refreshIntervalMs: number;
};

type Point = { price: number; capturedAt: string };
type Tab = "Overview" | "Equities" | "Currencies" | "Portfolio" | "Orders" | "Analytics";
type PortfolioData = { mode: string; cash: string; availableCash: string; marketValue: string; totalValue: string; unrealizedPnl: string; holdings: Array<{ symbol: string; quantity: string; averagePrice: string; currentPrice: string | null; marketValue: string | null; unrealizedPnl: string | null }> };
type Order = { id: string; symbol: string; side: string; quantity: string; status: string; averagePrice: string | null; reason: string | null; createdAt?: string };
type Notice = { id: number; type: string; message: string; readAt: string | null; createdAt: string };
const currencySymbol: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "C$", CHF: "Fr", INR: "₹",
};

function formatPrice(value: number | null, currency = "USD") {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatQuotePrice(quote: Quote | undefined) {
  if (!quote || quote.price === null) return "—";
  if (quote.type === "currency") return quote.price.toFixed(quote.price < 10 ? 4 : 2);
  return formatPrice(quote.price);
}

function formatChange(value: number | null) {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function shortTime(value: string | null) {
  if (!value) return "Awaiting first sync";
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function App() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState("AAPL");
  const [history, setHistory] = useState<Point[]>([]);
  const [range, setRange] = useState("1D");
  const [tab, setTab] = useState<Tab>("Overview");
  const [query, setQuery] = useState("");
  const [currencyQuery, setCurrencyQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [profile, setProfile] = useState<{ email: string; displayName?: string } | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [transactions, setTransactions] = useState<Array<{ orderId: string; symbol: string; side: string; quantity: string; price: string; total: string; createdAt: string }>>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [notifications, setNotifications] = useState<Notice[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [analytics, setAnalytics] = useState<{ counts: Array<{ eventType: string; total: number }> } | null>(null);
  const [orderQuantity, setOrderQuantity] = useState("1");
  const [orderSide, setOrderSide] = useState<"BUY" | "SELL">("BUY");
  const [orderBusy, setOrderBusy] = useState(false);
  const refreshInFlight = useRef<Promise<string | null> | null>(null);
  const [watchlist, setWatchlist] = useState(() => {
    try {
      const stored = window.localStorage.getItem("apex-watchlist");
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      if (Array.isArray(parsed) && parsed.every((symbol) => typeof symbol === "string")) return parsed as string[];
    } catch {
      return ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"];
    }
    return ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"];
  });

  async function apiFetch(path: string, options: RequestInit = {}, token = accessToken): Promise<Response> {
    const requestWithToken = (currentToken: string) => {
      const headers = new Headers(options.headers);
      if (currentToken) headers.set("Authorization", `Bearer ${currentToken}`);
      return fetch(path, { ...options, headers, credentials: "include" });
    };
    const firstResponse = await requestWithToken(token);
    if (firstResponse.status !== 401 || !token || path.startsWith("/api/auth/")) return firstResponse;
    if (!refreshInFlight.current) {
      refreshInFlight.current = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
        .then(async (response) => response.ok ? (await response.json() as { accessToken: string }).accessToken : null)
        .catch(() => null)
        .finally(() => { refreshInFlight.current = null; });
    }
    const refreshedToken = await refreshInFlight.current;
    if (!refreshedToken) { setAccessToken(""); setProfile(null); return firstResponse; }
    setAccessToken(refreshedToken);
    return requestWithToken(refreshedToken);
  }

  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch(`/api/auth/${authMode === "register" ? "register" : "login"}`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword, displayName: authName }),
      });
      const result = await response.json() as { accessToken?: string; user?: { email: string; displayName?: string }; error?: string };
      if (!response.ok || !result.accessToken) throw new Error(result.error || "Sign-in failed");
      setAccessToken(result.accessToken);
      setProfile(result.user || { email: authEmail });
      setAuthOpen(false);
      setAuthPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign-in failed");
    } finally { setAuthBusy(false); }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
    setAccessToken("");
    setProfile(null);
    setPortfolio(null);
    setOrders([]);
    setNotifications([]);
    setWatchlist(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"]);
  }

  async function loadMarket() {
    try {
      const [marketResponse, healthResponse] = await Promise.all([
        fetch("/api/markets"), fetch("/api/markets/health"),
      ]);
      if (!marketResponse.ok) throw new Error("Market data is unavailable");
      const marketData = (await marketResponse.json()) as Quote[];
      setQuotes(marketData);
      if (healthResponse.ok) setHealth((await healthResponse.json()) as Health);
    } catch {
      setHealth((current) => current);
    } finally {
      setLoading(false);
    }
  }

  async function loadPrivateState(token = accessToken) {
    if (!token) return;
    const paths = ["/api/users/me", "/api/watchlist", "/api/portfolio", "/api/orders", "/api/notifications", "/api/analytics", "/api/portfolio/transactions"];
    const responses = await Promise.all(paths.map((path) => apiFetch(path, {}, token).catch(() => null)));
    const bodies = await Promise.all(responses.map(async (response) => response?.ok ? response.json().catch(() => null) : null));
    if (bodies[0]) setProfile({ email: (bodies[0] as { email: string }).email, displayName: (bodies[0] as { displayName?: string }).displayName });
    if (Array.isArray(bodies[1])) setWatchlist((bodies[1] as Array<{ symbol: string }>).map((item) => item.symbol));
    if (bodies[2]) setPortfolio(bodies[2] as PortfolioData);
    if (Array.isArray(bodies[3])) setOrders(bodies[3] as Order[]);
    if (Array.isArray(bodies[4])) setNotifications(bodies[4] as Notice[]);
    if (bodies[5]) setAnalytics(bodies[5] as { counts: Array<{ eventType: string; total: number }> });
    if (Array.isArray(bodies[6])) setTransactions(bodies[6] as typeof transactions);
  }

  async function placePaperOrder() {
    if (!selectedQuote || selectedQuote.type === "currency") return;
    setOrderBusy(true);
    try {
      const response = await apiFetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ symbol: selectedQuote.symbol, side: orderSide, quantity: orderQuantity }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Order could not be submitted");
      setTab("Orders");
      await loadPrivateState();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Order could not be submitted");
    } finally { setOrderBusy(false); }
  }

  useEffect(() => {
    void loadMarket();
    const timer = window.setInterval(() => void loadMarket(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (response) => response.ok ? response.json() as Promise<{ accessToken: string }> : null)
      .then((result) => { if (result?.accessToken) setAccessToken(result.accessToken); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!accessToken) return;
    void loadPrivateState(accessToken);
    const timer = window.setInterval(() => void loadPrivateState(accessToken), 5_000);
    return () => window.clearInterval(timer);
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) window.localStorage.setItem("apex-watchlist", JSON.stringify(watchlist));
  }, [watchlist, accessToken]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/markets/${encodeURIComponent(selected)}/history?range=${range}`)
      .then((response) => response.ok ? response.json() as Promise<Point[]> : [])
      .then((points) => { if (!cancelled) setHistory(points); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [selected, range]);

  useEffect(() => {
    if (!accessToken) return;
    let socket: WebSocket | null = null;
    let cancelled = false;
    void apiFetch("/api/realtime-ticket", { method: "POST" }, accessToken)
      .then(async (response) => response.ok ? response.json() as Promise<{ ticket: string }> : null)
      .then((result) => {
        if (!result || cancelled) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(`${protocol}//${window.location.host}/ws?ticket=${encodeURIComponent(result.ticket)}`);
        socket.onmessage = (message) => {
          try {
            const event = JSON.parse(String(message.data)) as { type?: string; data?: { symbol: string; price: string; change?: string; changePercent?: string; updatedAt?: string; instrumentType?: Quote["type"] } };
            if (event.type !== "PRICE_UPDATED" || !event.data) return;
            const quote = event.data;
            setQuotes((current) => current.map((item) => item.symbol === quote.symbol ? {
              ...item, price: Number(quote.price), change: Number(quote.change || 0),
              changePercent: Number(quote.changePercent || 0), updatedAt: quote.updatedAt || item.updatedAt,
            } : item));
            if (quote.symbol === selected) setHistory((current) => [...current, { price: Number(quote.price), capturedAt: quote.updatedAt || new Date().toISOString() }].slice(-500));
          } catch { /* Ignore malformed realtime frames. */ }
        };
      })
      .catch(() => undefined);
    return () => { cancelled = true; socket?.close(); };
  }, [accessToken, selected]);

  const selectedQuote = quotes.find((quote) => quote.symbol === selected);
  const equities = quotes.filter((quote) => quote.type !== "currency");
  const currencies = quotes.filter((quote) => quote.type === "currency");
  const filteredCurrencies = currencies.filter((quote) =>
    `${quote.symbol} ${quote.name}`.toLowerCase().includes(currencyQuery.toLowerCase()),
  );
  const indexCards = equities.filter((quote) => quote.type === "index");
  const watchQuotes = equities.filter((quote) => watchlist.includes(quote.symbol));
  const marketTab = ["Overview", "Equities", "Currencies"].includes(tab);
  const filteredEquities = equities.filter((quote) =>
    `${quote.symbol} ${quote.name}`.toLowerCase().includes(query.toLowerCase()),
  );

  async function requestRefresh() {
    setRefreshing(true);
    try {
      await apiFetch("/api/markets/refresh", { method: "POST" });
      await loadMarket();
    } finally {
      window.setTimeout(() => setRefreshing(false), 900);
    }
  }

  async function toggleWatch(symbol: string) {
    const isWatched = watchlist.includes(symbol);
    if (accessToken) {
      const response = await apiFetch(isWatched ? `/api/watchlist/${encodeURIComponent(symbol)}` : "/api/watchlist", {
        method: isWatched ? "DELETE" : "POST",
        ...(isWatched ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol }) }),
      });
      if (!response.ok) return;
    }
    setWatchlist((current) => isWatched ? current.filter((item) => item !== symbol) : [...current, symbol]);
  }

  const providerReady = Boolean(quotes.length > 0) || Boolean(health?.provider && health.provider !== "not-configured");
  const providerLabel = health?.provider && health.provider !== "not-configured" ? health.provider.replace(/-/g, " ") : quotes.length ? "demo fallback" : "Not connected";
  const refreshMinutes = health ? Math.round(health.refreshIntervalMs / 60_000) : 0;
  const updatedAt = health?.lastRefreshAt || quotes.find((quote) => quote.updatedAt)?.updatedAt || null;
  const sessionQuote = quotes.find((quote) => quote.symbol === "AAPL");

  return (
    <div className="app-shell">
      {authOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
        <form className="auth-modal" onSubmit={authenticate}>
          <button type="button" className="modal-close icon-button" aria-label="Close sign in" onClick={() => setAuthOpen(false)}><X size={18} /></button>
          <div className="panel-kicker">APEX MARKETS ACCOUNT</div>
          <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
          <p>Save your watchlist and keep a paper portfolio across devices.</p>
          {authMode === "register" && <label className="form-field">Display name<input value={authName} onChange={(event) => setAuthName(event.target.value)} minLength={1} maxLength={80} autoComplete="name" required /></label>}
          <label className="form-field">Email<input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} autoComplete="email" required /></label>
          <label className="form-field">Password<input type="password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} minLength={authMode === "register" ? 10 : 1} maxLength={128} autoComplete={authMode === "register" ? "new-password" : "current-password"} required /></label>
          {authError && <div className="form-error" role="alert">{authError}</div>}
          <button className="primary-button" disabled={authBusy}>{authBusy ? "Working..." : authMode === "login" ? "Sign in" : "Create account"}</button>
          <button type="button" className="text-action auth-switch" onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthError(""); }}>{authMode === "login" ? "Create a new account" : "I already have an account"}</button>
        </form>
      </div>}
      {notificationsOpen && <div className="notification-popover">
        <div className="notification-popover-head"><b>Notifications</b><button className="plain-icon" aria-label="Close notifications" onClick={() => setNotificationsOpen(false)}><X size={16} /></button></div>
        {notifications.length ? notifications.map((notice) => <button className={`notification-item ${notice.readAt ? "read" : ""}`} key={notice.id} onClick={() => void apiFetch(`/api/notifications/${notice.id}/read`, { method: "POST" }).then((response) => { if (response.ok) setNotifications((current) => current.map((item) => item.id === notice.id ? { ...item, readAt: new Date().toISOString() } : item)); })}>
          <b>{notice.type.replace(/_/g, " ")}</b><span>{notice.message}</span><small>{new Date(notice.createdAt).toLocaleString()}</small>
        </button>) : <div className="notification-empty">No order notifications yet.</div>}
      </div>}
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <a className="brand" href="#overview" aria-label="Apex home">
          <span className="brand-mark"><Activity size={19} strokeWidth={2.4} /></span>
          <span>apex<span className="brand-dot">.</span></span>
          <span className="brand-label">MARKETS</span>
        </a>
        <div className="side-section-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {([
            ["Overview", LayoutDashboard], ["Equities", LineChart], ["Currencies", Globe2],
            ["Portfolio", Wallet], ["Orders", Activity], ["Analytics", TrendingUp],
          ] as const).map(([label, Icon]) => (
            <button className={`nav-item ${tab === label ? "active" : ""}`} key={label} onClick={() => { setTab(label); setMenuOpen(false); }}>
              <Icon size={17} strokeWidth={1.8} /> <span>{label}</span>
              {label === "Currencies" && <span className="nav-count">{currencies.length || 6}</span>}
            </button>
          ))}
        </nav>
        <div className="side-section-label watch-heading">YOUR WATCHLIST <button className="plain-icon" title="Edit watchlist" onClick={() => setTab("Equities")}><Settings2 size={14} /></button></div>
        <div className="side-watchlist">
          {watchQuotes.map((quote) => <button key={quote.symbol} className={`side-watch-row ${selected === quote.symbol ? "chosen" : ""}`} onClick={() => setSelected(quote.symbol)}>
            <span className="ticker-avatar">{quote.symbol.slice(0, 1)}</span><span className="side-ticker-info"><b>{quote.symbol}</b><small>{quote.name.split(/[ ,]/)[0]}</small></span>
            <span className={`side-change ${changeClass(quote.changePercent)}`}>{formatChange(quote.changePercent)}</span>
          </button>)}
          {!watchQuotes.length && <div className="sidebar-empty">Add a symbol from Equities</div>}
        </div>
        <div className="sidebar-bottom">
          <div className="connection-card">
            <div className="connection-top"><span className={`status-dot ${providerReady ? "online" : "offline"}`} />{providerReady ? "LIVE DATA FEED" : "FEED NOT CONNECTED"}</div>
            <div className="connection-sub">{providerReady ? `Updated ${shortTime(updatedAt)}` : "Connect a provider key to see live prices."}</div>
          </div>
          <button className="nav-item muted-nav"><CircleHelp size={17} /><span>Help & support</span></button>
          <button className="profile-row profile-button" onClick={() => profile ? void signOut() : setAuthOpen(true)}>
            <div className="profile-avatar">{profile?.email.slice(0, 1).toUpperCase() || "A"}</div>
            <div><b>{profile?.displayName || profile?.email || "Guest viewer"}</b><small>{profile ? "Sign out" : "Sign in to save your portfolio"}</small></div>
            {profile ? <LogOut size={15} className="profile-chevron" /> : <LogIn size={15} className="profile-chevron" />}
          </button>
        </div>
      </aside>

      {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><span className="crumb-slash">/</span><b>{tab}</b></div>
          <div className="topbar-actions">
            <div className="market-clock"><span className={`status-dot ${sessionQuote?.marketOpen === true ? "online" : sessionQuote?.marketOpen === false ? "closed" : ""}`} />{sessionQuote?.marketOpen === true ? "NYSE OPEN" : sessionQuote?.marketOpen === false ? "NYSE CLOSED" : "NYSE"} <span className="clock-time">{new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())} ET</span><ChevronDown size={13} /></div>
            <button className="icon-button notification-button" aria-label="Notifications" onClick={() => profile ? setNotificationsOpen((open) => !open) : setAuthOpen(true)}><Bell size={18} />{notifications.some((item) => !item.readAt) && <i />}</button>
            <button className="top-avatar avatar-button" aria-label={profile ? "Sign out" : "Sign in"} onClick={() => profile ? void signOut() : setAuthOpen(true)}>{profile?.email.slice(0, 1).toUpperCase() || "A"}</button>
          </div>
        </header>

        <div className="page-wrap">
          <section className="page-heading">
            <div><div className="eyebrow"><span className="eyebrow-rule" />{tab === "Overview" ? new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "2-digit", year: "numeric" }).format(new Date()).toUpperCase() : profile?.email || "APEX MARKETS"}</div><h1>{tab === "Overview" ? "Market overview" : tab === "Equities" ? "Equity markets" : tab === "Currencies" ? "Currency markets" : tab}</h1><p className="page-subtitle">{tab === "Orders" ? "Paper trading only. No broker connection or live orders." : tab === "Portfolio" ? "Your holdings and balances are updated from processed paper fills." : tab === "Analytics" ? "Aggregated domain activity from the event stream." : "A clear view of the markets that move your world."}</p></div>
            <div className="heading-actions">{["Overview", "Equities", "Currencies"].includes(tab) && <><div className="updated-label"><Clock3 size={14} /><span>Last sync <b>{shortTime(updatedAt)}</b></span></div><button className="refresh-button" onClick={requestRefresh} disabled={refreshing || !providerReady} title={!providerReady ? "Configure a provider API key to refresh" : "Refresh market data"}><RefreshCw size={15} className={refreshing || health?.refreshing ? "spinning" : ""} /> Refresh</button></>}</div>
          </section>

          {!providerReady && <section className="feed-notice"><div className="notice-icon"><Activity size={17} /></div><div><b>Live feed not connected</b><span>Configure a provider key in your environment to populate current prices. No sample prices are shown.</span></div><span className="notice-status">{health?.status === "ok" ? "MARKET DATA SERVICE READY" : "CONNECTING"}</span></section>}
          {providerReady && <section className="feed-notice"><div className="notice-icon"><Activity size={17} /></div><div><b>Live feed connected</b><span>Provider: {providerLabel}. Updating quotes with real data; some symbols may be limited by the provider.</span></div><span className="notice-status">{health?.status === "ok" ? "CONNECTED" : "READY"}</span></section>}

          {marketTab && tab !== "Currencies" && <>
            <section className="index-strip" aria-label="Market indices">
              {indexCards.map((quote, index) => <button className={`index-tile ${selected === quote.symbol ? "index-selected" : ""}`} key={quote.symbol} onClick={() => setSelected(quote.symbol)}>
                <span className="index-title">{["S&P 500", "NASDAQ 100", "DOW JONES"][index] || quote.symbol}<span className="index-symbol">{quote.symbol} · ETF proxy</span></span>
                <span className="index-value">{formatPrice(quote.price)}</span><span className={`index-delta ${changeClass(quote.changePercent)}`}>{quote.change && quote.change > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{quote.change !== null ? `${quote.change > 0 ? "+" : ""}${quote.change.toFixed(2)}` : "—"}<span>({formatChange(quote.changePercent)})</span></span>
                <MiniSpark positive={(quote.changePercent || 0) >= 0} data={selected === quote.symbol ? history.map((point) => point.price) : []} />
              </button>)}
            </section>

            <section className="market-grid">
              <article className="panel chart-panel">
                <div className="panel-heading chart-heading">
                  <div><div className="panel-kicker">INSTRUMENT PERFORMANCE</div><div className="instrument-heading"><h2>{selectedQuote?.symbol || selected}</h2><span className="instrument-name">{selectedQuote?.name || "Select an instrument"}</span></div></div>
                  <div className="range-tabs">{["1D", "1W", "1M"].map((item) => <button className={range === item ? "range-active" : ""} key={item} onClick={() => setRange(item)}>{item}</button>)}</div>
                </div>
                <div className="chart-metric-row"><div className="chart-price">{formatQuotePrice(selectedQuote)} <span className={`metric-change ${changeClass(selectedQuote?.changePercent)}`}>{selectedQuote?.change !== null && selectedQuote?.change !== undefined ? `${selectedQuote.change > 0 ? "+" : ""}${selectedQuote.change.toFixed(2)}` : "—"} ({formatChange(selectedQuote?.changePercent ?? null)})</span></div><div className="chart-period">{range === "1D" ? "TODAY" : range === "1W" ? "THIS WEEK" : "THIS MONTH"}<span>{history.length} recorded points</span></div></div>
                <div className="chart-wrap">
                  {history.length > 1 ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={history} margin={{ top: 10, right: 3, left: 0, bottom: 0 }}>
                    <defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#137c69" stopOpacity={0.17} /><stop offset="95%" stopColor="#137c69" stopOpacity={0} /></linearGradient></defs>
                    <CartesianGrid stroke="#e8ece8" vertical={false} strokeDasharray="3 4" />
                    <XAxis dataKey="capturedAt" tickFormatter={(value: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value))} tickLine={false} axisLine={false} tick={{ fill: "#87908a", fontSize: 10 }} minTickGap={40} />
                    <YAxis orientation="right" domain={["auto", "auto"]} tickLine={false} axisLine={false} tick={{ fill: "#87908a", fontSize: 10 }} width={58} tickFormatter={(value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 })} />
                    <Tooltip labelFormatter={(value) => new Date(value as string).toLocaleString()} formatter={(value) => [formatPrice(Number(value)), "Price"]} contentStyle={{ border: "1px solid #e2e8e2", borderRadius: 5, fontSize: 12 }} />
                    <Area type="monotone" dataKey="price" stroke="#137c69" strokeWidth={2} fill="url(#chartFill)" activeDot={{ r: 4, fill: "#137c69", stroke: "#fff", strokeWidth: 2 }} />
                  </AreaChart></ResponsiveContainer> : <div className="chart-empty"><div className="chart-empty-icon"><LineChart size={20} /></div><b>{loading ? "Connecting to market data" : "Price history will appear here"}</b><span>Recorded quotes are charted as the live feed updates.</span></div>}
                </div>
                <div className="chart-foot"><span><span className="legend-dot" />Price history</span><span>Source: {providerReady ? providerLabel : "Not connected"}</span></div>
              </article>

              <article className="panel movers-panel">
                <div className="panel-heading"><div><div className="panel-kicker">YOUR LIST</div><h2>Watchlist</h2></div><button className="text-action" onClick={() => setTab("Equities")}>Manage <ArrowUpRight size={14} /></button></div>
                <div className="watchlist-table">
                  <div className="table-head"><span>ASSET</span><span>LAST PRICE</span><span>CHANGE</span></div>
                  {watchQuotes.slice(0, 7).map((quote) => <button className={`watch-row ${selected === quote.symbol ? "watch-selected" : ""}`} key={quote.symbol} onClick={() => setSelected(quote.symbol)}>
                    <span className="asset-cell"><span className={`asset-monogram monogram-${quote.symbol.slice(0, 1).toLowerCase()}`}>{quote.symbol.slice(0, 1)}</span><span><b>{quote.symbol}</b><small>{quote.name.split(/[ ,]/)[0]}</small></span></span>
                    <span className="mono price-cell">{formatPrice(quote.price)}</span><span className={`row-change ${changeClass(quote.changePercent)}`}>{quote.changePercent !== null ? <>{quote.changePercent >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{formatChange(quote.changePercent)}</> : "—"}</span>
                  </button>)}
                  {!watchQuotes.length && <div className="empty-row">No watchlist prices yet.</div>}
                </div>
                <button className="add-symbol" onClick={() => setTab("Equities")}><span>+</span> Add symbol</button>
              </article>
            </section>
          </>}

          {marketTab && tab !== "Currencies" && <section className="panel equities-panel">
            <div className="panel-heading equities-heading"><div><div className="panel-kicker">US MARKETS <span className="live-dot" />{providerReady ? "LIVE FEED" : "AWAITING FEED"}</div><h2>Equities & indices</h2></div><label className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search markets" /><kbd>⌘ K</kbd></label></div>
            <div className="equity-table"><div className="equity-head"><span>INSTRUMENT</span><span>LAST PRICE</span><span>CHANGE</span><span>CHANGE %</span><span>VOLUME</span><span>EXCHANGE</span><span></span></div>
              {filteredEquities.map((quote) => <div className="equity-row" key={quote.symbol}>
                <button className="equity-instrument" onClick={() => setSelected(quote.symbol)}><span className="equity-monogram">{quote.symbol.slice(0, 1)}</span><span><b>{quote.symbol}</b><small>{quote.name}</small></span></button>
                <span className="mono">{formatPrice(quote.price)}</span><span className={`mono ${changeClass(quote.change)}`}>{quote.change === null ? "—" : `${quote.change > 0 ? "+" : ""}${quote.change.toFixed(2)}`}</span><span className={`percent-pill ${changeClass(quote.changePercent)}`}>{formatChange(quote.changePercent)}</span><span className="mono volume-value">{quote.volume === null ? "—" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(quote.volume)}</span><span className="exchange-tag">{quote.exchange}</span><button className={`star-button ${watchlist.includes(quote.symbol) ? "starred" : ""}`} title={watchlist.includes(quote.symbol) ? "Remove from watchlist" : "Add to watchlist"} onClick={() => toggleWatch(quote.symbol)}><Star size={15} fill={watchlist.includes(quote.symbol) ? "currentColor" : "none"} /></button>
              </div>)}
              {!filteredEquities.length && <div className="empty-row">No instruments match “{query}”.</div>}
            </div>
            <div className="table-foot"><span>Showing {filteredEquities.length} instruments</span><span><span className="status-dot online" />Prices in USD · Updated automatically</span></div>
          </section>}

          {marketTab && tab !== "Equities" && <section className="panel fx-panel">
            <div className="panel-heading fx-heading"><div><div className="panel-kicker">FOREIGN EXCHANGE</div><h2>Currency rates</h2></div><label className="search-box fx-search-box"><Search size={15} /><input value={currencyQuery} onChange={(event) => setCurrencyQuery(event.target.value)} placeholder="Find a pair" /></label></div>
            <div className="fx-grid">{filteredCurrencies.map((quote) => {
              const [base, counter] = quote.symbol.split("/");
              return <button className="fx-card" key={quote.symbol} onClick={() => { setSelected(quote.symbol); setRange("1D"); }}>
                <span className="fx-currency-icon">{currencySymbol[counter] || counter?.slice(0, 1)}</span><span className="fx-pair"><b>{base}<i>/</i>{counter}</b><small>{quote.name}</small></span><span className="fx-quote"><b>{quote.price === null ? "—" : quote.price.toFixed(quote.price < 10 ? 4 : 2)}</b><small className={changeClass(quote.changePercent)}>{formatChange(quote.changePercent)}</small></span><span className={`fx-trend ${changeClass(quote.changePercent)}`}>{quote.changePercent !== null && quote.changePercent >= 0 ? <TrendingUp size={17} /> : <ArrowDownRight size={17} />}</span>
              </button>;
            })}{!filteredCurrencies.length && <div className="empty-row fx-empty">No currency pairs match “{currencyQuery}”.</div>}</div>
            <div className="fx-foot"><Globe2 size={14} />Rates are indicative and may be delayed. Base currency: USD.</div>
          </section>}

          {tab === "Portfolio" && <section className="domain-view">
            {!profile ? <SignedOutPrompt action={() => setAuthOpen(true)} title="Sign in to view your portfolio" /> : <>
              <div className="portfolio-summary"><SummaryMetric label="ACCOUNT MODE" value={portfolio?.mode || "PAPER"} /><SummaryMetric label="TOTAL ACCOUNT VALUE" value={portfolio ? formatPrice(Number(portfolio.totalValue)) : "Loading"} /><SummaryMetric label="AVAILABLE CASH" value={portfolio ? formatPrice(Number(portfolio.availableCash)) : "Loading"} /><SummaryMetric label="UNREALIZED P&L" value={portfolio ? formatPrice(Number(portfolio.unrealizedPnl)) : "Loading"} tone={Number(portfolio?.unrealizedPnl || 0) >= 0 ? "positive" : "negative"} /></div>
              <section className="panel data-panel"><div className="panel-heading"><div><div className="panel-kicker">PAPER ACCOUNT</div><h2>Holdings</h2></div><span className="mode-label">NO LIVE BROKER</span></div>
                {portfolio?.holdings.length ? <div className="data-table"><div className="data-head"><span>SYMBOL</span><span>QUANTITY</span><span>AVG. COST</span><span>MARK</span><span>MARKET VALUE</span><span>UNREALIZED P&L</span></div>{portfolio.holdings.map((holding) => <div className="data-row" key={holding.symbol}><b>{holding.symbol}</b><span>{holding.quantity}</span><span>{formatPrice(Number(holding.averagePrice))}</span><span>{holding.currentPrice === null ? "Waiting for price" : formatPrice(Number(holding.currentPrice))}</span><span>{holding.marketValue === null ? "—" : formatPrice(Number(holding.marketValue))}</span><span className={changeClass(Number(holding.unrealizedPnl))}>{holding.unrealizedPnl === null ? "—" : formatPrice(Number(holding.unrealizedPnl))}</span></div>)}</div> : <div className="empty-row">No holdings yet. Submit a paper buy order from the Orders screen.</div>}
              </section>
              <section className="panel data-panel"><div className="panel-heading"><div><div className="panel-kicker">LEDGER</div><h2>Recent transactions</h2></div></div>
                {transactions.length ? <div className="data-table"><div className="data-head"><span>TIME</span><span>INSTRUMENT</span><span>SIDE</span><span>QUANTITY</span><span>PRICE</span><span>TOTAL</span></div>{transactions.map((transaction) => <div className="data-row" key={transaction.orderId}><span>{new Date(transaction.createdAt).toLocaleString()}</span><b>{transaction.symbol}</b><span>{transaction.side}</span><span>{transaction.quantity}</span><span>{formatPrice(Number(transaction.price))}</span><span>{formatPrice(Number(transaction.total))}</span></div>)}</div> : <div className="empty-row">No transactions recorded.</div>}
              </section>
            </>}
          </section>}

          {tab === "Orders" && <section className="domain-view">
            {!profile ? <SignedOutPrompt action={() => setAuthOpen(true)} title="Sign in to place paper orders" /> : <>
              <section className="panel order-ticket"><div><div className="panel-kicker">SIMULATED EXECUTION</div><h2>Paper order ticket</h2><p>Orders use the latest stored market quote and paper cash/holdings. No broker is connected.</p></div>
                <div className="order-controls"><label className="form-field">Instrument<input value={selectedQuote?.type === "currency" ? "Select an equity above" : selectedQuote?.symbol || "AAPL"} readOnly /></label><label className="form-field">Side<select value={orderSide} onChange={(event) => setOrderSide(event.target.value as "BUY" | "SELL")}><option value="BUY">Buy</option><option value="SELL">Sell</option></select></label><label className="form-field">Quantity<input type="number" min="0.00000001" max="100000" step="0.00000001" value={orderQuantity} onChange={(event) => setOrderQuantity(event.target.value)} /></label><button className="primary-button" disabled={orderBusy || !selectedQuote || selectedQuote.type === "currency"} onClick={() => void placePaperOrder()}>{orderBusy ? "Submitting..." : `${orderSide} ${selectedQuote?.symbol || "stock"} · Paper`}</button></div>
                {authError && <div className="form-error" role="alert">{authError}</div>}
              </section>
              <section className="panel data-panel"><div className="panel-heading"><div><div className="panel-kicker">ORDER LIFECYCLE</div><h2>Orders</h2></div><span className="mode-label">CREATED → VALIDATING → ACCEPTED → EXECUTING → FILLED</span></div>
                {orders.length ? <div className="data-table"><div className="data-head order-data-head"><span>ORDER</span><span>INSTRUMENT</span><span>SIDE</span><span>QTY</span><span>STATE</span><span>DETAIL</span></div>{orders.map((order) => <div className="data-row order-data-row" key={order.id}><span className="order-id">{order.id.slice(0, 8)}</span><b>{order.symbol}</b><span className={order.side === "BUY" ? "positive" : "negative"}>{order.side}</span><span>{order.quantity}</span><span className={`state-chip state-${order.status.toLowerCase()}`}>{order.status}</span><span>{order.reason || (order.averagePrice ? `Filled ${formatPrice(Number(order.averagePrice))}` : "Paper order")}</span></div>)}</div> : <div className="empty-row">No orders have been submitted.</div>}
              </section>
            </>}
          </section>}

          {tab === "Analytics" && <section className="domain-view">{!profile ? <SignedOutPrompt action={() => setAuthOpen(true)} title="Sign in to view account analytics" /> : <section className="panel data-panel"><div className="panel-heading"><div><div className="panel-kicker">EVENT STREAM</div><h2>Domain activity</h2></div></div><div className="portfolio-summary">{analytics?.counts.map((item) => <SummaryMetric key={item.eventType} label={item.eventType.replace(/_/g, " ")} value={String(item.total)} />)}{!analytics?.counts.length && <div className="empty-row">No events have been recorded yet.</div>}</div></section>}</section>}

          <footer className="page-footer"><span>APEX MARKETS <i>·</i> MARKET DATA TERMINAL</span><span>{health?.lastRefreshError ? <b className="negative">{health.lastRefreshError}</b> : providerReady ? `AUTO-REFRESH EVERY ${refreshMinutes} MIN` : "LIVE PRICING REQUIRES A DATA PROVIDER KEY"}</span></footer>
        </div>
      </main>
    </div>
  );
}

function SummaryMetric({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return <div className="summary-metric"><span>{label}</span><b className={tone}>{value}</b></div>;
}

function SignedOutPrompt({ title, action }: { title: string; action: () => void }) {
  return <section className="panel signed-out-panel"><div className="signed-out-icon"><Wallet size={22} /></div><h2>{title}</h2><p>Authenticate to see user-owned data and actions.</p><button className="primary-button" onClick={action}>Sign in / Create account</button></section>;
}

function changeClass(value: number | null | undefined) {
  return value === null || value === undefined ? "neutral" : value >= 0 ? "positive" : "negative";
}

function MiniSpark({ positive, data }: { positive: boolean; data: number[] }) {
  if (data.length < 2) return <span className="spark-empty" />;
  const min = Math.min(...data);
  const span = Math.max(...data) - min || 1;
  const points = data.map((value, index) => `${(index / (data.length - 1)) * 92},${22 - ((value - min) / span) * 18}`).join(" ");
  return <svg className={`mini-spark ${positive ? "positive" : "negative"}`} viewBox="0 0 92 24" preserveAspectRatio="none" aria-hidden="true"><polyline points={points} /></svg>;
}

export default App;