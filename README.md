# Mission Control

Your own AI command center: a self-hosted agentic OS you actually control.

Mission Control is a personal AI system you run on your own computer. You chat with Dave, your always-on AI agent. He can answer questions, use tools (web search, files, an optional shell), remember what matters, and when a job is bigger than a quick chat, hand it to a pipeline: a repeatable workflow carried out by a team of specialist AI workers.

It runs on your hardware with your choice of model: a free local model (LM Studio, Ollama, llama.cpp) or a paid cloud model through OpenRouter. Your data, your keys and your conversations stay on your machine.

Built by [OldGenAI](#about). Free and open source under the [MIT license](#license).

## Contents

- [What it is](#what-it-is)
- [Chat vs. pipelines](#chat-vs-pipelines)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running it with Docker instead](#running-it-with-docker-instead)
- [Configuration](#configuration)
- [Making videos](#making-videos)
- [Security and privacy](#security-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [License](#license)
- [About](#about)

## What it is

Most AI tools are a chat box on somebody else's server. Mission Control runs on your own computer instead.

- You host it. Nothing goes to a server you don't control unless you pick a cloud model or use the web tools.
- It can act, not just talk: search the web, read and write files in its own workspace, run jobs, remember things across days, and coordinate a team of sub-agents for bigger work. That's what "agentic OS" means here.
- You pick the model. Point it at a free local model or a cloud model, and switch whenever you like.

There are two ways to get work done: chat with Dave, or run a pipeline.

## Chat vs. pipelines

Dave (chat) is for conversation and one-off tasks. Ask him anything and he'll answer, look things up, edit a file or remember something for you.

Pipelines are for work you want done the same way every time, in parallel, with a record of what happened. A pipeline is a saved recipe: the same steps on every run, a budget, optional human approval, and a sourced report at the end, carried out by a team of workers running at once.

| | Dave (chat) | Pipeline |
|---|---|---|
| Best for | one-off questions, exploring | repeatable jobs, bigger tasks |
| How it runs | conversational | the same defined steps every time |
| Cost and safety | bounded per chat turn | hard budgets, timeouts, approval gates |
| Teamwork | one agent | a team of workers in parallel |
| Output | a chat transcript | structured, sourced reports (artifacts) |
| Do you need to be there? | yes | no, it runs in the background and tells Dave when it's done |

You don't have to choose between them. Dave can launch pipelines for you.

## Features

The agent and the team
- Dave, your tier-1 personal agent: chat, 17 built-in tools and persistent memory.
- Chat commands: type `/help`, `/new [title]`, `/stop` or `/context` in the chat box. They run in the page and are never sent to the model. Commands that change settings come later, behind the same safety checks as everything else.
- An orchestrator and specialist workers (researcher, coder) that pipelines use to split a job up and run the parts in parallel.

Pipelines
- Ready-made presets: research a topic, summarise a URL, draft a document, review code, build a daily digest, fact-check a claim, and more.
- Budgets and guardrails: token and cost ceilings, timeouts, and an automatic stop when something keeps failing.
- Approval gates: a pipeline can pause for your sign-off before it carries on.
- Artifacts: every result is saved as a sourced document linked to the run that produced it, so you can trace where it came from.

Models and providers
- Local models (LM Studio, Ollama, llama.cpp, anything OpenAI-compatible) for free and private use, or OpenRouter for cloud models (pay as you go).
- Instances: save several model setups and switch the active one with a click.
- Two models at once: give pipelines their own model. Add an instance with Workspace set to Pipeline, and pipelines (including ones Dave launches) run on it while you keep chatting with Dave on another, for example a big cloud model on a research job while a fast local model handles chat.

Live monitor
- A real-time view of your agents, their context use, tokens, cost, latency and the background watchdog.
- The pipeline panel shows your most recent run, so a finished run stays on screen. A red step means the last run failed there. It's history, not a live error, and it clears when the next run starts.

Memory
- Short-term daily notes that fade after a week, and milestones that stay. Dave decides what's worth keeping.

Built-in tools
- Web search (Brave) and a guarded web fetch, and file read, write and edit inside the workspace. The shell (`exec`) tool is locked for now (see [Security and privacy](#security-and-privacy)).

Video
- Make short clips with ComfyUI on your own computer, from a description or from a picture, and watch them take shape. See [Making videos](#making-videos).

## How it works

Three tiers, each with one job:

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
- A gateway (Node.js and TypeScript) runs the agents and serves the app. The app talks to it over a local WebSocket.
- Pipelines are plain YAML files describing the steps.
- Everything (sessions, artifacts, memory, logs) is stored locally in SQLite.
- The app is built with React.

## Requirements

- Node.js 22 or newer.
- A model, one of:
  - LM Studio, Ollama or llama.cpp running on your computer (free, private), or
  - an OpenRouter API key (cloud models, pay as you go).
- Optional: a Brave Search API key, if you want the web search tool.

Docker is not needed. If you prefer it, see [Running it with Docker instead](#running-it-with-docker-instead).

Tested automatically on every change on Windows, macOS and Linux, and used every day on Windows 11 and a Mac mini.

A one-line installer that sets all of this up for you is on the way. Until then, the steps below take a few minutes.

### Installing Node.js

Get the LTS version from [nodejs.org](https://nodejs.org/en/download/), or use a package manager:

- Windows (PowerShell): `winget install OpenJS.NodeJS.LTS`
- macOS (Homebrew): `brew install node`
- Linux: [nvm](https://github.com/nvm-sh/nvm) or [NodeSource](https://github.com/nodesource/distributions)

Check it with `node --version`. It needs to say v22 or higher.

## Quick start

1. Get the code:
   ```bash
   git clone https://github.com/OldGenAi/mission-control.git
   cd mission-control
   ```

2. Build the app:
   ```bash
   cd app
   npm ci
   npm run build
   cd ..
   ```

3. Build and start the gateway (leave this window open, it keeps Mission Control running):
   ```bash
   cd gateway
   npm ci
   npm run build
   npm start
   ```

4. In a second window, open it in your browser, already signed in:
   ```bash
   cd mission-control/gateway
   npm run open
   ```
   The sign-in link works once, for one minute. Next time, run `npm run open` again, or just reopen the page: the browser stays signed in for 30 days.

5. Choose your model in Settings. Out of the box Mission Control looks for LM Studio at `http://127.0.0.1:1234/v1`. If that's what you use, start LM Studio, load a model and say hello to Dave. For Ollama (port 11434) or llama.cpp (port 8080), change the local server address in Settings. For a cloud model, add your OpenRouter key under Settings, Providers.

To stop Mission Control, press Ctrl+C in the gateway window.

### For developers

`npm run dev` in `gateway/` and in `app/` runs both with live reloading, and the app is then at http://localhost:5173. The dev gateway reads `gateway/.env` (copy it from `gateway/.env.example`).

## Running it with Docker instead

Docker keeps Mission Control in its own container. Day to day it works the same.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (on Windows, keep "Use WSL 2 based engine" on) or [Docker Engine](https://docs.docker.com/engine/install/) on Linux, and make sure it's running.
2. Copy the settings template and pick your provider in it: `cp gateway/.env.example gateway/.env`
3. Start the gateway: `docker compose up -d --build`
4. Start the app: `cd app && npm ci && npm run dev`, then open http://localhost:5173.

## Configuration

Almost everything is set up in the app, under Settings:

- Providers and keys: add your OpenRouter and Brave keys. They're stored encrypted.
- Instances: create model setups (say, one local and one cloud) and switch the active one in the sidebar.
- Exec (shell) tool: locked for now (see [Security and privacy](#security-and-privacy)).
- About you: the first time you open Mission Control it asks a few questions so Dave knows who he's helping. You can change the answers, and Dave's own instructions, on the Agents page.

`gateway/.env` is optional. It only sets first-boot defaults. After the first start, what you set in Settings wins.

## Making videos

The Video page makes short clips with [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running on your own computer. Mission Control doesn't come with ComfyUI or any video model. You install those yourself and choose which models to use, and your prompts and pictures never leave your computer.

What it does:
- Text to video: describe a scene and get a clip, with sound when the model makes it.
- Picture to video: choose a photo and it becomes the first frame of the clip. The page remembers the picture, even after a restart, until you press Remove. A small copy of it is kept in your browser for that.
- While it works you see the stage it's at, the step count and a rough preview.
- Finished clips play in the page, newest first, six at a time. "Use again" fills the form with the same settings, so you can make the same clip again or change one thing.
- Star the clips you want to keep. "Clear unstarred" deletes the others on the list after asking, and a bar shows how much of the 50 GB your videos and pictures use.

The recipes, timed on a mini PC with an NVIDIA RTX 5070 Ti (16 GB) in an external dock:

| Recipe | Graphics card | Time for a 5-second clip |
|---|---|---|
| LTX-2.5 text to video | NVIDIA with 16 GB | about a minute, 1280x704 with sound |
| LTX-2.5 picture to video | NVIDIA with 16 GB | about 40 seconds, with sound |
| Wan 2.2 (5B) text to video | NVIDIA with 8 GB or more | about 100 seconds, 832x480, silent (not yet timed on a smaller card) |

Setting it up:
1. Install [ComfyUI](https://github.com/comfyanonymous/ComfyUI). On Windows, the portable download from its releases page is the simplest way.
2. Download the model files for the recipe you want (listed below) and put each one in the named folder inside `ComfyUI/models`. The Video page also lists any file that's missing.
3. Start ComfyUI with `--preview-method auto --disable-metadata`, for example `python main.py --preview-method auto --disable-metadata`. Don't add `--listen`: ComfyUI has no sign-in, so anyone who can reach it could use your graphics card and see what you make.
4. On the Video page, check the ComfyUI address (normally `http://127.0.0.1:8188`). `mc doctor` checks ComfyUI too.

Model files for both LTX-2.5 recipes (about 37 GB, all from [Lightricks/LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5)):

| File | Folder in `ComfyUI/models` | Size |
|---|---|---|
| [ltx-2.5-22b-distilled-transformer-nvfp4.safetensors](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-nvfp4.safetensors) | `diffusion_models` | 18.7 GB |
| [gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors) | `text_encoders` | 15.4 GB |
| [ltx-2.5-video-vae-conv-bf16.safetensors](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-conv-bf16.safetensors) | `vae` | 1.5 GB |
| [ltx-2.5-audio-vae-bf16.safetensors](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-audio-vae-bf16.safetensors) | `vae` | 0.4 GB |
| [ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors](https://huggingface.co/Lightricks/LTX-2.5/resolve/main/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors) | `latent_upscale_models` | 1.0 GB |

Before these links work you need a free Hugging Face account, and you need to accept the LTX-2 community licence on the [model page](https://huggingface.co/Lightricks/LTX-2.5) while signed in (it's approved straight away). The NVFP4 model file is made for RTX 50-series cards. On older cards it hasn't been tested yet.

Model files for Wan 2.2 (5B) (about 18 GB, from Comfy-Org's repackaged files):

| File | Folder in `ComfyUI/models` | Size |
|---|---|---|
| [wan2.2_ti2v_5B_fp16.safetensors](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors) | `diffusion_models` | 10.0 GB |
| [umt5_xxl_fp8_e4m3fn_scaled.safetensors](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors) | `text_encoders` | 6.7 GB |
| [wan2.2_vae.safetensors](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors) | `vae` | 1.4 GB |

How it's kept safe:
- The page and Dave can only pick a recipe and fill in its settings. Neither can send ComfyUI a workflow of its own.
- Mission Control only talks to a ComfyUI on this computer, and won't use one that was started with `--listen`.
- ComfyUI writes your prompt into every video file it saves. Mission Control removes it from its own copies.
- Pictures are checked by their contents (PNG, JPEG or WebP, one still frame, up to 11 MB) and stored under a random name.
- One video at a time, a check that there's enough free graphics memory before each one, and the memory is handed back afterwards.
- Videos are kept in `~/.missioncontrol/media/video`, up to 50 GB in total.

The model is your choice, and so is following its licence:
- LTX-2.5 uses Lightricks' LTX-2 community licence. It's free for businesses with less than $10 million a year in revenue, and it requires you to say clearly that what you share is machine-generated. Read it before you use clips commercially.
- Wan 2.2 is Apache-2.0.
- Some licences don't cover every country. HunyuanVideo 1.5's licence leaves out the EU, the UK and South Korea, so there's no recipe for it here.

## Security and privacy

Mission Control is built to be safe to run on your own machine:

- Your data stays local. Sessions, memory and artifacts live in a SQLite database on your computer.
- The gateway only listens on `127.0.0.1` (this computer). To share it on your network you have to set both `GATEWAY_HOST` and `GATEWAY_ALLOWED_HOSTS`, and it won't start with only one of them. Requests that name any other host are refused, which blocks DNS-rebinding tricks. `mc doctor` also tells you if Mission Control, LM Studio, Ollama or ComfyUI can be reached from other devices.
- Every connection needs the gateway's key, checked together with where the request comes from, with replay protection. The browser never sees that key: `npm run open` proves it holds the key without sending it, gets a one-time sign-in link, and the page swaps that link for its own session.
- The app runs under a strict Content-Security-Policy, and it loads nothing from other websites (even its font ships with it).
- API keys are encrypted at rest, masked in the app and removed from logs. The encryption key sits next to them in `~/.missioncontrol`, so this protects a copied settings file, not someone with full access to your account.
- The shell tool is locked. A shell command can read or change anything your user account can, so it stays locked until Mission Control can run commands in a locked room (on the roadmap). Dave can only use the tools he's been given for that chat, and the shell refuses to run even if something asks for it. Developers who accept the risk on their own machine can unlock it by starting the gateway with `MC_ALLOW_UNSANDBOXED_SHELL=1`, then switching it on in Settings.
- Dave's instructions (his soul, how he works, who he is, and who you are) can only be changed by you, on the Agents page. Dave's own tools can't rewrite them, so a web page he reads can't talk him into changing his rules.
- Hardened throughout: parameterised database queries; web fetch refuses private and internal addresses (also after DNS lookup and on redirects); file tools can't leave the workspace or read credential files like `.env`; and every change is automatically checked for known vulnerable dependencies.

Use a local model and leave the web tools alone, and nothing leaves your machine. (Web search sends your queries to Brave, and web fetch contacts the sites you ask for. With an OpenRouter key saved, Mission Control also fetches OpenRouter's public price list once an hour, so it can show what each call costs and stop a pipeline at its budget.)

## Troubleshooting

Start with the **Health** page (under Monitor in the sidebar). The doctor checks Mission Control every minute: the gateway, Node.js, your model server, pipelines, errors, security, disk space, the database and ComfyUI. Each problem comes with a plain explanation and a button. Safe fixes run when you press them, fixes that change a setting say exactly what will change and wait for your yes, and nothing is ever fixed without you pressing a button. The live feed on the right shows everything it checks and does. The dot next to Health is green when all is well.

If Mission Control crashes, `mc start` restarts it by itself, at most 3 times in 30 minutes, and then leaves it stopped with the reason at the end of `mc logs`. `mc start` also says in plain words why it can't start (port in use, Node.js too old, a damaged settings file) instead of failing quietly.

The model list says "Loading…" and never shows any models.
Mission Control can't reach your local model server. Check that LM Studio, Ollama or llama.cpp is running, and that the local server address in Settings matches its port (LM Studio 1234, Ollama 11434, llama.cpp 8080). Hover over the model selector to see the exact address it tried and the error it got.

The page says "This window isn't signed in yet".
Run `npm run open` in the `gateway` folder. It opens a fresh, signed-in window.

`npm start` says the port is already in use.
Mission Control is probably already running in another window. Close that one first, or set a different port with `GATEWAY_PORT`.

`npm ci` fails, or the app won't start.
Check `node --version`. It needs to be v22 or higher.

With Docker: "cannot connect to the Docker daemon".
Docker Desktop isn't running. Start it, wait until it says it's running, then try again.

With Docker on Windows: the gateway can't reach the model server on your PC.
If WSL uses the older NAT networking, `127.0.0.1` inside the container doesn't reach Windows. Turn on mirrored networking in `%UserProfile%\.wslconfig` (add `[wsl2]` and `networkingMode=mirrored`), run `wsl --shutdown`, then start Docker Desktop again.

## Roadmap

Mission Control is actively developed. Coming up:

- A one-line install for Windows, macOS and Linux, with a desktop icon (in progress).
- A locked room for the shell tool: commands run with no network and no access outside a scratch folder.
- Approving shell commands one at a time, as they come up.
- Video: a simple editor in the page (trim, join, add sound), and letting Dave make videos for you.
- Direct Anthropic support (Claude is already reachable through OpenRouter).
- Several local model servers at once, one per instance.
- Skills and plugins to extend Dave.
- Talking to Dave from Telegram, Discord, Slack, WhatsApp, iMessage and Signal.
- A visual pipeline builder, so you don't need YAML.
- Smarter automation: self-healing retries, and moving up from a cheap model to a stronger one only when a task needs it.

Want something sooner, or have an idea? Open an issue.

## License

[MIT](LICENSE) © 2026 OldGenAI. Free to use, change and share. Just keep the copyright notice.

## About

Mission Control is built by OldGenAI, to make powerful self-hosted AI approachable for everyone, not just engineers.
