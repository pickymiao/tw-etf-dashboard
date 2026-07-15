// Mirrors scripts/scoring.py exactly (same rules, same wording), so manually
// added tickers score identically to the daily-batch tracked ones.

function trendScore(ma5, ma20, ma60) {
  if (ma5 == null || ma20 == null || ma60 == null) return [0, "資料不足"];
  if (ma5 > ma20 && ma20 > ma60) return [40, "短、中、長期價格都在漲，趨勢向上"];
  if (ma5 > ma20 && ma20 >= ma60 * 0.999) return [20, "短期價格轉強"];
  if (ma5 < ma20 && ma20 < ma60) return [-40, "短、中、長期價格都在跌，趨勢向下"];
  if (ma5 < ma20 && ma20 <= ma60 * 1.001) return [-20, "短期價格轉弱"];
  return [0, "漲跌不明顯"];
}

function momentumScore(hist, prevHist) {
  if (hist == null || prevHist == null) return [0, "資料不足"];
  if (hist > 0 && hist > prevHist) return [30, "上漲力道正在增強"];
  if (hist > 0 && prevHist <= 0) return [20, "剛轉強，力道增加中"];
  if (hist > 0) return [10, "還在漲，但力道變弱"];
  if (hist < 0 && hist < prevHist) return [-30, "下跌力道正在增強"];
  if (hist < 0 && prevHist >= 0) return [-20, "剛轉弱，力道增加中"];
  if (hist < 0) return [-10, "還在跌，但力道變弱"];
  return [0, "力道持平"];
}

function chipScore(instNet, close, prevClose) {
  if (instNet == null) return [0, "沒有大戶買賣資料"];
  const lots = Math.round(Math.abs(instNet) / 1000).toLocaleString("zh-Hant");
  if (instNet > 0 && close != null && prevClose != null && close > prevClose) {
    return [30, `大戶買超 ${lots} 張，股價也上漲`];
  }
  if (instNet > 0) return [15, `大戶買超 ${lots} 張，但股價還沒漲`];
  if (instNet < 0 && close != null && prevClose != null && close < prevClose) {
    return [-30, `大戶賣超 ${lots} 張，股價也下跌`];
  }
  if (instNet < 0) return [-15, `大戶賣超 ${lots} 張，但股價還撐得住`];
  return [0, "大戶買賣力道不明顯"];
}

function computeScore({ ma5, ma20, ma60, hist, prevHist, close, prevClose, instNet, rsiValue }) {
  const [tScore, tReason] = trendScore(ma5, ma20, ma60);
  const [mScore, mReason] = momentumScore(hist, prevHist);
  const [vScore, vReason] = chipScore(instNet, close, prevClose);

  const total = Math.max(-100, Math.min(100, tScore + mScore + vScore));
  const label = total >= 30 ? "偏多" : total <= -30 ? "偏空" : "中性";

  let caution = null;
  if (rsiValue != null) {
    if (rsiValue >= 70) caution = `RSI ${rsiValue.toFixed(0)}，偏高，可能買氣過熱，留意回檔`;
    else if (rsiValue <= 30) caution = `RSI ${rsiValue.toFixed(0)}，偏低，可能賣壓過重，留意反彈`;
  }

  return {
    total,
    label,
    breakdown: [
      { factor: "趨勢（價格方向）", score: tScore, reason: tReason },
      { factor: "動能（漲跌力道）", score: mScore, reason: mReason },
      { factor: "籌碼（大戶買賣）", score: vScore, reason: vReason },
    ],
    caution,
  };
}
