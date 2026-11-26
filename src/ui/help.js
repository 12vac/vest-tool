// Explanations shown by the "?" buttons of the panel (click to open, click again or press Esc to close).
// Plain HTML, written for someone who has never seen the tool. Keep them in step with what the code does.

const HELP = {
  // ── sections
  overview: [
    'Accounts overview',
    `<b>VestTool is unofficial</b>: an independent project, not made or supported by Vest Markets.<br>All your active Vest accounts, in dollars, one row each
    (the last row is the total).
    <ul>
      <li><b>◀ ACTIVE</b>: the account active on Vest, the one the tool's buttons trade on. Click a row to show it in the panel.</li>
      <li><b>M</b> / <b>C</b>: master / copy of the copier; <b>C x0.5</b> = copy with a multiplier.</li>
      <li><b>Equity</b> = balance + open P&L at the mark price (* = from Vest's performance series, about a minute late).</li>
      <li><b>Open</b>: P&L of the open positions. <b>Today</b>: equity now minus equity at the start of the Vest day (20:00 New York time;
      a payout made today shows as a loss). <b>Total</b>: equity minus the initial capital.</li>
      <li><b>Room to DD</b>: what you can still lose before the nearer drawdown limit (total or daily).</li>
      <li><b>Open positions</b> and <b>Pending orders</b>: of every account. Risk at SL = $ lost if every stop is hit (no fees or slippage).
      A pending order can be cancelled here, on its own account.</li>
    </ul>
    If one account has no value, the total shows "—", never a partial total.`,
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
      <li><b>DD left</b>: a copy with less drawdown left than the master is scaled down in the same proportion
      (copy left / master left), so with the same stop price it risks the same share of what it has left.
      Drawdown left = the smaller of daily and maximum, read at every entry with the open P&L. A copy with more left opens
      the master's size (never more). Unknown or used up = that entry is not copied. Adds, reductions and partial SL / TP keep
      following the copy's own position in proportion.</li>
      <li><b>Multiplier</b> (per copy): tick it and type the value with a dot (0.5 = half the master size, 2.0 = double, 1.25...).
      ON replaces 1:1 / Cap-to-fit / DD left for that account only; the size is rounded down to the market's step. Shown as x0.5 next to the
      account in Copier accounts of the column. It can be changed only with the copier stopped.</li>
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
    'Trade commands settings',
    `Settings of <b>Trade commands</b> in the column that are not set there. Sizes are a <b>percentage of the maximum size</b> the account
    can open with its leverage (100% = all the free margin). Example: 2% on an account that can open 50 NQ = 1 NQ.`,
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
    'Column and Trade commands: what everything does',
    `<ul>
      <li><b>Panel header</b> (top of the column): chart timeframe, time left before the candle closes, clock and account; under them the
      open position: side, size, entry price and P&L, then points from the entry, micro contracts and $ per point, and today's points
      (FLAT when there is no position) and, on the right, the trades of the day (<i>N trades W▲ L▼</i>, positions closed in the Vest day).
      <b>ORDERS</b> (top right) switches order sending on / off: off after every reload, nothing is sent while it is off.
      <b>COPY</b> switches the copier on / off (shown when a master and copies are set). Until Vest's data are in, the header says
      <i>WAITING FOR VEST DATA</i> and the sections appear only after that. Alt+Shift+V or – unfolds the panel for the settings and folds it back.</li>
      <li><b>Trade commands</b> (under the panel; ⇱ floats it as a window you can drag and resize, ⇥ puts it back):
      top rows = size in % of the maximum size (fractions and your six presets) or typed in the % box.
      <b>LIMIT</b> / <b>STOP</b>: press and drag to a price, the order is sent on release.
      LIMIT below the price buys, above sells. STOP above the price buys, below sells.
      A STOP is <b>local</b>: it lives in this browser tab and sends a market order when the price touches it; reloading or closing the tab removes it.
      <b>CANCEL</b> opens a menu: pending limits, local stops or all orders on this market (works with ORDERS off).
      <b>TP</b> / <b>SL</b>: press and drag to the level. <b>BE</b> moves the stop to the entry (BE+ = entry plus the profit set in Trailing &amp; breakeven).
      <b>LONG</b> / <b>SHORT</b>: market order with the chosen size; on the opposite side of an open position it reduces it (never reverses).
      <b>PARTIAL CLOSE</b> closes the % in its box, <b>CLOSE</b> closes everything; both leave the pending orders in place.
      <b>FLAT</b> cancels the local stops and every pending order on this market, then closes the position (works with ORDERS off).
      The word next to the title says how orders are sized: <b>MANUAL</b> (the % size), <b>RISK PLAN</b> or <b>RISK ACTIVE</b> (Risk &amp; targets ON).
      The <b>Copier accounts</b> table sits under it: master (M) and copies with their size on this market, open, today's and total P&L;
      its title says <i>ACTIVE</i> when the copier is on, <i>COPY OFF: accounts not copied</i> when it is off.</li>
      <li><b>Bracket (SL / TP on every new entry)</b>: SL and TP in points (sliders in steps of 5 pt) on every new entry sent from the tool.
      <i>SL / TP follow adds (DCA)</i>: with a position open, SL / TP are kept at those distances from <b>AVG ALL</b> (position + entry LIMITs
      waiting on the same side), recalculated after an add, a LIMIT filled, placed or cancelled; the SL never sits between two entries
      (if it reaches a LIMIT it goes beyond the farthest one); a SL at breakeven or in profit stays. With only LIMITs and no position nothing is moved.
      With Risk &amp; targets ON the plan's own SL / TP are used instead.</li>
      <li><b>Grid (experimental)</b>: entry LIMITs from the current price plus SL / TP ladders. OFF / <b>PLAN</b> (lines only, nothing sent) /
      <b>ACTIVE</b> after <b>START</b> (entries placed once, SL / TP follow every change; never kept after a reload). Per block (Entries, Targets,
      Stops): nearest / farthest distance in points, levels in between, distance and size curves (Manual / Custom with sliders), AVG eye
      (average line on the chart). <b>FIX</b> freezes the price the levels are measured from (TP / SL: only when nothing is open or waiting).
      Drag the nearest or farthest level on the chart: the others follow the curve. With Grid on and Entries ticked, the % buttons of
      Trade commands also set the entries' total size. Not together with Bracket <i>follow adds</i>. Try it at minimum size.</li>
      <li><b>OCO (one cancels the other)</b>: on the pending entries of a market, when one fills the others are cancelled.</li>
      <li><b>Safe runner (experimental)</b>: manages the exit of an open position in tranches (tight stop + runner, 1h trend badge in the title);
      OFF / VIEW (lines only) / LIVE. The <b>?</b> in its title explains it.</li>
      <li><b>Risk &amp; targets</b>: size from the risk in $, stop and up to four targets, drawn on the chart; ON next to the title lets
      Trade commands send the plan. The <b>?</b> next to <i>column width</i> in <i>Panel and column</i> (main panel, Layout) explains every field.</li>
      <li><b>Trailing &amp; breakeven</b>: the same settings as the panel's "Trailing stop and breakeven".</li>
      <li><b>Account limits</b>: <b>MARGIN USED</b>: margin of the open positions as a % of equity. <b>MARGIN USED + ORDERS</b>: including pending orders, and the contracts you can still open.
      <b>DAILY PROFIT TARGET</b>: today's P&L against the goal typed on its row. <b>DAILY LOSS LIMIT</b>: today's loss against the level you set. <b>MAX OPEN PROFIT</b> / <b>MAX OPEN LOSS</b>: profit / loss of the open trade (loss out of what you can lose before Vest's daily limit).
      <b>DAILY DRAWDOWN BUFFER</b> / <b>MAX DRAWDOWN BUFFER</b>: dollars left before the daily / total limit (the limit in brackets), as on Vest's page.
      <b>ACCOUNT PROFIT TARGET</b>: total P&L against the evaluation target. A row switched ON draws its level on the chart as a <b>USER</b> line (the price where it closes everything). Bars: green in profit, yellow up to 50% used, orange up to 75%, red beyond.</li>
      <li><b>Self-matching guard</b> (red / yellow strip in the header): see the <b>?</b> on the strip.</li>
      <li>Click a section title to fold it.</li>
      <li><b>Labels on the chart</b> (no tooltips there: what each one means is here): drag SL, TP, LIMIT and STOP labels (or their line)
      to move them; ✕ cancels. Position label: side and average entry, points from the entry, P&L of the selected account,
      <b>Σn</b> = P&L at that price of all n accounts holding the position; ✕ closes 100% at market WITHOUT cancelling pending orders (two clicks).
      SL / TP: the size they close (<b>ALL</b> = the whole position, it follows every add). <b>AVG ALL</b>: average entry if all entry LIMITs fill
      (with the position); <b>AVG NEXT</b>: if only the next LIMIT fills; <b>AVG NEW</b> / LONG-SHORT preview (hovering LONG / SHORT): the new
      average and size, nothing sent. <b>FAIL</b>: where the equity reaches the drawdown limit; <b>X% DRAWDOWN</b>: that share of the
      drawdown available; <b>USER</b>: an Account limits row switched ON, everything is closed (FLAT) at that price. SL / TP of a pending
      entry: <i>on Vest</i> = drag it and the LIMIT is placed again with the new leg; <i>bracket</i> / <i>this entry</i> = drag to set a
      distance for that entry only; several partial legs cannot be moved from here. <b>SR</b> labels: Safe runner tranche exits (local,
      closed at market) or where it takes over. Short segments next to the labels: orange trailing stop, light blue trailing start,
      green next step, violet BE+ / Auto BE. In Account limits: ON = FLAT at that level (OFF after a reload), the eye shows / hides its
      USER line. In Copier accounts: TEST MODE = nothing is sent to the copies; a red ◀ ACTIVE = Vest is on a copy while the copier is ON
      (new entries refused: select the master).</li>
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
  selfmatch: [
    'Self-matching guard',
    `Vest's Prop Terms of Service (section 5) allow opposite positions on your own accounts, but NOT <b>self-matching</b>: a buy and a sell
    of your own accounts executing against each other. The penalty is a permanent ban. Vest matches orders against the resting order
    book, so a LIMIT waiting on one account can be filled by an opposite order from another one. On the SAME account Vest itself
    refuses an order opposite to a pending LIMIT or a position, so only your OTHER accounts are checked.
    <ul>
      <li>Before every order the tool sends (Trade commands, LIMIT / STOP, Risk &amp; targets, Bracket, Grid, OCO, Safe runner, copier, FLAT,
      FLATTEN ALL, Account limits) it compares the order with the <b>resting orders of your other accounts</b> on the same market.
      A LIMIT is a risk when it would cross one of them (buy at or above a resting sell, sell at or below a resting buy);
      a <b>market</b> order is a risk with ANY opposite resting order, at any price.</li>
      <li><b>Red strip = blocked</b>, nothing was sent. An entry: cancel the order named in the strip, then send again. An exit (FLAT, CLOSE,
      PARTIAL CLOSE...): the button <i>CANCEL THAT ORDER, THEN CLOSE</i> cancels those orders and repeats the exit.</li>
      <li><b>Automatic exits</b> (Account limits FLAT, Safe runner, the copies following the master): nobody is there to click, so the tool
      cancels the orders in the way by itself, says which in a <b>yellow</b> strip and in the log, then sends the exit. If a cancel fails,
      the exit is not sent (red strip).</li>
      <li><b>Copier ON: the master commands.</b> An exit of the master cancels the copies' orders in the way by itself (yellow strip),
      also when you send it by hand. The master's orders are never touched: if a copy following the master could trade against
      a resting order of the master, that copy is NOT closed (red strip and log name it): close it by hand when that order is gone.</li>
      <li>If the orders of an account are not read yet or are older than 90 s, entries are blocked (wait, or <i>Reload all data</i>);
      exits go out with a <b>yellow</b> warning.</li>
      <li>SL / TP: the tool sends them as market orders when triggered, so they never rest on the book. Placing one while an opposite
      resting order exists gives a yellow warning: when it triggers, Vest sends the market order and this guard cannot stop it.</li>
      <li><b>Violet strip</b>: resting orders of two of your accounts already cross each other (e.g. placed by hand on Vest). Cancel one of them.</li>
      <li>Orders placed by hand on Vest's own ticket are not checked, and the tool sees them only at its next read (up to about 60 s).</li>
    </ul>`,
  ],
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
    'The values of the six % buttons in Trade commands, in % of the maximum size. They are shown in ascending order. The size cap still applies.',
  ],
  bracket: [
    'Bracket',
    `With <b>bracket</b> on, every NEW position opened from the tool goes to Vest with its own SL (and TP if set), in points from
    the entry: market LONG / SHORT (from the current price), LIMIT (from the limit price), local STOP when it triggers, a LIMIT
    moved on the chart. Adds to a position already open have no legs (Vest attaches them only to the first order): the position
    keeps its SL / TP. With Risk & targets ON the plan's own SL / TP are used instead. Seen on Vest with plan LIMITs: the legs of a
    LIMIT are live before the fill (a TP crossed before the fill shows "trade rejected").`,
  ],
  runner: [
    'Safe runner (experimental)',
    `It manages the EXIT of a position already open; it is not an initial stop loss (use Bracket for that).
    <ul>
      <li><b>1 · Before "start after"</b>: nothing is touched. With no stop on the position, there is none until then.</li>
      <li><b>2 · At "start after"</b> the size is split into parts, each with its own stop measured from the best price reached:
        <b>tight</b> (the rest of the size, at <i>tight</i> x ATR), <b>pause low</b> (optional, just under the last pause low of the move)
        and <b>runner</b> (at <i>runner</i> x ATR). ATR = average range of the last 14 one-minute candles.</li>
      <li><b>3 · Then</b>, in real time (at every price, not at the candle close), the stops follow the best price; they only move forward and never below
        entry + <b>profit always kept</b>.</li>
    </ul>
    The LOWEST stop (long) is the real stop on Vest for all the remaining size, so it protects with the tab closed too. The higher
    ones are kept in this tab: when the price touches one, that part is closed at market (tab open, Orders ON).<br>
    Example, LONG at 100, start 15, kept 10, tight 1 ATR, runner 2 ATR, ATR 8: the price reaches 132 →
    tight stop 124 (in this tab), runner stop 116 (on Vest), never below 110.<br>
    <b>1h trend</b>: the badge in the title shows the side in favour (EMA20 vs EMA50 on 1h). With the box ticked the runner keeps its
    wide stop only on that side, otherwise it uses the tight distance.<br>
    <b>LIVE</b> needs trailing and auto BE OFF (they move the same stop) and comes back as VIEW after a reload.`,
  ],
  srMode: ['Mode', 'OFF: nothing. VIEW: lines and status only, no orders. LIVE: moves the stop on Vest and closes the tranches at market.'],
  srAct: ['Start after / lock', 'Points of profit (best price reached, live) before the safe runner takes over; lock = profit every stop keeps at least (entry + lock).'],
  srTight: ['Tight stop', 'Distance of the tight tranche from the best price, in ATR(14) of the 1m candles. NQ tests: 0.3 to 0.5 worked best.'],
  srRun: ['Runner', 'Share of the size kept as runner and its distance from the best price in ATR. With the 1h check on, the runner is wide only when the 1h trend (EMA20 / EMA50) is in favour.'],
  srPause: ['Pause-low tranche', 'Share of the size with its stop under the low of the last pause of the move (structure). 0 = not used: in the NQ tests it did not help.'],
  srClimax: ['Climax', 'After a very large 1m candle at the top (2.5 ATR or more) the stops are tightened. NQ 1m data: after such a candle the move went on less often; in the exit tests it made no difference.'],
  manlim: ['Account limits settings', 'Settings of <b>Account limits</b> in the column that are not set there. Manual limits: for accounts that have no daily drawdown limit or profit target on Vest (e.g. Instant); switched ON with an amount, each one replaces the value read from Vest (marked "manual" in Account limits), in its bars and in its FLAT rows. Drawdown labels: the X% DRAWDOWN labels on the chart.'],
  manDay: ['Manual daily drawdown limit', 'ON + amount: the daily drawdown limit becomes this many $. DAILY DRAWDOWN BUFFER = this amount + today\'s P&L (day from 20:00 New York, or Vest\'s daily reset when the account has one). Also the range of MAX OPEN LOSS and the cap of DAILY LOSS LIMIT. It is only the tool\'s: Vest does not know it and does not close anything by itself.'],
  manTgt: ['Manual account profit target', 'ON + amount: the account profit target becomes this many $ of profit over the initial capital. ACCOUNT PROFIT TARGET shows it as "manual".'],
  dailyGoal: ['Daily profit target', 'Your profit target for the day, in dollars. The DAILY PROFIT TARGET bar in Account limits compares today\'s P&L with it.'],
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
  overlay: ['Trade overlay', 'Shows the sections and Trade commands in the column. Off = no sections and no trade buttons.'],
  dd50: ['Drawdown labels', 'Three labels X% DRAWDOWN (25, 50 and 75 by default): the price where the position (plus the entry limits that fill first) loses that % of the drawdown still available. Each one has its box (on / off) and its % (1-99; empty or out of range = the default).'],
  hideVest: [
    'Hide Vest lines',
    `Hides the position line and the SL/TP lines that Vest draws, because the tool draws its own. If the column shows a different
    account from the one open on Vest, all of Vest's order lines are hidden so they cannot be confused.`,
  ],
  chipPct: ['Label scale', 'Size of the labels on the chart (SL, TP, LIMIT, STOP, position...). 50-250.'],
  roomPx: [
    'Chart space',
    'Fixed space in pixels between the last candle and the price axis, for the labels and the trailing/BE segments (50-900, empty = 360). The chart does not shift when the labels change width.',
  ],
  countdown: [
    'Candle countdown',
    'Time left before the current candle of the chart\'s timeframe closes, shown in the panel header next to the timeframe and the clock. It follows the timeframe you choose on the chart.',
  ],
  btncol: [
    'Button and mode colours',
    `Background, text and size of LIMIT, STOP, LONG, SHORT and FLAT in Trade commands, and the colour of the mode words: MANUAL,
    RISK PLAN and RISK ACTIVE (next to Trade commands and on the plan labels; RISK ACTIVE = an order of the plan is really there: pending
    LIMIT, armed local STOP or open position). Font size of each button (default = the column's size). Saved in this browser. <b>Default colours</b> puts them all back. Keep LONG and SHORT easy to tell apart.`,
  ],
  layout: [
    'Panel and column',
    'Width of the docked column and style of this panel. Saved in this browser; nothing here sends orders.',
  ],
  dock: [
    'Dock as a column',
    `The panel becomes a full-height column on the right and Vest's page is narrowed to leave room for it, so the panel no longer covers
    the chart. Width 320-900 px. It always stays docked; only the Trade commands panel can float (⇱ in its title, ⇥ puts it back).
    <br>Under the folded panel the column holds <b>Trade commands</b> (every trade button) and the sections Risk &amp; targets,
    Trailing &amp; breakeven, Account limits (a click on a section title folds it);
    the position is shown in the panel header.
    The <b>Trailing &amp; breakeven</b> section holds the same settings as the panel's "Trailing stop and breakeven" (that section
    is hidden from the panel while the column shows its sections).
    The <b>Risk &amp; targets</b> section computes a trade plan: <b>size by</b> risk in $ (size = risk ÷ stop distance, with
    <i>count fees</i> also the entry and exit fee), % of the maximum size or a fixed quantity, never above the size cap;
    <b>stop by</b> points, ticks, the previous closed candle's low (LONG) / high (SHORT) plus the ticks you set beyond it, or a multiple
    of the ATR (14 closed candles of the chart's timeframe); targets <b>T1-T4</b> as a multiple of the risk, ticks, points, ATR multiple or
    <i>trailing</i> (that part has no TP); <b>split</b> equal, mostly on T1 or mostly on the last; <b>stops</b> one for the whole size or one
    per target. Leverage is Vest's, read only. The plan is drawn on the chart with labels <i>RISK PLAN</i>, or <i>RISK ACTIVE</i> (black) once the order is really placed.
    The plan starts from the market price, or from your pending LIMIT / armed plan STOP of that side (it follows them when you move them).
    Drag <b>ENTRY</b> to plan from another price: the stop and the targets move with it. Drag <b>plan SL</b> to change the stop:
    the risk in $ stays, the size is recalculated and the stop rule becomes Points.
    <b>ON / OFF</b> next to the section title: OFF = MANUAL, Trade commands use the % size and no plan is drawn. ON = the plan drives
    Trade commands: the % size and the LONG / SHORT buttons are off. The entry label says MARKET, LIMIT or STOP and the side:
    <b>START</b> on the MARKET label sends the plan size WITH its SL and TP at market; a LIMIT or STOP dragged from Trade
    commands only moves the entry there (nothing is sent) and START on its label places it with the plan (a STOP is armed LOCALLY in this
    tab: when touched it sends a market order with the plan; reload or Orders off = gone); <b>✕</b> puts the entry back at the market price. <b>LONG SIDE / SHORT SIDE</b> choose the side shown.
    Next to Trade commands: MANUAL, RISK PLAN (ON, nothing placed) or RISK ACTIVE (ON, pending LIMIT, armed STOP or open position).
    Moving a pending LIMIT or plan SL cancels it and places it again recalculated (the lines disappear until the new LIMIT is on the chart).
    Under a pending LIMIT the section lists the SL / TP that Vest's data shows for it.
    While you drag LIMIT or STOP from Trade commands the plan follows it live. Plan orders work only on a market with no position and no
    pending order. ON is never kept after a reload. If a planned position appears without a stop, the tool adds the stop at the plan's
    price (while the page stays open). To look at a plan without any risk of sending, keep ORDERS OFF.
    Partial targets are sent as legs with their size: try them at minimum size first. The copier copies only legs without size.
    The small arrows next to the target values change them by 0.25 (ticks by 1). The <b>Chart space</b> section sets the space between
    the last candle and the price axis (the same setting as label space in Chart display; arrows ±10 px).
    The Trade commands ⇱ button detaches it as a floating window you drag by the title bar and resize (width and height) from the bottom-right corner, with the copier accounts inside; ⇥ puts it back.
    Unfolding the panel (– or Alt+Shift+V) fills the column for the settings and hides the sections until you fold it again; a floating
    Trade commands panel stays on the screen.
    The lines and labels always stay on the chart.
    <br>If a Vest window or menu ends up hidden or cut, fold the panel or narrow the column, and report it with the diagnostics.`,
  ],
  pstyle: [
    'Panel style',
    '<b>Console</b>: larger text and fields, section titles with a coloured bar, bigger buttons. <b>Classic</b>: compact. Only the look changes.',
  ],
  theme: [
    'Column style',
    `<b>Console</b>: the same look as the Console panel. <b>Classic</b>: the original design. <b>Sonar</b>: amber on black, square cards with cut corners, segmented bars and a
    monospaced font. Applies to the sections of the column and to Trade commands. Only colours and fonts change: every button stays in the same place and does the same thing.
    Green and red keep their meaning (profit / loss, buy / sell). Your line and quantity colours are kept.`,
  ],
  hilo: [
    'Last swing high / low',
    `Two short lines next to the price axis: the <b>last swing high</b> and the <b>last swing low</b> on the chart's timeframe.
    A swing high is a candle whose high is above the K candles before it and not below the K candles after it (the swing low the other way round).
    K = the number in the field (1-50, default 2; a value outside is taken as the nearest limit). Higher K = only bigger swings, but a swing
    is confirmed only after K more candles: with K = 45 on 1m a swing appears 45 minutes after its high or low, and it must be the highest
    (lowest) of 91 candles. The candles read go back 300 candles: with a big K there may be no confirmed swing in them (the line then
    is missing on that side).
    If the price goes past the last swing, the line follows the price until a new swing is confirmed.
    The <i>swing range</i> option in <i>Chart display</i> switches the lines on / off; under it the points between the last swing high and low.
    Colours in Line colours. The candles (the last 300) are read from Vest's chart once a second; if the chart does not provide them the lines
    are not shown (see the log).`,
  ],
  qty: ['Quantities on the chart', 'Colour, size and bold of the trade size shown in the panel header, in Trade commands and on the position label.'],
};

module.exports = { HELP };
