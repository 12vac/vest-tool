# VestTool: step-by-step guide

This guide assumes you have never installed a userscript. It takes about ten minutes.

> **Read this first.** Vest has no demo accounts: every order the tool sends is a real order on a real account.
> The tool is free software provided **as is, with no warranty**. You alone are responsible for every order it sends.
> Try each feature at minimum size before using it for real. 
> **VestTool is not an official Vest Markets product**: it is an independent project, not made, endorsed or supported by
> Vest Markets. For problems with the tool open an issue on GitHub, not a ticket with Vest support.

---

## 1. Install Tampermonkey

Tampermonkey is a browser extension that runs small scripts ("userscripts") on the pages you choose.

1. Open the extension store of your browser and install **Tampermonkey**:
   - Chrome / Brave / Edge: Chrome Web Store → "Tampermonkey".
   - Firefox: Firefox Add-ons → "Tampermonkey".
2. **Chrome / Edge only**: recent versions block userscripts until you allow them. If Tampermonkey shows a warning, open the
   extensions page (`chrome://extensions` or `edge://extensions`) and switch on **Developer mode** (top right) or, in the
   Tampermonkey *Details* page, **Allow User Scripts**, as Tampermonkey's warning tells you.
3. Pin the Tampermonkey icon to the toolbar so you can see it.

## 2. Install VestTool

Pick **one** of the two ways.

### A. From the release (easiest)

1. Open the **Releases** page of this repository and download `vest-tool.user.js` from the latest release.
   Open it with a text editor if you want to read it: it is plain JavaScript.
2. Tampermonkey menu → **Create a new script**. Delete everything in the editor, paste the whole content of the file,
   then **File → Save**.

Quicker alternative: open the file `dist/vest-tool.user.js` in this repository, click **Raw**: Tampermonkey shows its install
page, click **Install**. (This installs the latest committed version, which may be newer than the latest release.)

### B. Build it yourself from the source

1. Install [Node.js](https://nodejs.org) 20 or later.
2. Download this repository (green **Code** button → *Download ZIP*) and unzip it.
3. Open a terminal in the folder and run `npm run check`. It runs the tests and writes `dist/vest-tool.user.js`.
4. Install that file as in A.2.

Building it yourself lets you read every line before it touches your account. The script has no dependencies.

## 3. First start

1. Open **https://next.vestmarkets.com** and log in as usual. Reload the page once.
2. The **VestTool panel** appears as a column on the right of the page (Vest's page gets narrower to make room). At the top
   is the folded panel, under it **Trade commands** and the other sections. **Alt+Shift+V** unfolds the panel to full height
   for the settings and folds it back. ⇱ detaches Trade commands as a floating window; ⇥ puts it back.
3. Wait for the four dots in the panel header to turn green: *Session*, *Feed*, *Chart*, *Checks*.
   - If *Checks* stays yellow or red, open **Settings → Diagnostics** to see which check failed.
4. The column shows the selected account on the chart's market: the position in the panel header, then Trade commands,
   Risk & targets, Trailing & breakeven, Account limits, Copier accounts, Bracket, Grid, OCO and Safe runner. Click a section
   title to fold it. Until Vest's data are in, the column says "WAITING FOR VEST DATA".
5. Every section and every setting in the panel has a **?** button: click it for an explanation.
   **Settings → Column and Trade commands: what everything does** explains every button and bar.

Do not run two copies of the script at the same time (for example an old and a new version), and switch off other scripts
or extensions that change the Vest page: they hook into the same places.

## 4. Switching orders on

Out of the box the tool **cannot open positions**. It starts with **ORDERS OFF** after every page reload.

- With Orders OFF, only closing and cancelling work: **FLAT**, **FLATTEN ALL**, **CLOSE**, the **CANCEL** menu.
- Click **ORDERS** in Trade commands and confirm to switch it on.

## 5. Your first trade at minimum size

1. Select the account: click its row in **Overview**.
2. Check that **Risk & targets** is OFF (the word next to Trade commands says **MANUAL**).
3. In Trade commands choose the smallest size (for example **0.1**: 0.1% of the maximum size the account can open).
4. Click **LONG** or **SHORT**: a market order is sent. The position line and the trade data appear.
5. Press **SL**, drag to a price below (long) or above (short) and release: the stop is sent to Vest.
   Do the same with **TP**. A yellow outline while dragging means the level is not valid; nothing is sent.
6. Drag the SL or TP label on the chart to move it. **BE** moves the stop to the entry.
7. **CLOSE** closes the position at market. **FLAT** also cancels the pending orders on that market.

### With Risk & targets

1. In the **Risk & targets** section set the risk in $, how the stop is chosen and the targets. The plan lines appear on
   the chart for the side you pick (L or S); nothing is sent yet.
2. Press **ON** next to the section title: the word next to Trade commands becomes **RISK PLAN**, and the % size and the
   LONG / SHORT buttons are off.
3. **START** on the MARKET label sends the plan's size at market with its stop and take profits. For a limit or stop entry,
   drag LIMIT or STOP from Trade commands to the price, then press START on its label.
4. The labels say **RISK ACTIVE** once the order is really placed. The plan only works on a market with no position and no
   pending order, and it is always OFF after a reload. Try partial take profits at minimum size first.

Check every step on Vest's own positions page.

## 6. Settings worth setting on day one

- **Trade commands settings → size cap**: no entry order can be larger than this % of the maximum size. Default 10%.
- **Trade commands settings → presets**: the six % buttons in Trade commands.
- **Trade commands settings → daily profit target**: your target for the day, shown in Account limits.
- **Account limits settings**: manual daily drawdown limit and profit target for accounts that have none on Vest (e.g. Instant).
  They are only the tool's: Vest does not know them.
- **Panel and column**: column width and panel style. If a Vest window or menu ends up hidden behind the column, fold the
  panel or narrow the column.
- **Button and mode colours**: colours of LIMIT, STOP, LONG, SHORT, FLAT and of the words MANUAL / RISK PLAN / RISK ACTIVE.
- **Chart display**: card style (Console, Classic or Sonar), label size, space between the last candle and the price axis,
  candle countdown, last swing high/low lines (K = candles on each side, 1-50) with the swing range in points.
  Each has a **?** that explains it.
- **Chart lines and labels**: colour, dash, width and label style of every line and label the tool draws.

Settings are stored in your browser only. Orders, trailing, auto BE and the copier always start **off** after a reload.

## 6b. Bracket, Grid, OCO and Safe runner

All four are off until you switch them on, and **Grid and Safe runner are experimental**: try them at minimum size first.
- **Bracket**: tick it and set SL (and TP) in points: every new position opened from the tool gets them. *SL / TP follow adds
  (DCA)* keeps them at those distances from AVG ALL while you add.
- **Grid**: set Entries / TP / SL ladders, look at them in PLAN (nothing is sent), then ACTIVE and START. ACTIVE is off after a reload.
- **OCO**: when one pending entry of a market fills, the other pending entries and local stops there are cancelled. The tab
  must stay open with Orders ON.
- **Safe runner**: start with VIEW to see its lines without orders; LIVE moves the real stop and closes parts at market.
  Switch trailing and auto BE off first.

## 7. Copier (optional)

1. In **Copier**, set one account to **Master** and the others to **Copy**.
2. Choose **1:1** (same size), **Cap-to-fit** (copies smaller than the master are scaled down to their equity) or **DD left**
   (copies with less drawdown left than the master are scaled down in proportion). A per-copy multiplier overrides them.
3. Switch Orders on, then press **START** and confirm.
4. Every order of the master is copied, including orders placed with Vest's own order ticket.

Limits: if the master's order fills and a copy's does not (or the other way round), the sizes drift apart and are not
re-aligned. Read the **?** of the Copier section before using it.

## 8. Updating

There is no automatic update, on purpose: nothing new runs on your account without you choosing it.

1. Download the new `vest-tool.user.js` from Releases (or build it).
2. Install it over the existing one: Tampermonkey replaces the script with the same name.
3. Reload the Vest page and check the version next to the panel title.

If you used the test build *VestTool EXP*, disable it: it shares the settings, and only one VestTool starts on the page.

Up to version 0.10.58 the script was called *Vest Tool* (with a space). Tampermonkey tells scripts apart by name, so the
renamed *VestTool* is installed **next to** the old one, not over it. Delete *Vest Tool* in the Tampermonkey Dashboard
before installing: two copies running together interfere on the Vest page.

## 9. Uninstalling

Tampermonkey Dashboard → delete *VestTool*. Then reload Vest. Optional: clear the site data of `next.vestmarkets.com`
to remove the saved panel settings.

## 10. When something is wrong

1. **FLATTEN ALL** closes everything on every account and works even with Orders OFF.
2. If numbers look wrong: **Settings → Diagnostics → Run check again** and read the results.
3. If the countdown or the clock disagree with Vest's by several seconds, your computer clock is off: the tool corrects it
   after the first new candle (until then the countdown starts with `~`), but sync the Windows / macOS clock anyway:
   the tool also uses it to renew the login tokens in time.
4. To report a bug: **Settings → Diagnostics → Copy diagnostics**, then open an issue on GitHub and paste it.
   The diagnostics contain only the *shape* of Vest's answers (field names and types), the check results and the log:
   no tokens, no account ids, no amounts. Read it before pasting anyway.

## Privacy

The script talks only to Vest's own servers. No analytics, no telemetry, no auto-update, no external libraries.
Login tokens stay in memory and are never written to disk or sent anywhere else.
