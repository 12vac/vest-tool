# VestTool

> **Unofficial.** VestTool is an independent, community project. It is not a Vest Markets product and is not made,
> endorsed or supported by Vest Markets. Do not ask Vest support for help with it: open an issue here.

A Tampermonkey userscript for [Vest Markets](https://next.vestmarkets.com) (prop trading on perpetuals).
It adds a panel docked on the right with balances and P&L in dollars, trade commands with drag-and-drop SL/TP, breakeven,
FLAT and entry orders, risk-based sizing with up to four take profits, a fixed SL / TP bracket on every entry, entry grids and
OCO entries, trailing stop / auto breakeven, an experimental "safe runner" exit, a copier that mirrors one account's orders onto
others, a candle countdown and the last swing high / low.

**New here? Read the [step-by-step guide](GUIDE.md).** Independent project: not made, endorsed or supported by Vest Markets.

> **Real money.** Vest has no demo accounts. Every order this script sends is a real order. Try every feature at minimum
> size first. The script is provided as is, with no warranty: you are responsible for every order it sends.

## Safety design
- Runs only on `next.vestmarkets.com`. Talks only to Vest's own servers: no telemetry, no analytics, no auto-update
  (`@grant none`, no `@updateURL` / `@downloadURL` / `@require`). The build refuses to produce a file that breaks these rules.
- Tokens stay in memory: never written to storage, never logged, never sent anywhere but Vest.
- **Orders switch**: off after every page reload. While it is off the script can only *close and cancel* (FLAT, FLATTEN ALL,
  the CANCEL menu); it can never open or modify a position. Switching it on asks for confirmation.
- **Copier**: off after every page reload, never re-armed automatically. Starting it requires Orders ON and a confirmation.
- **Self-matching guard**: Vest allows opposite positions on different accounts but bans self-matching (your own orders
  filling against each other). Before every order (Trade commands, plans, Bracket, Grid, OCO, Safe runner, copier, FLAT,
  FLATTEN ALL, Account limits) the tool compares it with the pending orders of your OTHER accounts on the same market (Vest
  already refuses the opposite side on the same account). A LIMIT that would cross one of them, or a market order with any
  opposite pending order there, is a risk:
  - entries are refused, with a red strip in the header naming the order in the way;
  - manual exits are refused too, with a *CANCEL THAT ORDER, THEN CLOSE* button;
  - automatic exits (Account limits FLAT, Safe runner, copies following the master) cancel the orders in the way, say so,
    then close; if a cancel fails, the exit is not sent;
  - if another account's orders are not read yet or older than 90 s, entries are refused and exits go out with a warning;
  - a violet strip shows pending orders of two accounts that already cross (for example placed by hand on Vest);
  - with the copier ON the master commands: the master's exits cancel the copies' pending orders in the way, and the master's
    orders are never touched. A copy whose exit could hit a master's pending order is NOT closed: a red strip names it, and
    you close it by hand once that order is gone.
  Orders placed with Vest's own ticket are not checked.
- Only the order endpoints the tool needs are allowed; everything else (withdrawals, account settings...) is blocked in code.

## Installation
The [step-by-step guide](GUIDE.md) covers Tampermonkey, installing from a release and updating. To build from the source:
1. Install [Node.js](https://nodejs.org) 20 or later.
2. In this folder run `npm run check`: it runs the tests and creates `dist/vest-tool.user.js`.
3. Tampermonkey → *Create a new script* → delete everything → paste the content of `dist/vest-tool.user.js` → *Save*.
4. Reload the Vest page. After every new build repeat step 3, overwriting the existing script, and reload.

Disable other scripts or extensions that hook into Vest: they touch the same places (WebSocket, fetch, XHR).
Do not run two copies of this script at the same time (for example an old and a new version).

## Using it
- **Panel**: a full-height column docked on the right of the page; Vest's page is narrowed to make room. Its header shows
  the chart timeframe, the candle countdown, the clock and the account, and under them the open position (side, size, entry,
  points, P&L, contracts, points of the day). Alt+Shift+V (or –) unfolds the panel to full height for the settings and folds
  it back. Click an account row to select that account. Every **?** button opens an explanation; Esc or a click elsewhere
  closes it.
- **Panel sections**: Accounts overview, Copier accounts, Trade commands settings (size cap, presets, daily profit target),
  Account limits settings (manual limits for accounts without them on Vest, e.g. Instant), Panel and column, Chart display,
  Chart lines and labels (colour, dash, width and label style of everything drawn), Button and mode colours, SL/TP calculator,
  the guide to every button, Diagnostics. The header also has the ORDERS / COPY switches and the trades of the day
  (N trades, wins ▲, losses ▼). Until Vest's data are in, the column shows "WAITING FOR VEST DATA".
- **Column under the folded panel** (for the chart's market and the selected account), each section foldable by its title:
  - *Trade commands*: size in % of the maximum size (never above the size cap), LIMIT and STOP (drag them onto the chart),
    LONG / SHORT (market), TP / SL / BE, the CANCEL menu (pending limits, local stops or all orders on the market),
    PARTIAL CLOSE / CLOSE, FLAT, ORDERS and COPY switches. ⇱ detaches it as a floating window you can drag anywhere;
    ⇥ puts it back. The *Copier accounts* (master and copies with size and P&L) sit right under it and float with it.
  - *Risk & targets*: see below.
  - *Trailing & breakeven*: the same settings as in the panel.
  - *Account limits*: MARGIN USED, MARGIN USED + ORDERS, DAILY PROFIT TARGET, DAILY LOSS LIMIT, MAX OPEN PROFIT / LOSS,
    DAILY DRAWDOWN BUFFER, MAX DRAWDOWN BUFFER, ACCOUNT PROFIT TARGET (information only). Each row has its own eye button;
    a row switched ON draws its level on the chart.
  - *Bracket (SL / TP on every new entry)*: see below.
  - *Grid (experimental)*, *OCO (one cancels the other)*, *Safe runner (experimental)*: see below.
  - Section titles show **ACTIVE** while that section is on.
- **Clock and countdown** follow Vest's clock, not the computer's: the offset is measured when a new candle appears on the
  chart. Until then the countdown starts with `~`. If the log says the PC clock is off, sync the Windows clock: the tool also
  relies on it for login token renewal.
- **Last swing high / low**: two short lines next to the price axis. A swing high is a candle whose high is above the K
  candles before it and not below the K after it (K = 1-50 in *Chart display*, default 2); it is confirmed K candles later.
  If the price goes past it, the line follows the price until a new swing is confirmed. The swing range (points between the
  two) is shown in *Chart display*.
- **Risk & targets** (column section): size by risk in $, % of the maximum or fixed quantity (optionally counting fees,
  never above the size cap); stop by points, ticks, previous candle low/high ± ticks or ATR multiple; up to 4 targets T1-T4
  (× risk, ticks, points, × ATR or trailing without TP), split equally, mostly on T1 or mostly on the last.
  Its **ON / OFF** button (next to the title) turns the plan on. With it ON the % size and the LONG / SHORT buttons are off:
  START on the MARKET LONG / SHORT label sends the plan's size with its SL and TP legs at market; a LIMIT or STOP dragged from
  Trade commands moves the entry there and START on its label places it (the STOP is local: at the touch it sends a market
  order with the plan). Labels say RISK PLAN, then RISK ACTIVE once the order is really placed; the same word shows next to
  Trade commands (MANUAL when OFF). Drag ENTRY to plan from another price, drag the plan SL to change the stop (same risk in $,
  the size follows). Only on a market with no position and no pending order; always OFF after a reload.
- **Bracket**: with it on, every new position opened from the tool goes to Vest with its own SL (and TP if set), in points
  from the entry (sliders in steps of 5 pt): market LONG / SHORT, LIMIT, local STOP when it triggers. Adds have no legs (Vest
  attaches them only to the first order). *SL / TP follow adds (DCA)*: while a position is open, SL / TP are kept at the bracket
  distances from AVG ALL (the position plus the entry LIMITs waiting on the same side), recalculated after every add, fill,
  LIMIT placed or cancelled; the SL never sits between two entries, and a SL already at breakeven or in profit is not moved.
  With only pending LIMITs and no position it moves nothing.
- **Grid (experimental)**: entry LIMITs plus TP and SL ladders, each with nearest / farthest distance, levels in between and
  distance / size curves. OFF / PLAN (lines only, nothing sent) / ACTIVE (after START; never restored after a reload). FIX
  measures from a price frozen now; dragging the nearest or farthest level reshapes the ladder; one average line per ladder.
  The % buttons in Trade commands set the entry size. Not available while Bracket "follow adds" is on. Minimum size first.
- **OCO**: on the pending entries of a market, when one entry fills (or a local STOP triggers) the other pending entries and
  local stops of that market are cancelled. With OCO on a local STOP may be armed on the side opposite a pending LIMIT
  (breakout both ways). Needs the tab open and Orders ON: a LIMIT filled while the tab is closed leaves the others in place.
- **Safe runner (experimental)**: manages the exit of an open position. After a profit you set, the size is split into a tight
  part, an optional pause-low part and a runner, each with a stop that follows the best price at a distance in ATR of the 1m
  candles (the runner stays wide only when the 1h trend, EMA20 vs EMA50, agrees). The lowest stop (long) is the real stop on
  Vest; the others live in this tab and close their part at market. OFF / VIEW (lines only) / LIVE; LIVE needs trailing and
  auto BE off and comes back as VIEW after a reload. It reads the chart's candles from Vest. Minimum size first.
- **Button and mode colours** (Settings): background, text and size of LIMIT, STOP, LONG, SHORT, FLAT and the colour of
  MANUAL / RISK PLAN / RISK ACTIVE.
- **Column style** (*Chart display*): *Console* (default, same look as the panel), *Classic* or *Sonar* (amber on black, cut
  corners, segmented bars, monospaced font). Only colours and fonts change; buttons stay where they are.
- **TP / SL**: press the button in Trade commands and drag to the level; releasing sends the order. Existing labels can be dragged to
  move them. A yellow border means the level is not valid (wrong side of the price or closer than 2 ticks) and nothing is sent.
  Esc cancels the drag.
- **BE**: moves the stop to the entry (or entry + the BE+ profit set in the panel). Only when the price is already past it.
- **FLAT**: cancels the local stops and every pending order on the chart's market, then closes the position. Works with Orders OFF.
- **CLOSE / PARTIAL CLOSE**: closes all or part of the position at market and leaves the pending orders in place.
- **STOP entries are local**: Vest has no native entry stop, so the stop lives in this browser tab and sends a market order when
  the price (read every 0.5 s) touches it. Closing the tab, reloading or switching Orders off removes it. It may fill late
  and with slippage, and it does not trigger on a price older than 3 s.
- **FLATTEN ALL** (panel): on every account cancels every pending order and closes every position at market, then checks
  again. Asks for confirmation. Works with Orders OFF.
- **Labels on the chart**: AVG ALL (average entry if all entry limits fill), AVG NEXT (if only the next one fills), FAIL (price
  where the equity reaches the drawdown limit, counting the limits that fill on the way), X% DRAWDOWN (25, 50, 75 by default), and while the mouse is
  on LONG / SHORT the previews AVG NEW and FAIL NEW; trailing / BE segments. Labels have no hover tooltips: what each one means is in
  *Settings → Column and Trade commands: what everything does*, under "Labels on the chart".
- **Copy diagnostics** (panel): copies to the clipboard only the *shapes* of Vest's responses (field names and types), the
  startup check results and the log. No tokens, ids or amounts.

## Copier
In the panel's Copier section each account is *—*, *Master* or *Copy*. Sizing is **1:1** (same size) or **Cap-to-fit**
(proportional to equity, only scaling down, with a 5% margin) or **DD left** (a copy with less drawdown left than the master
is scaled down in proportion, never up); a per-copy **multiplier** overrides them for that account. With the copier ON the tool
trades only from the master. Every successful order of the master is mirrored on the copies,
whether it comes from this tool or from Vest's own order ticket: market entries and adds, reductions, closes, FLAT, pending
LIMIT/STOP orders and their cancellations, SL/TP. If the master's position disappears (SL/TP hit, closed on the site), the copies
on that market are closed. FLATTEN ALL is not copied (it already closes everything).
Known limits: if a master order fills and a copy order does not (or the other way round), sizes drift apart and are not
re-aligned; an order that Vest accepts and then rejects later leaves the copies open.

## Definitions (all in dollars)
- Balance = free collateral + position collateral + pending order collateral.
- Equity = balance + open P&L at the mark price. Without a mark: equity from Vest's performance series (marked with *, ~1 minute late).
- Today's P&L = equity − equity at the start of the Vest day (20:00 New York), from Vest's performance series.
  A payout made today shows as a loss.
- Session P&L = equity − equity at the first value read today (local date). Reset with its button.
- Total P&L = equity − initial account capital.
- Room to the limit = equity − the nearer of the total and daily drawdown limits.
- Totals add up the accounts; if one account has no value the total shows "—", never a partial total.

## Development
- `src/domain/`: pure functions (dollars, ticks, account model, copier plans). Tests in `test/*.test.js`: `npm test`.
- `src/core/`: session, transport, feed, REST reads, orders, copier. `src/chart/`: chart and overlay. `src/ui/`: panel (`help.js` holds the texts of the **?** buttons).
- `build.mjs`: bundles the modules into one file with no external dependencies, then runs the safety checks.
- Offline test page: `node test/harness/serve.mjs` (optional port as argument, default 5179), then open
  http://127.0.0.1:5179/test/harness/index.html
  (simulated Vest: fake tokens, API, feed and chart).

## Bugs and ideas
Bugs: open an issue with the output of *Settings → Diagnostics → Copy diagnostics*. Ideas are welcome too; this is a
one-person spare-time project, so bugs come first and not every request will be built.

## Licence
GNU General Public License v3.0 (see `LICENSE`). Provided as is, without warranty of any kind. Nothing in this project is
financial advice.
