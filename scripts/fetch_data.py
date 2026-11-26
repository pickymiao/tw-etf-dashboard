#!/usr/bin/env python3
"""Daily market pipeline -> site/data/market.json

Contains MARKET data only (prices, global indices, market state). No personal
holdings, cost basis or amounts ever go into this repo; the private Google
Apps Script page reads this file and combines it with the private Sheet.

Sources:
  - FinMind: TW prices (TAIEX, ETFs, breadth stocks) + cash dividends
  - Yahoo Finance chart API: global indices, VIX, US 10Y, USD/TWD

Stdlib-only on purpose (no pip install step on GitHub Actions).
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from indicators import sma  # noqa: E402
import market_state  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config", "etfs.json")
DATA_DIR = os.path.join(ROOT, "site", "data")
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
YAHOO_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
HISTORY_DAYS = 400       # calendar days: enough for 60-day drawdown + 130-day state history
DIVIDEND_DAYS = 1200     # ~3 years of dividends for the private page
UA = {"User-Agent": "Mozilla/5.0 (tw-etf-dashboard)"}
TPE = timezone(timedelta(hours=8))


# ---------------------------------------------------------------- fetchers --

def http_json(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def finmind(dataset, code, start_date):
    params = {"dataset": dataset, "data_id": code, "start_date": start_date}
    token = os.environ.get("FINMIND_TOKEN")
    if token:
        params["token"] = token
    payload = http_json(f"{FINMIND_URL}?{urllib.parse.urlencode(params)}")
    return payload.get("data", [])


def fetch_tw_prices(code, start_date):
    rows = finmind("TaiwanStockPrice", code, start_date)
    rows.sort(key=lambda r: r["date"])
    return [(r["date"], float(r["close"])) for r in rows if r.get("close")]


def fetch_dividends(code, start_date):
    """Cash dividends as [{ex_date, amount, factor}] from TaiwanStockDividendResult.
    factor = price adjustment multiplier for all closes before ex_date."""
    try:
        rows = finmind("TaiwanStockDividendResult", code, start_date)
    except Exception as exc:
        print(f"  dividends failed for {code}: {exc}", file=sys.stderr)
        return []
    out = []
    for r in rows:
        before = float(r.get("before_price") or 0)
        after = float(r.get("after_price") or 0)
        amount = float(r.get("stock_and_cache_dividend") or 0)
        if before <= 0:
            continue
        if amount > 0:
            factor = (before - amount) / before
        elif after > 0:
            factor, amount = after / before, before - after
        else:
            continue
        if amount <= 0 or not (0 < factor < 1):
            continue
        out.append({"ex_date": r["date"], "amount": round(amount, 4), "factor": factor})
    out.sort(key=lambda d: d["ex_date"])
    return out


def fetch_yahoo(symbol):
    """[(date_str_in_exchange_tz, close)] for the last year."""
    url = f"{YAHOO_URL}{urllib.parse.quote(symbol)}?range=2y&interval=1d"
    payload = http_json(url)
    res = payload["chart"]["result"][0]
    offset = res["meta"].get("gmtoffset", 0)
    closes = res["indicators"]["quote"][0]["close"]
    out = []
    for ts, c in zip(res.get("timestamp", []), closes):
        if c is None:
            continue
        d = datetime.fromtimestamp(ts + offset, tz=timezone.utc).strftime("%Y-%m-%d")
        out.append((d, float(c)))
    return out


# ------------------------------------------------------------------ helpers --

def adjust(series, dividends):
    """Back-adjust closes for cash dividends so ex-dividend drops are not
    mistaken for real declines."""
    out = []
    for d, c in series:
        f = 1.0
        for div in dividends:
            if div["ex_date"] > d:
                f *= div["factor"]
        out.append((d, c * f))
    return out


def pct(closes, n):
    if len(closes) <= n or not closes[-1 - n]:
        return None
    return closes[-1] / closes[-1 - n] - 1


def align_prev(tw_dates, other):
    """For each TW date, the latest `other` close dated strictly BEFORE it
    (US session of day D-1 closes before Taiwan opens on day D)."""
    out, j, last = [], 0, None
    for d in tw_dates:
        while j < len(other) and other[j][0] < d:
            last = other[j][1]
            j += 1
        out.append(last)
    return out


def returns(xs):
    return [
        (xs[i] / xs[i - 1] - 1) if (xs[i] is not None and xs[i - 1]) else None
        for i in range(1, len(xs))
    ]


def corr(a, b, n=60):
    pairs = [(x, y) for x, y in zip(a[-n:], b[-n:]) if x is not None and y is not None]
    if len(pairs) < 20:
        return None
    xs, ys = zip(*pairs)
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x in xs)
    vy = sum((y - my) ** 2 for y in ys)
    if vx <= 0 or vy <= 0:
        return None
    return cov / math.sqrt(vx * vy)


def r4(x):
    return None if x is None else round(x, 4)


def fmt_pct(x):
    return "—" if x is None else f"{x * 100:+.1f}%"


# --------------------------------------------------------------------- main --

def build_summary(level, taiex_dd, taiex_day, breadth, g, cat_week):
    lines = []
    if level == 0:
        lines.append(f"台股距 60 日高點 {fmt_pct(taiex_dd)}，走勢平穩")
    elif level == 4:
        lines.append(f"台股自低點反彈，距 60 日高點 {fmt_pct(taiex_dd)}")
    else:
        extra = f"，權值股僅 {breadth:.0f}% 站上月線" if breadth is not None else ""
        lines.append(f"台股距 60 日高點 {fmt_pct(taiex_dd)}，今日 {fmt_pct(taiex_day)}{extra}")

    sox, nas, vix = g.get("SOX", {}), g.get("NASDAQ", {}), g.get("VIX", {})
    vix_txt = f"，VIX {vix['value']:.1f}" if vix.get("value") is not None else ""
    lines.append(f"費半本週 {fmt_pct(sox.get('week'))}、NASDAQ {fmt_pct(nas.get('week'))}{vix_txt}")

    gw, dw = cat_week.get("growth"), cat_week.get("dividend")
    if gw is not None and dw is not None:
        if abs(gw - dw) < 0.01:
            rel = "兩類走勢相近"
        elif gw < 0 and dw < 0:
            rel = "高股息相對抗跌" if dw > gw else "成長類相對抗跌"
        elif gw > dw:
            rel = "成長類表現較強"
        else:
            rel = "高股息表現較強"
        lines.append(f"成長類本週 {fmt_pct(gw)}，高股息 {fmt_pct(dw)}，{rel}")
    return lines


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)
    rules = config["rules"]
    now = datetime.now(timezone.utc)
    start = (now - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d")
    div_start = (now - timedelta(days=DIVIDEND_DAYS)).strftime("%Y-%m-%d")

    print("TAIEX...")
    taiex = fetch_tw_prices("TAIEX", start)
    if len(taiex) < 70:
        raise SystemExit("TAIEX history too short; aborting without overwriting market.json")
    tw_dates = [d for d, _ in taiex]
    tw_closes = [c for _, c in taiex]
    tw_ret = returns(tw_closes)

    # Global markets
    g_out, g_series = {}, {}
    for item in config["global"]:
        print(f"{item['key']}...")
        try:
            s = fetch_yahoo(item["symbol"])
        except Exception as exc:
            print(f"  failed: {exc}", file=sys.stderr)
            s = []
        g_series[item["key"]] = s
        closes = [c for _, c in s]
        entry = {"key": item["key"], "label": item["label"], "unit": item["unit"],
                 "date": s[-1][0] if s else None, "value": r4(closes[-1]) if closes else None}
        if item["unit"] in ("pct", "fx"):
            entry["day"], entry["week"] = r4(pct(closes, 1)), r4(pct(closes, 5))
        else:  # level / yield: absolute change
            entry["day"] = r4(closes[-1] - closes[-2]) if len(closes) >= 2 else None
            entry["week"] = r4(closes[-1] - closes[-6]) if len(closes) >= 6 else None
        g_out[item["key"]] = entry

    us_aligned = align_prev(tw_dates, g_series.get("SP500", []))
    vix_aligned = align_prev(tw_dates, g_series.get("VIX", []))
    sox_aligned = align_prev(tw_dates, g_series.get("SOX", []))
    sox_ret = returns(sox_aligned)

    # Breadth: % of large caps above their 20-day MA
    above = total = 0
    for s in config.get("breadth_universe", []):
        try:
            closes = [c for _, c in fetch_tw_prices(s["code"], start)]
        except Exception as exc:
            print(f"  breadth {s['code']} failed: {exc}", file=sys.stderr)
            continue
        ma = sma(closes, 20)
        if closes and ma and ma[-1]:
            total += 1
            above += closes[-1] > ma[-1]
    breadth = (above / total * 100) if total else None

    # Holdings
    holdings, cat = [], {"growth": [], "dividend": []}
    for h in config["holdings"]:
        print(f"{h['code']}...")
        try:
            raw = fetch_tw_prices(h["code"], start)
        except Exception as exc:
            print(f"  failed: {exc}", file=sys.stderr)
            raw = []
        divs = fetch_dividends(h["code"], div_start)
        adj = adjust(raw, divs)
        a_closes = [c for _, c in adj]
        by_date = dict(adj)
        a_aligned = [by_date.get(d) for d in tw_dates]
        a_ret = returns(a_aligned)
        week = pct(a_closes, 5)
        if week is not None:
            cat[h["category"]].append(week)
        holdings.append({
            "code": h["code"], "name": h["name"], "category": h["category"],
            "date": raw[-1][0] if raw else None,
            "close": raw[-1][1] if raw else None,
            "day": r4(pct(a_closes, 1)), "week": r4(week), "month": r4(pct(a_closes, 21)),
            "dd60": r4(market_state.drawdown(a_closes, 60)),
            "corr_taiex": r4(corr(a_ret, tw_ret)),
            "corr_sox_prev": r4(corr(a_ret, sox_ret)),
            "dividends": [{"ex_date": d["ex_date"], "amount": d["amount"]} for d in divs],
        })
    cat_week = {k: (sum(v) / len(v) if v else None) for k, v in cat.items()}

    # Market state + history
    hist = market_state.history(tw_closes, us_aligned, vix_aligned, rules)
    prev_levels = [lv for lv, _ in hist[-21:-1]]
    us_now = [v for v in us_aligned if v is not None]
    level, reasons = market_state.classify(tw_closes, us_now, vix_aligned[-1], rules, prev_levels)
    taiex_dd = market_state.drawdown(tw_closes, rules["drawdown_window"])

    market = {
        "version": 2,
        "updated_at": now.isoformat(timespec="seconds"),
        "as_of": tw_dates[-1],
        "state": {"level": level, "label": market_state.LABELS[level], "reasons": reasons},
        "state_history": [{"date": tw_dates[i], "level": lv} for lv, i in hist],
        "summary": build_summary(level, taiex_dd, pct(tw_closes, 1), breadth, g_out, cat_week),
        "taiex": {"close": tw_closes[-1], "day": r4(pct(tw_closes, 1)),
                  "week": r4(pct(tw_closes, 5)), "dd60": r4(taiex_dd)},
        "breadth_above_ma20": None if breadth is None else round(breadth, 1),
        "global": [g_out[i["key"]] for i in config["global"]],
        "holdings": holdings,
        "category_week": {k: r4(v) for k, v in cat_week.items()},
        "rules": rules,
    }
    with open(os.path.join(DATA_DIR, "market.json"), "w", encoding="utf-8") as f:
        json.dump(market, f, ensure_ascii=False, indent=1)
    print(f"Done. state={market['state']['label']} as_of={market['as_of']}")


if __name__ == "__main__":
    main()
