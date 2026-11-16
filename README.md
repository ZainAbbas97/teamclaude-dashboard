# TeamClaude Dashboard

A live, minimal dashboard for a local [TeamClaude](https://github.com/KarpelesLab/teamclaude) proxy.

- Combined weekly usage bar across your Claude accounts
- Per-account 5-hour and weekly usage with reset times
- Last chat (by project folder) on each account
- Click an account for tokens, cache hit rate, models, folders and recent requests
- Weekly forecast: when usage runs out, per account or combined, with reset markers
- Banked usage-limit resets (full and Fable)
- Hot reload: edit anything in `public/` and the page refreshes

Zero dependencies. Needs Node 20+ and a running TeamClaude proxy (default `http://127.0.0.1:3456`).

## Run

```bash
npm start        # opens http://localhost:4567
npm run dev      # restarts when server.js changes
```

Start at login (macOS LaunchAgent):

```bash
npm run service:install
npm run service:status
npm run service:uninstall
```

## Setup

1. Run TeamClaude with its activity log on, so "Last chat" works:
   `teamclaude server --headless --activity-log ~/Library/Logs/teamclaude-activity.log`
2. Optional: `cp labels.example.json labels.json` and map your account emails to short names.

## Configuration (environment variables)

| Variable | Default |
|---|---|
| `PORT` | `4567` |
| `TEAMCLAUDE_URL` | `http://127.0.0.1:3456` |
| `TEAMCLAUDE_ACTIVITY_LOG` | `~/Library/Logs/teamclaude-activity.log` |
| `POLL_MS` | `2000` |
| `OPEN_BROWSER` | set to `1` to open the page on start |

The server listens on `127.0.0.1` only and forwards just the dashboard's own button clicks to TeamClaude.
