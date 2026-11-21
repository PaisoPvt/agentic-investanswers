# MVP demo script (M4-06)

For the client review on Fri 4 Dec, rehearsed on Thu 3 Dec. Run it on **staging** once it exists (M2-16); until then on the AWS dev environment (https://d7rks7pj8vbkj.cloudfront.net). Each step says what to show and what it proves. About 20 minutes.

## Before the call
- `pnpm acceptance --url <environment> --env <name>` with `AIA_AGENT_KEY` set to an agent key for that environment. Keep the report (`reports/acceptance/…md`) open in a second window; step 8 walks through it.
- Sign in once in a fresh browser window so the chart opens without delay. Have an agent key ready for step 6.

## 1. Sign in (M2-08, M2-14)
Open the site, create an account or sign in. **Proves:** the app's own sign-in works, and every request carries a principal (CLAUDE.md rule 4).

## 2. BTC chart, live (M2-05, M2-04)
BTCUSD 1m: the newest bar moves with trades; a new bar appears at each minute. Switch to 1h and 4h. **Proves:** bars come from cache, live bars arrive over one WebSocket, every timeframe is built from 1-minute bars (rule 2).

## 3. Scroll back two years (M2-06)
On 1h, drag the chart left for a while. History keeps coming, without jumps. **Proves:** paged history from the store, no gaps.

## 4. The SMA indicator (M3-02, M3-05)
Indicators → SMA; change Length in the settings dialog; Apply; remove it. The line and the Long and Short markers come from the server. **Proves:** indicators run on the server and only drawn outputs reach the browser (rule 5; the leak test, check 4, proves it in CI).

## 5. Freshness badge and plans (UI-02, M2-09)
Point at the Live badge in the status line. Pick a timeframe the plan does not include: the chart refuses it with the upgrade link. **Proves:** freshness is visible to the trader, and plan checks apply to every request.

## 6. An agent (M4-01, M4-02)
Create an agent key in the chart, then show `pnpm agent-check --url <environment>` (or an MCP client): it lists instruments, reads bars and the SMA's output, is refused outside its plan and when it tries to write. **Proves:** agents read through MCP with the same plan checks as people, read-only.

## 7. Usage records (M4-04)
`GET /usage?subject=<agent key id>` with your session token, or `pnpm usage --account <email>`: every request of step 6 is there. **Proves:** every human and agent request is recorded.

## 8. The acceptance report (M4-06)
Walk through the four checks: bar parity, freshness, indicator and backtest parity, agents. Each one says pass, fail or pending, and what it proves. **Proves:** the MVP's acceptance checks, in one command anyone can rerun.

## If something fails during the call
Say what failed, show the check that covers it, and move on; note it for the follow-up. Do not debug live.
