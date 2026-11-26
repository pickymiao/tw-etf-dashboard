"""Rule-based market state ("市場狀態") classification.

Deliberately simple and explainable: every state comes with the reasons that
triggered it. Levels:
  0 正常   1 注意   2 警戒   3 大跌   4 回穩 (rebounding after an alert/crash)
"""

LABELS = {0: "正常", 1: "注意", 2: "警戒", 3: "大跌", 4: "回穩"}


def drawdown(closes, window):
    """Close vs. the highest close of the trailing `window` days (incl. today)."""
    if not closes:
        return None
    recent = closes[-window:]
    peak = max(recent)
    return closes[-1] / peak - 1 if peak else None


def day_change(closes):
    if len(closes) < 2 or not closes[-2]:
        return None
    return closes[-1] / closes[-2] - 1


def classify(tw_closes, us_closes, vix, rules, prev_levels=None):
    """Return (level, reasons). `prev_levels` = levels of the previous ~20
    trading days, used to detect a rebound after an alert/crash."""
    w = rules["drawdown_window"]
    reasons = []
    dd_tw = drawdown(tw_closes, w)
    dd_us = drawdown(us_closes, w) if us_closes else None
    day_tw = day_change(tw_closes)

    dds = [d for d in (dd_tw, dd_us) if d is not None]
    dd = min(dds) if dds else 0

    level = 0
    if dd <= rules["crash_drawdown"] or (vix is not None and vix >= rules["crash_vix"]):
        level = 3
    elif dd <= rules["alert_drawdown"] or (vix is not None and vix >= rules["alert_vix"]):
        level = 2
    elif dd <= rules["watch_drawdown"] or (day_tw is not None and day_tw <= rules["watch_day_drop"]):
        level = 1

    if dd_tw is not None and dd_tw <= rules["watch_drawdown"]:
        reasons.append(f"台股距 {w} 日高點 {dd_tw * 100:.1f}%")
    if dd_us is not None and dd_us <= rules["watch_drawdown"]:
        reasons.append(f"美股距 {w} 日高點 {dd_us * 100:.1f}%")
    if vix is not None and vix >= rules["alert_vix"]:
        reasons.append(f"VIX {vix:.1f}，市場恐慌升高")
    if day_tw is not None and day_tw <= rules["watch_day_drop"]:
        reasons.append(f"台股單日 {day_tw * 100:.1f}%")

    # Rebound: was in alert/crash recently, now bounced off the recent low.
    if prev_levels and max(prev_levels) >= 2 and level <= 1 and len(tw_closes) >= 20:
        low = min(tw_closes[-20:])
        rebound = tw_closes[-1] / low - 1 if low else 0
        if rebound >= rules["recovery_rebound"]:
            level = 4
            reasons = [f"台股自近期低點反彈 {rebound * 100:.1f}%"]

    return level, reasons


def history(tw_closes, us_by_index, vix_by_index, rules, days=130):
    """Daily level history for the last `days` TW trading days.
    us_by_index / vix_by_index: lists aligned to tw_closes (None if missing)."""
    out = []
    start = max(rules["drawdown_window"], len(tw_closes) - days)
    for i in range(start, len(tw_closes)):
        us = [v for v in us_by_index[: i + 1] if v is not None]
        prev = [lv for lv, _ in out[-20:]]
        level, _ = classify(tw_closes[: i + 1], us, vix_by_index[i], rules, prev)
        out.append((level, i))
    return out
