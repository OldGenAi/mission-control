# Mission Control

**Your own AI command center a self-hosted agentic OS you actually control.**

Mission Control is a personal AI system you run on your own machine. You chat with **Dave**, your always-on AI agent, who can answer questions, use tools (web search, files, shell), remember what matters, and when a job is bigger than a quick chat hand it off to a **pipeline**: a reliable, repeatable workflow run by a team of specialist AI workers.

It runs on **your hardware**, with **your choice of model** a free local model (via LM Studio / Ollama) or a paid cloud model (via OpenRouter). Your data, your keys, and your conversations stay on your machine.

> Built by [OldGenAI](#about). Free and open source under the [MIT license](#license).

---

## Table of contents

- [What it is (in plain English)](#what-it-is-in-plain-english)
- [Chat vs. Pipelines — the core idea](#chat-vs-pipelines--the-core-idea)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Security & privacy](#security--privacy)
- [Roadmap — what's coming](#roadmap--whats-coming)
- [License](#license)
- [About](#about)

---

## What it is (in plain English)

Most AI tools are a chat box hosted by someone else. Mission Control is different:

- **You host it.** It runs in Docker on your own computer. Nothing goes to a server you don't control unless *you* choose a cloud model.
- **It's an "agentic OS."** A fancy way of saying it's not just a chatbot it's an AI that can *act*: search the web, read and write files, run tasks, remember things across days, and coordinate a team of sub-agents to get bigger jobs done.
- **You pick the brain.** Point it at a free local model on your own machine, or a powerful cloud model and switch any time.

There are two ways to get work done: **chat** with Dave, or run a **pipeline**. The difference between them is the heart of the whole thing.

---

## Chat vs. Pipelines the core idea

**Dave (chat)** is for conversation and one-off tasks. Ask him anything; he'll answer, look things up, edit a file, or remember something for you. Like talking to a very capable assistant.

**Pipelines** are for work you want done *reliably, repeatedly, in parallel, and on the record.* A pipeline is a saved recipe that runs the same steps every time with a budget, optional human approval, and a tidy sourced report at the end carried out by a **team** of specialist AI workers running at once.

| | **Dave (chat)** | **Pipeline** |
|---|---|---|
| Best for | one-off questions, exploring | repeatable jobs, bigger tasks |
| How it runs | conversational, improvised | the same defined steps every time |
| Cost & safety | bounded per chat turn | hard budgets, timeouts, approval gates |
| Teamwork | one agent at a time | a team of workers in parallel |
| Output | a chat transcript | structured, sourced reports (artifacts) |
| Do you need to be there? | yes | no it runs in the background and tells Dave when it's done |

The short version: **Dave is the chat; a pipeline is that same intelligence turned into a dependable, repeatable process** the difference between asking a clever friend a question and running a documented workflow your work relies on. And you don't have to choose: Dave can *launch* pipelines for you.

---

## Features

**The agent & the team**
- **Dave**, your Tier-1 personal agent chat, 17 built-in tools, and persistent memory.
- An **Orchestrator** and **specialist workers** (Researcher, Coder) that pipelines use to split a job up and run parts in **parallel**.

**Pipelines (deterministic workflows)**
- Ready-made presets: research a topic, summarise a URL, draft a document, review code, build a daily digest, fact-check a claim, and more.
- **Budgets & guardrails:** token/cost ceilings, timeouts, and an automatic stop-on-repeated-failure so nothing runs away.
- **Approval gates:** pause a pipeline for your sign-off before it continues.
- **Artifacts:** every result is saved as a typed, sourced document linked to the run that produced it so you can trust and trace it.

**Models & providers**
- Run **local** models (LM Studio, Ollama, llama.cpp — anything OpenAI-compatible) for free and private, or **OpenRouter** for cloud models (pay-as-you-go).
- **Instances:** save multiple model setups and switch the active one in a click.

**Live Monitor**
- A real-time HUD showing your agents, their context usage, tokens, cost, latency, and the background watchdog so you always see what's happening.

**Memory**
- Short-term **daily notes** that fade after a week, and **milestones** that stick around Dave decides what's worth keeping.

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
 │  chat +  │                │ coordinates  │              │  (Tier 3 — one job each) │
 │ 17 tools │ ◀───────────── │              │ ◀─────────── │                          │
 └──────────┘  final report  └──────────────┘   artifacts  └──────────────────────────┘
```

Under the hood:
- A **gateway** (Node.js / TypeScript) talks to the UI over a local WebSocket and runs the agents.
- **Pipelines** are simple YAML files describing the steps.
- Everything sessions, artifacts, memory, logs is stored locally in **SQLite**.
- The **UI** is a React app.
- It's all packaged with **Docker**.

---

## Requirements

- **Docker** (with Docker Compose) — runs the gateway.
- **Node.js 18+** runs the UI.
- **A model provider**, one of:
  - **LM Studio / Ollama** on your machine (free, private), or
  - an **OpenRouter** API key (cloud models, pay-as-you-go).
- *(Optional)* a **Brave Search** API key, if you want the web-search tool.

> Tested on Windows (WSL2) with Docker. macOS and Linux work the same way.

---

## Quick start

1. **Clone the repo**
   ```bash
   git clone https://github.com/OldGenAi/mission-control.git
   cd mission-control
   ```

2. **Set up your provider**
   ```bash
   cp gateway/.env.example gateway/.env
   ```
   Open `gateway/.env` and set **either**:
   - `PROVIDER=local` and start a model in LM Studio (default URL `http://127.0.0.1:1234/v1`), **or**
   - `PROVIDER=openrouter` and paste your key into `OPENROUTER_API_KEY`.

   *(Secrets like the gateway token are generated automatically on first boot you don't set those.)*

3. **Start the gateway**
   ```bash
   docker compose up -d --build
   ```

4. **Start the UI**
   ```bash
   cd app
   npm install
   npm run dev
   ```

5. **Open it** at **http://localhost:5173** and say hello to Dave.

---

## Configuration

Almost everything is configured **in the UI** (Settings) no file editing after first boot:

- **Providers & keys** — add your OpenRouter / Brave keys; they're stored encrypted at rest.
- **Instances** — create model setups (e.g. one local, one cloud) and switch the active one in the sidebar.
- **Exec tool** — off by default; turning it on requires an explicit, informed confirmation.

The only things that live in `gateway/.env` are first-boot defaults (provider + URL/keys). After that, your settings are the source of truth.

---

## Security & privacy

Mission Control is built to be **safe to self-host**:

- **Your data stays local.** Sessions, memory, and artifacts live in a SQLite database on your machine.
- **Locked-down gateway.** Every connection is checked by origin + a required token, with replay protection nothing talks to it without permission.
- **Encrypted secrets.** API keys are encrypted at rest, masked in the UI, and never written to logs.
- **Sandboxed shell.** The `exec` tool is off by default, confined to your workspace folder, stripped of your secrets, time-limited, and gated behind an explicit confirmation.
- **Safe by construction.** Parameterised database queries, web-fetch protection against internal-network probing, file tools that can't escape the workspace, and zero known-vulnerable dependencies.

Run entirely on a local model and **nothing ever leaves your machine.**

---

## Roadmap — what's coming

Mission Control is actively developed. Planned updates include:

- **Run two models at once, for different jobs.** Use one model/instance for a background pipeline *while* chatting with Dave on a different one e.g. a big cloud model crunching a research pipeline as a fast local model handles your chat. (The foundation is already in place; this exposes it in the UI.)
- **Per-command approval for the shell tool** — a prompt to approve or reject each individual shell command in real time, for an extra layer of human control.
- **Direct Anthropic support** — a native Claude adapter (today you can already reach Claude and other models via OpenRouter).
- **Multiple local servers** — point different instances at different local model servers at the same time.
- **Skills & Plugins** — extend Dave with reusable capabilities and third-party add-ons.
- **Channel integrations** — talk to Dave from Telegram, Discord, Slack, WhatsApp, iMessage, and Signal.
- **Visual pipeline builder** — design pipelines in the UI, no YAML required.
- **Smarter automation** — self-healing retries, and automatic "escalation" from cheap models to powerful ones only when a task needs it.

> Want something on this list sooner, or have an idea? Open an issue.

---

## License

[MIT](LICENSE) © 2026 OldGenAI. Free to use, modify, and share just keep the copyright notice.

---

## About

Mission Control is built by **OldGenAI** making powerful, self-hosted AI approachable for everyone, not just engineers.
