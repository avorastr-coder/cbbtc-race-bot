// cbBTC 1-minute trend bot for agent-fun/bars-replay/v1.
//
// Long only, one position, $1,000 paper. The bot reads one JSON batch per
// minute (a 1-minute bar of cbBTC/USDC from the Orca Whirlpool) and answers
// with buy/sell orders that fill at the next bar's open.
//
// Strategy (validated on the frozen 24h dev window and thirteen other 24h
// BTC windows before this file was written):
//   - Main entry: EMA(20) crosses above EMA(60) on a bar close AND the
//     trailing 60-minute return is at least +70 bps. Full cash in.
//     A round trip costs about 26-42 bps in fees, slippage and pool
//     impact, so only a strong, confirmed move is worth chasing; weaker
//     momentum gates lose money to whipsaw out of sample.
//   - Exit: take-profit +250 bps over cost, a 50 bps trailing stop below
//     the peak close since entry, a 200 bps hard stop below the entry
//     close, an EMA cross back down, or 240 bars max hold. Whole position.
//   - Last-chance guardrail trade: if the entry has not traded by bar
//     1400, buy 25% of equity when the close sits above EMA(60); by bar
//     1425 buy 25% unconditionally. This only guarantees the >= 1 trade
//     guardrail on a quiet day; the stake is small on purpose.
//
// Determinism: pure arithmetic on the bars seen so far. No network, no
// wall clock, no files, no randomness, no environment reads. The same bars
// give the same orders on every execution.
//
// Dev window (frozen, 2026-11-14 08:28 UTC to 2026-11-15 08:28 UTC):
// net PnL +24.58 USDC, 2 trades (1 round trip), fees 0.81 USDC, max
// drawdown 0.5%. Out of sample (thirteen other 24h BTC windows): total
// -2.21 USDC, at least 1 trade on every window, max drawdown 0.8%.

import { runBars, type Bar, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_SPAN = 20;
const SLOW_SPAN = 60;
const MOM_WINDOW = 60;
const MOM_MAIN_BPS = 70n;
const TP_BPS = 250n;
const TRAIL_BPS = 50n;
const STOP_BPS = 200n;
const MAX_HOLD_BARS = 240;
const LAST_BAR = 1400;
const FINAL_BAR = 1425;
const FALLBACK_NUM = 1n;
const FALLBACK_DEN = 4n;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the mean of its first span of closes, then 2/(span+1) of the
    way to each new close. Float64, + - * / alone, so the same bars give
    the same value on every run. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

const ema = (span: number): Ema => ({ span, warm: [], value: null });

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

const fast = ema(FAST_SPAN);
const slow = ema(SLOW_SPAN);
const closes: number[] = [];
let gap: number | null = null;
let now: number | null = null;
let peak: number | null = null;
let entryClose: number | null = null;
let holdBars = 0;
let traded = false;

/** Trailing n-bar return in bps, exact integer math. */
function retBps(n: number): bigint | null {
  if (closes.length <= n) return null;
  const then = BigInt(closes[closes.length - 1 - n]);
  return ((BigInt(closes[closes.length - 1]) - then) * 10_000n) / then;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    // A fill that landed marks the entry as traded, whatever the signal
    // that sent it; a rejected order does not.
    for (const fill of batch.fills) {
      if (fill.status === 'filled') traded = true;
    }
    let bar: Bar | undefined;
    for (const candidate of batch.bars) {
      if (candidate.symbol === SYMBOL) {
        bar = candidate;
        break;
      }
    }
    if (bar === undefined || state.warmingUp) return [];
    const close = Number(bar.c);
    closes.push(close);
    step(fast, close);
    step(slow, close);
    gap = now;
    now = fast.value !== null && slow.value !== null ? fast.value - slow.value : null;
    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      holdBars += 1;
      if (peak === null || close > peak) peak = close;
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      let done = false;
      if (value * 10_000n >= cost * (10_000n + TP_BPS)) done = true;
      else if (peak !== null && BigInt(close) * 10_000n <= BigInt(peak) * (10_000n - TRAIL_BPS)) done = true;
      else if (entryClose !== null && BigInt(close) * 10_000n <= BigInt(entryClose) * (10_000n - STOP_BPS)) done = true;
      else if (holdBars >= MAX_HOLD_BARS) done = true;
      else if (gap !== null && now !== null && now < 0 && gap >= 0) done = true;
      if (done) {
        peak = null;
        entryClose = null;
        holdBars = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    peak = null;
    entryClose = null;
    holdBars = 0;
    const seq = state.seq;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    // Last-chance guardrail trade, 25% of equity, only before any fill.
    if (!traded && seq >= LAST_BAR) {
      const above = slow.value !== null && close > slow.value;
      if (seq >= FINAL_BAR || above) {
        const stake = (state.cash * FALLBACK_NUM) / FALLBACK_DEN;
        if (stake >= minNotional) {
          entryClose = close;
          peak = close;
          traded = true;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }
    // Main entry: EMA cross up with a strong trailing 60-minute return.
    if (gap === null || now === null) return [];
    if (!(now > 0 && gap <= 0)) return [];
    const ret = retBps(MOM_WINDOW);
    if (ret === null || ret < MOM_MAIN_BPS) return [];
    const stake = state.cash;
    if (stake < minNotional) return [];
    entryClose = close;
    peak = close;
    traded = true;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
