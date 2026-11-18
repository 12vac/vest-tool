# VestTool

> **Unofficial.** VestTool is an independent, community project. It is not a Vest Markets product and is not made,
> endorsed or supported by Vest Markets. Do not ask Vest support for help with it: open an issue here.

A Tampermonkey userscript for [Vest Markets](https://next.vestmarkets.com) (prop trading on perpetuals).
It adds an account panel with balances and P&L in dollars, a trade overlay on the chart (drag-and-drop SL/TP, breakeven,
FLAT, entry orders), trailing stop / auto breakeven, a copier that mirrors one account's orders onto others, a candle
countdown, the last swing high / low and a volatility heatmap (ATR on 1h, 30m, 15m, 5m, 1m over the same hours).

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
- **Panel**: Alt+Shift+V collapses/expands it; drag it by its title bar. Click an account row to select that account.
  It is split into foldable sections (Overview, Trade, Copier, Accounts and positions, then the Settings: Order size,
  Trailing stop and breakeven, Chart display, Line colours, SL/TP calculator, Chart cards guide, Diagnostics).
  Every **?** button opens an explanation of that section or setting; click it again, press Esc or click elsewhere to close it.
  The chart cards have no tooltips: the *Chart cards: what everything does* section explains every button and bar.
- **Trade overlay** (right side of the chart, for the chart's market and the selected account):
  - *First card*: chart timeframe, time left before the candle closes, clock, side, size, entry, P&L, points,
    Orders ON/OFF, Copy ON/OFF, FLAT.
  - *Second card*: size presets in % of the maximum size the account can open (never above the size cap set in the panel),
    LIMIT and STOP (drag them onto the chart), LONG / SHORT (market), TP / SL / BE, and a CANCEL menu (pending limits,
    local stops or all orders on the chart's market).
  - *Third card*: PARTIAL CLOSE / CLOSE, MARGIN USED, MARGIN + ORDERS, DAILY GOAL, OPEN LOSS, DAILY LOSS LEFT, DRAWDOWN LEFT,
    PROFIT TARGET.
  - *Copier card*: master and copy accounts with open size and P&L.
  - *Swing and volatility card*: SWING RANGE (points between the last swing high and low) and the volatility heatmap.
- **Clock and countdown** follow Vest's clock, not the computer's: the offset is measured when a new candle appears on the
  chart. Until then the countdown starts with `~`. If the log says the PC clock is off, sync the Windows clock: the tool also
  relies on it for login token renewal.
- **Last swing high / low**: two short lines next to the price axis. A swing high is a candle whose high is above the K
  candles before it and not below the K after it (K = 1-50 in *Chart display*, default 2); it is confirmed K candles later.
  If the price goes past it, the line follows the price until a new swing is confirmed.
- **Volatility heatmap**: for 1h, 30m, 15m, 5m and 1m, the ATR of the last N candles divided by the ATR over the same span
  of hours (e.g. 14 h = 14 candles of 1h, 840 of 1m). Above 1 = that timeframe is speeding up; a burst usually lights up
  1m first. Blue below 0.75, grey normal, orange from 1.25, red from 1.75. Built from the chart's own candles: timeframes
  shorter than the chart's show "—" (put the chart on 1m to see all five).
- **TP / SL**: press the button on the card and drag to the level; releasing sends the order. Existing labels can be dragged to
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
  where the equity reaches the drawdown limit, counting the limits that fill on the way), 50% DRAWDOWN, and while the mouse is
  on LONG / SHORT the previews AVG NEW and FAIL NEW; trailing / BE segments.
- **Copy diagnostics** (panel): copies to the clipboard only the *shapes* of Vest's responses (field names and types), the
  startup check results and the log. No tokens, ids or amounts.

## Copier
In the panel's Copier section each account is *—*, *Master* or *Copy*. Sizing is **1:1** (same size) or **Cap-to-fit**
(proportional to equity, only scaling down, with a 5% margin). Every successful order of the master is mirrored on the copies,
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
