// Mirrors scripts/indicators.py exactly, so manually-added tickers (computed
// live in the browser) score the same way as the daily-batch tracked ones.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) continue;
    const window = values.slice(i + 1 - period, i + 1);
    out[i] = window.reduce((a, b) => a + b, 0) / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (prev === null) {
      if (i + 1 === period) {
        prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
      }
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
    if (i < period) continue;
    const windowGains = gains.slice(i - period, i);
    const windowLosses = losses.slice(i - period, i);
    const avgGain = windowGains.reduce((a, b) => a + b, 0) / period;
    const avgLoss = windowLosses.reduce((a, b) => a + b, 0) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((a, i) => (a != null && emaSlow[i] != null ? a - emaSlow[i] : null));
  const valid = macdLine.filter(v => v != null);
  const signalValid = ema(valid, signal);
  const signalLine = new Array(macdLine.length - valid.length).fill(null).concat(signalValid);
  const histogram = macdLine.map((m, i) => (m != null && signalLine[i] != null ? m - signalLine[i] : null));
  return { macdLine, signalLine, histogram };
}
