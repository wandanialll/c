# Chess Double Round-Robin Tracker

Static site for tracking a **double round-robin** chess tournament (everyone plays everyone twice — once as White, once as Black).

- **Time control**: 10+10
- **Players**: 8 (easy to change)
- **Elo**: Tournament-relative, starts at 1200 for everyone, K=32
- **Storage**: Players & settings in repo JSON files; match results in [jsonbin.io](https://jsonbin.io)
- **Hosting**: GitHub Pages

## Features
- Live standings (Score, W-D-L, Elo + Δ, Buchholz)
- Full pre-generated schedule (14 rounds for 8 players)
- Click any game or use form to enter/edit results
- Admin password protection for writes
- Dark chess-themed UI, mobile-friendly
- Progress bar & quick stats

## Quick Start

### 1. Clone / download this folder
Put it in a new GitHub repository.

### 2. Edit players
Open `data/players.json` and replace the placeholder names:

```json
{
  "players": [
    { "id": "p1", "name": "Alice" },
    { "id": "p2", "name": "Bob" },
    ...
  ]
}
```

IDs must stay unique (`p1`–`p8` is fine). You can add more later (rebuild schedule by clearing matches).

### 3. jsonbin.io setup (required for persistence)

1. Create a free account at [jsonbin.io](https://jsonbin.io)
2. Create a new **private** bin with this initial content:

```json
{
  "matches": [],
  "meta": {
    "lastUpdated": null,
    "version": 0
  }
}
```

3. Copy the **Bin ID**
4. Go to API Keys → create an **Access Key** with permissions:
   - Bins: Read
   - Bins: Update
5. Open `app.js` and replace the two constants at the top:

```js
const JSONBIN_BIN_ID = "your_bin_id_here";
const JSONBIN_ACCESS_KEY = "your_access_key_here";
```

6. (Optional but recommended) Change the admin password:

```js
const ADMIN_PASSWORD = "your-secret-password";
```

### 4. Deploy to GitHub Pages

1. Push the repo to GitHub
2. Settings → Pages → Source: Deploy from a branch → `main` / root
3. Wait ~1 minute, open the URL

### 5. Usage

- Anyone can **view** standings and schedule
- Click **Admin Login** and enter the password to enable saving results
- Click a game in the Schedule tab (or use Enter Result tab) to set 1-0 / 0-1 / ½-½
- Results are saved to jsonbin immediately

## Adding more players later

1. Edit `data/players.json` (add new `{ "id": "p9", "name": "..." }`)
2. Clear all matches in jsonbin (or create a new bin)
3. Refresh — the schedule regenerates automatically for the new number of players

Note: number of rounds becomes `2 × (N-1)`.

## File structure

```
chess-rr-tracker/
├── index.html
├── style.css
├── app.js
├── data/
│   ├── players.json
│   └── settings.json
└── README.md
```

## How the schedule is generated

Uses a standard circle / Berger-style method:
- First cycle: N-1 rounds, balanced colors
- Second cycle: same pairings with colors reversed

All pairings are fixed at load time. Only results are stored in the bin.

## Elo calculation

- Starts at 1200 for every player
- After each game (processed in round order):  
  `new = old + K × (score - expected)`  
  where `expected = 1 / (1 + 10^((oppElo - myElo)/400))`
- K = 32 (suitable for 10+10 rapid)
- Purely relative / fun metric for this tournament only

## Security notes

- The Access Key is public (visible in source). It only has Read + Update on this one bin.
- Anyone who knows the admin password can write results.
- Do **not** put your Master Key in the frontend.
- For higher security you could add a simple serverless function later, but for club use this is fine.

## Customization

- Change K-factor or name in `data/settings.json`
- Colors / fonts in `style.css`
- Default password and bin keys in `app.js`

Enjoy your tournament! ♟️
