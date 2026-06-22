# Glance

A tiny always-on-top widget that can see your screen. Hit a hotkey, type a question ("what does this error mean?", "summarize the section I'm reading"), and it screenshots your screen for you and answers — no manual screenshotting.

## Setup

You need Node.js installed (https://nodejs.org), then:

```bash
cd glance
npm install
cp .env.example .env     # then paste your Anthropic API key into .env
npm start
```

Get an API key at https://console.anthropic.com (Settings → API Keys). Each question costs a fraction of a cent with the default model.

### Testing with a shared key (for collaborators)

If someone has sent you a key to test with (rather than getting your own):

```bash
git clone https://github.com/michael2010liu/monet.git
cd monet
npm install
cp .env.example .env
```

Then open `.env` and paste the key after `ANTHROPIC_API_KEY=` (replace the `sk-ant-...` placeholder), save, and run `npm start`.

The key should reach you privately — a password manager or a secure message, never committed to the repo or posted in chat. `.env` is gitignored, so your key stays on your machine and is never pushed.

## Using it

- **Cmd/Ctrl + Shift + Space** — show/hide the widget from anywhere
- Type a question and press **Enter** — the amber dot pulses while it captures your screen and thinks
- **Esc** or ✕ — hide it (the hotkey brings it back)
- Drag the top bar to move it anywhere on screen
- Follow-up questions remember the conversation; each new question takes a fresh screenshot

The widget excludes itself from screenshots, so Claude only ever sees what's behind it.

## First-run permissions (macOS)

macOS will ask for **Screen Recording** permission the first time. Grant it in System Settings → Privacy & Security → Screen Recording, then restart the app.

## Privacy note

Every question sends a screenshot of your primary display to the Anthropic API. Hide or close anything you don't want included (password managers, private messages) before asking.

## Tweaks

In `.env`:
- `GLANCE_MODEL` — e.g. `claude-haiku-4-5-20251001` for cheaper/faster, `claude-opus-4-8` for harder questions
- `GLANCE_HOTKEY` — any Electron accelerator string, e.g. `Alt+Space`
