"""Pure-stdlib technical indicator helpers. No third-party dependencies on purpose,
so the daily GitHub Actions job needs nothing beyond the system Python."""


def sma(values, period):
    out = [None] * len(values)
    for i in range(len(values)):
        if i + 1 < period:
            continue
        window = values[i + 1 - period:i + 1]
        out[i] = sum(window) / period
    return out


def ema(values, period):
    out = [None] * len(values)
    k = 2 / (period + 1)
    prev = None
    for i, v in enumerate(values):
        if prev is None:
            if i + 1 == period:
                prev = sum(values[0:period]) / period
                out[i] = prev
            continue
        prev = v * k + prev * (1 - k)
        out[i] = prev
    return out


def rsi(closes, period=14):
    out = [None] * len(closes)
    gains, losses = [], []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
        if i < period:
            continue
        window_gains = gains[i - period:i]
        window_losses = losses[i - period:i]
        avg_gain = sum(window_gains) / period
        avg_loss = sum(window_losses) / period
        if avg_loss == 0:
            out[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100 - (100 / (1 + rs))
    return out


def macd(closes, fast=12, slow=26, signal=9):
    ema_fast = ema(closes, fast)
    ema_slow = ema(closes, slow)
    macd_line = [
        (a - b) if (a is not None and b is not None) else None
        for a, b in zip(ema_fast, ema_slow)
    ]
    valid = [v for v in macd_line if v is not None]
    signal_valid = ema(valid, signal)
    signal_line = [None] * (len(macd_line) - len(valid)) + signal_valid
    histogram = [
        (m - s) if (m is not None and s is not None) else None
        for m, s in zip(macd_line, signal_line)
    ]
    return macd_line, signal_line, histogram
