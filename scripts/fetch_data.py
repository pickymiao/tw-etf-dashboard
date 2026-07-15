#!/usr/bin/env python3
"""Daily data pipeline: pull OHLCV + institutional buy/sell from FinMind, compute
indicators + rule-based score for each watch-listed ETF, and write JSON the
static site reads.

Stdlib-only on purpose (urllib, json) so this runs on any GitHub Actions
runner with zero pip install step.
"""
import json
import os
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from indicators import sma, rsi, macd
from scoring import compute_score

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config", "etfs.json")
DATA_DIR = os.path.join(ROOT, "site", "data")
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
HISTORY_DAYS = 240  # calendar days of lookback, gives enough trading days to warm up MA60
INSTITUTIONAL_CATEGORIES = [
    "Foreign_Investor", "Foreign_Dealer_Self", "Investment_Trust", "Dealer_self", "Dealer_Hedging",
]


def finmind_request(dataset, code, start_date):
    params = {"dataset": dataset, "data_id": code, "start_date": start_date}
    token = os.environ.get("FINMIND_TOKEN")
    if token:
        params["token"] = token
    url = f"{FINMIND_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "tw-etf-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    return payload.get("data", [])


def fetch_price_history(code, start_date):
    rows = finmind_request("TaiwanStockPrice", code, start_date)
    rows.sort(key=lambda r: r["date"])
    return rows


def fetch_institutional_history(code, start_date):
    """Sum the 5 FinMind institutional categories (foreign/trust/dealer) into one
    daily net buy/sell figure -- this is the standard '三大法人買賣超' figure."""
    rows = finmind_request("TaiwanStockInstitutionalInvestorsBuySell", code, start_date)
    by_date = {}
    for r in rows:
        if r.get("name") not in INSTITUTIONAL_CATEGORIES:
            continue
        d = by_date.setdefault(r["date"], {"buy": 0, "sell": 0})
        d["buy"] += r.get("buy") or 0
        d["sell"] += r.get("sell") or 0
    return by_date


def build_series(rows, institutional_by_date):
    dates = [r["date"] for r in rows]
    closes = [r["close"] for r in rows]
    volumes = [r["Trading_Volume"] for r in rows]

    ma5 = sma(closes, 5)
    ma20 = sma(closes, 20)
    ma60 = sma(closes, 60)
    vol_ma20 = sma(volumes, 20)
    rsi14 = rsi(closes, 14)
    macd_line, signal_line, hist = macd(closes)

    series = []
    for i in range(len(rows)):
        inst = institutional_by_date.get(dates[i])
        series.append({
            "date": dates[i],
            "close": closes[i],
            "volume": volumes[i],
            "ma5": ma5[i],
            "ma20": ma20[i],
            "ma60": ma60[i],
            "vol_ma20": vol_ma20[i],
            "rsi14": rsi14[i],
            "macd": macd_line[i],
            "signal": signal_line[i],
            "hist": hist[i],
            "inst_buy": inst["buy"] if inst else None,
            "inst_sell": inst["sell"] if inst else None,
            "inst_net": (inst["buy"] - inst["sell"]) if inst else None,
        })
    return series


def latest_score(series):
    if len(series) < 2:
        return None
    today = series[-1]
    yesterday = series[-2]
    return compute_score(
        ma5=today["ma5"], ma20=today["ma20"], ma60=today["ma60"],
        hist=today["hist"], prev_hist=yesterday["hist"],
        close=today["close"], prev_close=yesterday["close"],
        inst_net=today["inst_net"],
        rsi_value=today["rsi14"],
    )


def fetch_market_overview(start_date):
    """TAIEX (加權指數) daily close + 1-week trend + a longer history for the homepage chart."""
    rows = finmind_request("TaiwanStockPrice", "TAIEX", start_date)
    rows.sort(key=lambda r: r["date"])
    if not rows:
        return None

    history = []
    for i, r in enumerate(rows):
        prev_close = rows[i - 1]["close"] if i > 0 else None
        change_pct = ((r["close"] - prev_close) / prev_close * 100) if prev_close else None
        history.append({"date": r["date"], "close": r["close"], "change_pct": change_pct})

    trading_history = history[-30:]  # ~6 weeks of trading days, enough for a short trend line
    week = history[-6:]  # today + up to 5 prior trading days, for the quick day-by-day view
    latest = week[-1]
    return {
        "date": latest["date"],
        "close": latest["close"],
        "change_pct": latest["change_pct"],
        "week": week,
        "history": trading_history,
    }


def process_ticker(code, name, group, start_date):
    print(f"Fetching {code} {name} ({group})...")
    try:
        rows = fetch_price_history(code, start_date)
    except Exception as exc:  # network/API hiccup shouldn't kill the whole run
        print(f"  failed: {exc}", file=sys.stderr)
        return None
    if not rows:
        print(f"  no data returned for {code}", file=sys.stderr)
        return None

    try:
        institutional_by_date = fetch_institutional_history(code, start_date)
    except Exception as exc:
        print(f"  institutional fetch failed: {exc}", file=sys.stderr)
        institutional_by_date = {}

    series = build_series(rows, institutional_by_date)
    score = latest_score(series)

    with open(os.path.join(DATA_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
        json.dump({
            "code": code,
            "name": name,
            "series": series[-180:],  # keep payload small; ~180 trading days is plenty for charts
        }, f, ensure_ascii=False)

    latest = series[-1]
    return {
        "code": code,
        "name": name,
        "group": group,
        "date": latest["date"],
        "close": latest["close"],
        "change": (latest["close"] - series[-2]["close"]) if len(series) >= 2 else None,
        "volume": latest["volume"],
        "inst_buy": latest["inst_buy"],
        "inst_sell": latest["inst_sell"],
        "inst_net": latest["inst_net"],
        "score": score,
    }


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_PATH, encoding="utf-8") as f:
        config = json.load(f)

    start_date = (datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)).strftime("%Y-%m-%d")

    print("Fetching TAIEX market overview...")
    try:
        market = fetch_market_overview(start_date)
    except Exception as exc:
        print(f"  failed: {exc}", file=sys.stderr)
        market = None
    with open(os.path.join(DATA_DIR, "market.json"), "w", encoding="utf-8") as f:
        json.dump({
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "taiex": market,
        }, f, ensure_ascii=False, indent=2)

    summary = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": [],
    }

    for entry in config.get("watchlist", []):
        item = process_ticker(entry["code"], entry["name"], "watchlist", start_date)
        if item:
            summary["items"].append(item)

    for entry in config.get("sector_watchlist", []):
        item = process_ticker(entry["code"], entry["name"], "sector", start_date)
        if item:
            summary["items"].append(item)

    with open(os.path.join(DATA_DIR, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"Done. Wrote {len(summary['items'])} ETF snapshots.")


if __name__ == "__main__":
    main()
