// Explanations shown by the "?" buttons of the panel (click to open, click again or press Esc to close).
// Plain HTML, written for someone who has never seen the tool. Keep them in step with what the code does.

const HELP = {
  // ── sections
  overview: [
    'Overview',
    `<b>VestTool is unofficial</b>: an independent project, not made or supported by Vest Markets.<br>Totals of all your active Vest accounts, in dollars.
    <ul>
      <li><b>Today</b>: equity now minus equity at the start of the Vest day (20:00 New York time). A payout made today shows as a loss.</li>
      <li><b>Open</b>: P&L of the open positions at the mark price.</li>
      <li><b>Total</b>: equity minus the initial capital of the account.</li>
      <li><b>Session</b>: equity now minus the first value read today on this computer (reset it in Diagnostics).</li>
    </ul>
    If one account has no value, the total shows "—", never a partial total.
    Click an account to <b>select</b> it: the chart cards and the Trade section follow the selected account.`,
  ],
  flatall: [
    'FLATTEN ALL',
    `Emergency button. On <b>every</b> account it cancels every pending order, then closes every position at market,
    then checks again and repeats on whatever is left. It asks for confirmation and cannot be undone.
    It works even with Orders OFF: it can only close and cancel, never open.`,
  ],
  trade: [
    'Trade (selected account, chart market)',
    `<ul>
      <li><b>MARGIN</b>: margin used by the positions and pending orders of the account, as a share of its equity,
      and how many contracts you could still open with the leverage.</li>
      <li><b>RISK</b>: how much of the drawdown the open trade is using (its open loss) and how much is left before the limit.</li>
      <li><b>Pending orders</b>: Vest limit orders and local stops of this account. Each one can be cancelled here.</li>
    </ul>`,
  ],
  copier: [
    'Copier',
    `Copies every order of one account (<b>Master</b>) onto other accounts (<b>Copy</b>): market entries and adds, reductions,
    closes, FLAT, pending LIMIT/STOP orders and their cancellations, SL/TP. Orders placed with Vest's own order ticket are copied too.
    If the master's position disappears (stop hit, closed on the site), the copies on that market are closed.
    <ul>
      <li><b>1:1</b>: each copy opens the same size as the master.</li>
      <li><b>Cap-to-fit</b>: a copy smaller than the master is scaled down to its equity (5% safety margin);
      a copy that is the same size or larger opens the master's size.</li>
      <li><b>START</b> needs Orders ON and asks for confirmation. The copier switches off at every page reload and when Orders go off.</li>
      <li>The dot next to each account: green = nothing open, red = positions or pending orders, yellow = an empty Vest placeholder,
      grey = not read yet.</li>
    </ul>
    Limits: if the master's order fills and a copy's does not (or the other way round), the sizes drift apart and are not re-aligned.
    FLATTEN ALL is not copied (it already closes everything everywhere).`,
  ],
  accounts: [
    'Accounts and positions',
    `<ul>
      <li><b>Balance</b> = free collateral + collateral of positions + collateral of pending orders.</li>
      <li><b>Equity</b> = balance + open P&L at the mark price. A * means the value comes from Vest's performance series (about a minute late) because a price was missing.</li>
      <li><b>Room to DD limit</b> = equity minus the nearer of the total and daily drawdown limits: what you can still lose before the account fails.</li>
      <li><b>Risk at SL</b>: dollars lost if every stop of the position is hit. Fees and slippage are not included.</li>
    </ul>`,
  ],
  size: [
    'Order size and daily goal',
    `Sizes on the second chart card are a <b>percentage of the maximum size</b> the account can open with its leverage
    (100% = all the free margin). Example: 2% on an account that can open 50 NQ = 1 NQ.`,
  ],
  stops: [
    'Trailing stop and breakeven',
    `These move the <b>real stop on Vest</b> for you. They work only with Orders ON, only on the selected account's position on the
    chart market, and only while this browser tab is open: if the tab is closed the stop stays where it was last moved.
    Trailing and auto BE switch off at every page reload. With the copier on, every stop move is copied too (one order per copy).`,
  ],
  display: [
    'Chart display',
    'What the tool draws on the chart and how big it is. Nothing here sends orders.',
  ],
  colours: [
    'Line colours',
    `Colour, dash and width of every line the tool draws. The name on each chart label takes the colour of its line.
    <ul>
      <li><b>AVG ALL</b>: average entry if every entry limit fills, on top of the open position.</li>
      <li><b>AVG NEXT</b>: average entry if only the next entry limit fills.</li>
      <li><b>AVG NEW</b>: preview while the mouse is on LONG/SHORT: average entry after adding that size.</li>
      <li><b>FAIL</b>: price where the equity reaches the drawdown limit and the account fails, counting the entry limits that fill on the way.</li>
      <li><b>50% DRAWDOWN</b>: price where the position loses half of the drawdown still available.</li>
      <li><b>FAIL NEW</b>: preview while the mouse is on LONG/SHORT: the fail price after adding that size.</li>
      <li><b>Last swing high / low</b>: the two short lines next to the price axis.</li>
      <li><b>Trailing / BE segments</b>: short segments between the candles and the labels showing where the trailing stop is,
      where it starts, where it moves next, the BE+ level and the auto BE trigger.</li>
    </ul>`,
  ],
  calc: [
    'SL / TP calculator',
    `Calculation only, it sends nothing. Type a dollar amount and it shows the price on the tick.
    The stop is rounded toward the entry (the loss is never above the amount); the target is the nearest tick.
    Fees and slippage are not included: a stop is filled at market and can cost more.
    <b>Manual</b> lets you choose side, quantity and entry (empty entry = mark price).`,
  ],
  guide: [
    'Chart cards: what everything does',
    `<ul>
      <li><b>First card</b>: chart timeframe, time left before the candle closes, clock, side, size, entry, P&L and points of the trade, micro contracts and $ per point.
      <b>ORDERS</b> switches order sending on/off (off after every reload). <b>COPY</b> switches the copier on/off.
      <b>FLAT</b> cancels the local stops and every pending order on this market, then closes the position (works with ORDERS off).</li>
      <li><b>Second card</b>: top rows = size in % of the maximum size (0.1-0.9 and your presets) or typed in the box.
      <b>LIMIT</b> / <b>STOP</b>: press and drag to a price, the order is sent on release.
      LIMIT below the price buys, above sells. STOP above the price buys, below sells.
      A STOP is <b>local</b>: it lives in this browser tab and sends a market order when the price touches it; reloading or closing the tab removes it.
      <b>CANCEL</b> opens a menu: pending limits, local stops or all orders on this market (works with ORDERS off).
      <b>TP</b> / <b>SL</b>: press and drag to the level. <b>BE</b> moves the stop to the entry (BE+ = entry plus the profit set in the panel).
      <b>LONG</b> / <b>SHORT</b>: market order with the chosen size; on the opposite side of an open position it reduces it (never reverses).</li>
      <li><b>Third card</b>: <b>PARTIAL CLOSE</b> closes the % in the box, <b>CLOSE</b> closes everything; both leave the pending orders in place.
      <b>MARGIN USED</b>: margin of the open positions as a % of equity. <b>MARGIN + ORDERS</b>: including pending orders, and the contracts you can still open.
      <b>DAILY GOAL</b>: today's P&L against the goal set below. <b>OPEN LOSS</b>: loss of the open trade out of what you can lose before Vest's daily limit.
      <b>DAILY LOSS LEFT</b> / <b>DRAWDOWN LEFT</b>: dollars left before the daily / total limit (the limit in brackets), as on Vest's page.
      <b>PROFIT TARGET</b>: total P&L against the evaluation target. Bars: green in profit, yellow up to 50% used, orange up to 75%, red beyond.</li>
      <li><b>Swing and volatility card</b>: SWING RANGE = points between the last swing high and low; VOLATILITY = the heatmap described in Chart display.</li>
      <li><b>Copier card</b>: master (M) and copies with their size on this market, open, today's and total P&L.</li>
      <li><b>Labels on the chart</b>: drag SL, TP, LIMIT and STOP labels (or their line) to move them; ✕ cancels. On the position label ✕ closes 100% at market (two clicks).</li>
    </ul>`,
  ],
  diag: [
    'Diagnostics',
    `<ul>
      <li><b>Startup check</b>: reads from Vest (no orders) whether its answers still look as the tool expects. "fail" = numbers may be wrong.</li>
      <li><b>Log</b>: what the tool did, kept only in memory.</li>
      <li><b>Reload all data</b>: re-reads accounts, positions and orders from Vest.</li>
      <li><b>Reset session P&L</b>: the Session column starts again from the current equity.</li>
      <li><b>Copy diagnostics</b>: copies to the clipboard only the shape of Vest's answers (field names and types), the check results and the log. No tokens, ids or amounts: safe to share when asking for help.</li>
    </ul>`,
  ],
  // ── single settings
  orders: [
    'Orders switch',
    `While it is <b>off</b> the tool cannot open or change a position: only FLAT, FLATTEN ALL and the cancel buttons work.
    Switching it on asks for confirmation. It is off after every page reload. Vest has no demo: these are real orders.`,
  ],
  capPct: [
    'Size cap',
    'No entry order (LIMIT, STOP, LONG/SHORT) can be larger than this % of the maximum size. A safety net against a wrong click.',
  ],
  presets: [
    'Size presets',
    'The values of the six % buttons on the second card, in % of the maximum size. They are shown in ascending order. The size cap still applies.',
  ],
  dailyGoal: ['Daily goal', 'Your profit target for the day, in dollars. The DAILY GOAL bar on the third card compares today\'s P&L with it.'],
  trailing: [
    'Trailing stop',
    `<ul>
      <li><b>unit</b>: values in price points (pt) or in dollars ($, divided by the size).</li>
      <li><b>start after</b>: profit from the entry after which trailing starts.</li>
      <li><b>pullback</b>: the stop stays this far from the best price reached.</li>
      <li><b>step</b>: the stop moves only when it can advance at least this much (fewer orders). Empty = one tick.</li>
    </ul>
    The stop only moves forward and only once it is in profit. If the price goes past the level and there is no stop
    (for example Vest rejected the move), the position is closed at market, but only while the current price is in profit.
    If the size or the entry changes (an add, a reduction), trailing starts again from zero.`,
  ],
  breakeven: [
    'Breakeven (BE+ and auto BE)',
    `<ul>
      <li><b>BE+</b>: the BE button puts the stop at the entry <b>plus</b> this profit instead of exactly at the entry.</li>
      <li><b>auto BE after</b>: when the profit reaches this value the tool moves the stop to the BE level by itself, once per position.</li>
    </ul>
    After a BE (button or automatic), changing the profit field moves the stop to the new level, unless trailing has taken over the stop.`,
  ],
  lines: ['Lines on the chart', 'Draws the tool\'s own lines and labels on the chart (position, SL/TP, orders, averages, fail price).'],
  overlay: ['Trade overlay', 'Shows the cards on the right of the chart. Off = no cards and no buttons on the chart.'],
  dd50: ['50% drawdown label', 'Shows the 50% DRAWDOWN label: the price where the position (plus the entry limits that fill first) loses half of the drawdown still available.'],
  hideVest: [
    'Hide Vest lines',
    `Hides the position line and the SL/TP lines that Vest draws, because the tool draws its own. If the cards show a different
    account from the one open on Vest, all of Vest's order lines are hidden so they cannot be confused.`,
  ],
  blockPct: ['Card scale', 'Size of the cards on the chart, everything in proportion. 100 = original design, 50-250.'],
  chipPct: ['Label scale', 'Size of the labels on the chart (SL, TP, LIMIT, STOP, position...). 50-250.'],
  roomPx: [
    'Label space',
    'Fixed space in pixels between the last candle and the cards, for the labels and the trailing/BE segments (150-900, empty = 360). The chart does not shift when the labels change width.',
  ],
  countdown: [
    'Candle countdown',
    'Time left before the current candle of the chart\'s timeframe closes, shown on the first card between the instrument and the clock. It follows the timeframe you choose on the chart.',
  ],
  hilo: [
    'Last swing high / low',
    `Two short lines between the cards and the price axis: the <b>last swing high</b> and the <b>last swing low</b> on the chart's timeframe.
    A swing high is a candle whose high is above the K candles before it and not below the K candles after it (the swing low the other way round).
    K = the number in the field (1-50, default 2; a value outside is taken as the nearest limit). Higher K = only bigger swings, but a swing
    is confirmed only after K more candles: with K = 45 on 1m a swing appears 45 minutes after its high or low, and it must be the highest
    (lowest) of 91 candles. The candles read go back 300 candles: with a big K there may be no confirmed swing in them (the line then
    is missing on that side).
    If the price goes past the last swing, the line follows the price until a new swing is confirmed.
    Colours in Line colours. The candles (the last 300) are read from Vest's chart once a second; if the chart does not provide them the lines
    are not shown (see the log).`,
  ],
  atr: [
    'Volatility heatmap',
    `A card under the others with five boxes: <b>1h, 30m, 15m, 5m, 1m</b>. Each box compares the volatility of the last few candles of that
    timeframe with its volatility over the <b>same span of hours</b> for all five (e.g. 14 hours = 14 candles of 1h, 168 of 5m, 840 of 1m).
    <ul>
      <li>Big number: ATR of the last N candles ÷ ATR over the hours. Above 1 = that timeframe is moving more than usual.</li>
      <li>Colour: blue below 0.75 (quiet), grey normal, orange from 1.25, red from 1.75.</li>
      <li>Small number: ATR in points over the hours. * = fewer hours of candles than asked.</li>
    </ul>
    A burst usually lights up 1m first, then 5m, 15m... Reading the row from right to left shows how far it has spread.
    ATR = average true range: average of max(high − low, |high − previous close|, |low − previous close|), closed candles only.
    The candles come from Vest's chart: timeframes shorter than the chart's show — (put the chart on 1m to see all five).
    The top line of the card shows the points between the last swing high and low (the two lines next to the price axis).`,
  ],
  qty: ['Quantities on the chart', 'Colour, size and bold of the trade size shown on the first card, the second card and the position label.'],
};

module.exports = { HELP };
