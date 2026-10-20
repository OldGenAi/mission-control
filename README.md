# Mission Control

**Your own AI command center: a self-hosted agentic OS you actually control.**

Mission Control is a personal AI system you run on your own machine. You chat with **Dave**, your always-on AI agent, who can answer questions, use tools (web search, files, shell), remember what matters, and, when a job is bigger than a quick chat, hand it off to a **pipeline**: a reliable, repeatable workflow run by a team of specialist AI workers.

It runs on **your hardware**, with **your choice of model**: a free local model (via LM Studio / Ollama) or a paid cloud model (via OpenRouter). Your data, your keys, and your conversations stay on your machine.

> Built by [OldGenAI](#about). Free and open source under the [MIT license](#license).

---

## Table of contents

- [What it is (in plain English)](#what-it-is-in-plain-english)
- [Chat vs. Pipelines: the core idea](#chat-vs-pipelines-the-core-idea)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security & privacy](#security--privacy)
- [Roadmap: what's coming](#roadmap-whats-coming)
- [License](#license)
- [About](#about)

---

## What it is (in plain English)

Most AI tools are a chat box hosted by someone else. Mission Control is different:

- **You host it.** It runs in Docker on your own computer. Nothing goes to a server you don't control unless *you* choose a cloud model or use the web tools.
- **It's an "agentic OS."** A fancy way of saying it's not just a chatbot, it's an AI that can *act*: search the web, read and write files, run tasks, remember things across days, and coordinate a team of sub-agents to get bigger jobs done.
- **You pick the brain.** Point it at a free local model on your own machine, or a powerful cloud model, and switch any time.

There are two ways to get work done: **chat** with Dave, or run a **pipeline**. The difference between them is the heart of the whole thing.

---

## Chat vs. Pipelines: the core idea

**Dave (chat)** is for conversation and one-off tasks. Ask him anything; he'll answer, look things up, edit a file, or remember something for you. Like talking to a very capable assistant.

**Pipelines** are for work you want done *reliably, repeatedly, in parallel, and on the record.* A pipeline is a saved recipe that runs the same steps every time with a budget, optional human approval, and a tidy sourced report at the end, carried out by a **team** of specialist AI workers running at once.

| | **Dave (chat)** | **Pipeline** |
|---|---|---|
| Best for | one-off questions, exploring | repeatable jobs, bigger tasks |
| How it runs | conversational, improvised | the same defined steps every time |
| Cost & safety | bounded per chat turn | hard budgets, timeouts, approval gates |
| Teamwork | one agent at a time | a team of workers in parallel |
| Output | a chat transcript | structured, sourced reports (artifacts) |
| Do you need to be there? | yes | no, it runs in the background and tells Dave when it's done |

The short version: **Dave is the chat; a pipeline is that same intelligence turned into a dependable, repeatable process**: the difference between asking a clever friend a question and running a documented workflow your work relies on. And you don't have to choose: Dave can *launch* pipelines for you.

---

## Features

**The agent & the team**
- **Dave**, your Tier-1 personal agent: chat, 17 built-in tools, and persistent memory.
- An **Orchestrator** and **specialist workers** (Researcher, Coder) that pipelines use to split a job up and run parts in **parallel**.

**Pipelines (deterministic workflows)**
- Ready-made presets: research a topic, summarise a URL, draft a document, review code, build a daily digest, fact-check a claim, and more.
- **Budgets & guardrails:** token/cost ceilings, timeouts, and an automatic stop-on-repeated-failure so nothing runs away.
- **Approval gates:** pause a pipeline for your sign-off before it continues.
- **Artifacts:** every result is saved as a typed, sourced document linked to the run that produced it, so you can trust and trace it.

**Models & providers**
- Run **local** models (LM Studio, Ollama, llama.cpp: anything OpenAI-compatible) for free and private, or **OpenRouter** for cloud models (pay-as-you-go).
- **Instances:** save multiple model setups and switch the active one in a click.
- **Two models at once:** give pipelines their own model. Add an instance with Workspace set to Pipeline, and pipelines (including ones Dave launches) run on it while you keep chatting with Dave on a different instance, e.g. a big cloud model on a research job while a fast local model handles your chat.

**Live Monitor**
- A real-time HUD showing your agents, their context usage, tokens, cost, latency, and the background watchdog so you always see what's happening.
- The pipeline flow panel shows your **most recent run**, so a finished run stays on screen. If a step is red, that means the last run failed there. It is history, not a live error, and it clears as soon as the next run starts.

**Memory**
- Short-term **daily notes** that fade after a week, and **milestones** that stick around. Dave decides what's worth keeping.

**Built-in tools**
- Web search (Brave) and safe web fetch, workspace-scoped file read/write/edit, and an optional shell (`exec`) tool that is **off by default** and asks for an explicit, informed confirmation before you can ever turn it on.

---

## How it works

Three tiers, each with a clear job:

```
   You
    │  chat
    ▼
 ┌──────────┐    launches    ┌──────────────┐    spawns    ┌──────────────────────────┐
 │   Dave   │ ─────────────▶ │ Orchestrator │ ───────────▶ │  Workers                 │
 │ (Tier 1) │   a pipeline   │  (Tier 2)    │   a team     │  Researcher · Coder      │
 │  chat +  │                │ coordinates  │              │  (Tier 3: one job each)  │
 │ 17 tools │ ◀───────────── │              │ ◀─────────── │                          │
 └──────────┘  final report  └──────────────┘   artifacts  └──────────────────────────┘
```

Under the hood:
- A **gateway** (Node.js / TypeScript) talks to the UI over a local WebSocket and runs the agents.
- **Pipelines** are simple YAML files describing the steps.
- Everything (sessions, artifacts, memory, logs) is stored locally in **SQLite**.
- The **UI** is a React app.
- It's all packaged with **Docker**.

---

## Requirements

You'll need three things installed on your machine before you start:

- **Docker Desktop** (with Docker Compose). Runs the gateway.
- **Node.js 22 or newer**. Runs the UI and the gateway.
- **A model provider**, one of:
  - **LM Studio**, **Ollama**, or **llama.cpp** on your machine (free, private), or
  - an **OpenRouter** API key (cloud models, pay-as-you-go).

*(Optional)* a **Brave Search** API key, if you want the web-search tool.

> Tested on Windows (WSL2) with Docker. macOS and Linux have not been tested yet: with Docker and Node installed they should work, but treat that as unconfirmed.

---

## Prerequisites

If you're missing Docker or Node.js, install them first. Otherwise skip to Quick start.

### Docker Desktop

- **Windows / macOS:** download the installer from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/). On Windows, enable "Use WSL 2 based engine" during setup (it's on by default in modern versions).
- **Linux:** follow the [Docker Engine install guide](https://docs.docker.com/engine/install/) for your distro.

**Make sure Docker Desktop is running before you run any `docker compose` command.** On Windows and macOS, if the whale icon isn't in your system tray, Docker isn't started and every docker command will fail with a "cannot connect to daemon" error. Start it, wait for the icon to be steady, then continue.

### Node.js 22+

Install from [nodejs.org](https://nodejs.org/en/download/) (LTS release is fine), or via a package manager:

- **Windows (PowerShell):** `winget install OpenJS.NodeJS.LTS`
- **macOS (Homebrew):** `brew install node`
- **Linux:** see [NodeSource distributions](https://github.com/nodesource/distributions) or use [nvm](https://github.com/nvm-sh/nvm).

Verify with `node --version`. Must be v22 or higher.

---

## Quick start

1. **Clone the repo**
   ```bash
   git clone https://github.com/OldGenAi/mission-control.git
   cd mission-control
   ```

2. **Set up your provider.** Copy the environment template:
   ```bash
   cp gateway/.env.example gateway/.env
   ```
   Then open `gateway/.env` and edit the values based on which provider you're using. Pick ONE path:

   **A. LM Studio (local).** This is the default in the template. Start LM Studio and load a model in its UI, then leave these values as-is:
   ```
   PROVIDER=local
   LOCAL_PROVIDER_URL=http://127.0.0.1:1234/v1
   ```

   **B. Ollama (local).** Ollama uses a different port. Start Ollama and pull a model (e.g. `ollama pull llama3.2`), then set:
   ```
   PROVIDER=local
   LOCAL_PROVIDER_URL=http://127.0.0.1:11434/v1
   ```

   **C. OpenRouter (cloud).** Pay-as-you-go, no local server needed. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys), then set:
   ```
   PROVIDER=openrouter
   OPENROUTER_API_KEY=sk-or-v1-...
   ```

   *(Secrets like the gateway token are generated automatically on first boot. You don't set those.)*

3. **Start the gateway**
   ```bash
   docker compose up -d --build
   ```
   If this fails with "cannot connect to the Docker daemon", Docker Desktop isn't running. Start it and try again.

4. **Start the UI**
   ```bash
   cd app
   npm install
   npm run dev
   ```

5. **Open it** at **http://localhost:5173** and say hello to Dave.

---

## Configuration

Almost everything is configured **in the UI** (Settings), with no file editing after first boot:

- **Providers & keys**: add your OpenRouter / Brave keys; they're stored encrypted at rest.
- **Instances**: create model setups (e.g. one local, one cloud) and switch the active one in the sidebar.
- **Exec tool**: off by default; turning it on requires an explicit, informed confirmation.

The only things that live in `gateway/.env` are first-boot defaults (provider + URL/keys). After that, your settings are the source of truth.

---

## Security & privacy

Mission Control is built to be **safe to self-host**:

- **Your data stays local.** Sessions, memory, and artifacts live in a SQLite database on your machine.
- **Locked-down gateway.** Every connection is checked by origin + a required token, with replay protection. Nothing talks to it without permission. The gateway listens on `127.0.0.1` only, unless you set `GATEWAY_HOST` yourself.
- **Encrypted secrets.** API keys are encrypted at rest, masked in the UI, and redacted from logs. The encryption key is stored next to them in `~/.missioncontrol`, so this protects against a copied settings file, not against someone with full access to your account.
- **Shell is opt-in and not a sandbox.** The `exec` tool is off by default and gated behind an explicit confirmation. When on, commands start in your workspace folder, run without your API keys in their environment, and are time-limited, but a command can still read any file the gateway can. Treat it like handing Dave a terminal.
- **Hardened by design.** Parameterised database queries; web-fetch protection against internal-network probing (private and reserved addresses are refused, including after DNS lookup and on redirects); file tools that can't leave the workspace or read credential files such as `.env`; and dependencies checked with `npm audit` (run `cd gateway && npm audit` yourself to see the current state).

Run on a local model and leave the web tools unused, and **nothing leaves your machine.** (Web search sends your queries to Brave, and web fetch contacts the sites you ask for.)

---

## Roadmap: what's coming

Mission Control is actively developed. Planned updates include:

- **Per-command approval for the shell tool**: a prompt to approve or reject each individual shell command in real time, for an extra layer of human control.
- **Direct Anthropic support**: a native Claude adapter (today you can already reach Claude and other models via OpenRouter).
- **Multiple local servers**: point different instances at different local model servers at the same time.
- **Skills & Plugins**: extend Dave with reusable capabilities and third-party add-ons.
- **Channel integrations**: talk to Dave from Telegram, Discord, Slack, WhatsApp, iMessage, and Signal.
- **Visual pipeline builder**: design pipelines in the UI, no YAML required.
- **Smarter automation**: self-healing retries, and automatic "escalation" from cheap models to powerful ones only when a task needs it.

> Want something on this list sooner, or have an idea? Open an issue.

---

## Troubleshooting

**Model selector says "Loading…" and never shows any models.**
Your local server isn't reachable at the URL in `gateway/.env`. Check:
- Is LM Studio / Ollama / llama.cpp actually running?
- Does `LOCAL_PROVIDER_URL` in `gateway/.env` match its port? (LM Studio = 1234, Ollama = 11434, llama.cpp = 8080 by default.)
- Hover the model selector in the UI. The tooltip shows the exact URL the gateway tried and the error it got.
- After changing `.env`, restart the gateway: `docker compose up -d --build`.

**`docker compose up` fails with "cannot connect to the Docker daemon".**
Docker Desktop isn't running. Start it and wait for the whale icon to be steady in your system tray, then retry.

**`npm install` fails, or `npm run dev` doesn't launch.**
Check your Node version: `node --version` must be v22 or higher. If it's older, install a current LTS from the Prerequisites section above.

**On Windows, `docker compose` runs but can't reach my local model server.**
Docker on Windows uses WSL2. If your WSL is on the older "NAT" networking mode, `127.0.0.1` inside the container won't reach Windows-side services. Enable "mirrored" networking in `%UserProfile%\.wslconfig` (add `[wsl2]` and `networkingMode=mirrored`), then `wsl --shutdown` and start Docker Desktop again.

---

## License

[MIT](LICENSE) © 2026 OldGenAI. Free to use, modify, and share. Just keep the copyright notice.

---

## About

Mission Control is built by **OldGenAI**, making powerful, self-hosted AI approachable for everyone, not just engineers.
