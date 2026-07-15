"""Rule-based bullish/bearish scoring. Deliberately simple and explainable
(not a black-box model) so every score can be traced back to a reason.

Mirrored by site/scoring.js (same rules, same wording) for manually-added
tickers that get scored live in the browser instead of by the daily batch.
"""


def trend_score(ma5, ma20, ma60):
    if None in (ma5, ma20, ma60):
        return 0, "資料不足"
    if ma5 > ma20 > ma60:
        return 40, "短、中、長期價格都在漲，趨勢向上"
    if ma5 > ma20 >= ma60 * 0.999:
        return 20, "短期價格轉強"
    if ma5 < ma20 < ma60:
        return -40, "短、中、長期價格都在跌，趨勢向下"
    if ma5 < ma20 <= ma60 * 1.001:
        return -20, "短期價格轉弱"
    return 0, "漲跌不明顯"


def momentum_score(hist, prev_hist):
    if hist is None or prev_hist is None:
        return 0, "資料不足"
    if hist > 0 and hist > prev_hist:
        return 30, "上漲力道正在增強"
    if hist > 0 >= prev_hist:
        return 20, "剛轉強，力道增加中"
    if hist > 0:
        return 10, "還在漲，但力道變弱"
    if hist < 0 and hist < prev_hist:
        return -30, "下跌力道正在增強"
    if hist < 0 <= prev_hist:
        return -20, "剛轉弱，力道增加中"
    if hist < 0:
        return -10, "還在跌，但力道變弱"
    return 0, "力道持平"


def chip_score(inst_net, close, prev_close):
    """Based on 三大法人買賣超 (combined foreign/trust/dealer net buy-sell), the
    standard 'smart money' chip indicator for Taiwan-listed ETFs/stocks."""
    if inst_net is None:
        return 0, "沒有大戶買賣資料"
    lots = round(abs(inst_net) / 1000)
    if inst_net > 0 and close is not None and prev_close is not None and close > prev_close:
        return 30, f"大戶買超 {lots:,} 張，股價也上漲"
    if inst_net > 0:
        return 15, f"大戶買超 {lots:,} 張，但股價還沒漲"
    if inst_net < 0 and close is not None and prev_close is not None and close < prev_close:
        return -30, f"大戶賣超 {lots:,} 張，股價也下跌"
    if inst_net < 0:
        return -15, f"大戶賣超 {lots:,} 張，但股價還撐得住"
    return 0, "大戶買賣力道不明顯"


def compute_score(ma5, ma20, ma60, hist, prev_hist, close, prev_close, inst_net, rsi_value):
    t_score, t_reason = trend_score(ma5, ma20, ma60)
    m_score, m_reason = momentum_score(hist, prev_hist)
    v_score, v_reason = chip_score(inst_net, close, prev_close)

    total = max(-100, min(100, t_score + m_score + v_score))
    if total >= 30:
        label = "偏多"
    elif total <= -30:
        label = "偏空"
    else:
        label = "中性"

    caution = None
    if rsi_value is not None:
        if rsi_value >= 70:
            caution = f"RSI {rsi_value:.0f}，偏高，可能買氣過熱，留意回檔"
        elif rsi_value <= 30:
            caution = f"RSI {rsi_value:.0f}，偏低，可能賣壓過重，留意反彈"

    return {
        "total": total,
        "label": label,
        "breakdown": [
            {"factor": "趨勢（價格方向）", "score": t_score, "reason": t_reason},
            {"factor": "動能（漲跌力道）", "score": m_score, "reason": m_reason},
            {"factor": "籌碼（大戶買賣）", "score": v_score, "reason": v_reason},
        ],
        "caution": caution,
    }
