<h1 align="center">
  Lumia
</h1>

> A Discord bot to automatically screen and moderate media (images, videos, animations) using OpenAI's omni-moderation or NVIDIA's Nemotron-3.5-content-safety model (switchable via `.env`).

---
Lumia is a moderation bot built to moderate communities with heavy media usage. It leverages vision models to detect unsafe imagery (including drawn/rendered sexual content, animations, and videos) without relying on human staff.

It uses Discord features like slash commands, interactive staff review alerts, and timeouts to keep your server safe around the clock.

### Features
- **Media Screening:** Screens static images, autoplay animations, and player videos.
- **Link Unfurling:** Automatically detects media URLs in messages and embedded content.
- **False Positive Approval:** Staff alerts include an interactive "Approve (False Positive)" button to instantly lift timeouts and reinstate original media with user attribution.
- **Customizable Scope:** Configure global animation scanning rules, filesize limits, and per-channel monitoring scopes (`images` vs `images+videos`).
- **Switchable Moderation Provider:** OpenAI `omni-moderation-latest` (default, sexual-category policy) or NVIDIA `nemotron-3.5-content-safety` via `MODERATION_PROVIDER` in `.env`. Robust retry logic with exponential backoff, and quota-friendly frame sampling for videos.

### Getting Started
1. **Invite your bot** to your server with appropriate permissions (Timeout Members, Manage Messages, etc) using your Application Client ID:
   ```text
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=1099511688192&integration_type=0&scope=bot+applications.commands
   ```
2. You can view all configuration commands by typing `/lumia` in the text input field. All commands have clear descriptions.
3. Configure monitored channels with `/lumia channel add <channel> [mode]`.
4. Set a staff alert channel for reviews with `/lumia staffchannel <channel>`.
5. Check your configuration with `/lumia show`.

<details>
<summary><strong>Extra info & Tips</strong></summary>

### Moderation Flow
- User posts media (attachment or link).
- If it exceeds the file size threshold, it is ignored.
- If it's a video or animation, Lumia adaptively samples frames.
- If deemed unsafe, the user is timed out, the message is deleted, and staff are alerted.
- If staff click **Approve (False Positive)**, the timeout is lifted and the media is reposted seamlessly.
</details>

### Support
If you find a bug, please [create an issue](https://github.com/festivities/Lumia/issues/new) on our GitHub repository.
If you have a question, please start a discussion at [Q&A Discussions](https://github.com/festivities/Lumia/discussions/new?category=q-a).
For security issues, please refer to [SECURITY.md](./SECURITY.md).

**Disclaimer:** This software is provided as-is without any warranty. Support is not guaranteed, and the maintainer reserves the right to choose whether or not to assist with issues or questions.

### Self Hosting
Lumia is designed to be self-hosted, particularly optimized for environments like Oracle Ampere ARM64 instances. You will need a [Discord application](https://discord.com/developers/applications/) and an API key for your selected provider ([OpenAI](https://platform.openai.com/) for the default omni-moderation, or [NVIDIA](https://build.nvidia.com/) for Nemotron):

1. Create a Discord application and enable the MESSAGE CONTENT intent.
2. Add a bot to the application and copy the auth token.
3. Set your tokens in `.env`:
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   OPENAI_API_KEY=your_openai_api_key
   NVIDIA_API_KEY=your_nvidia_api_key
   MODERATION_PROVIDER=omni-moderation
   ```
   Only the API key for the selected provider is required. Set `MODERATION_PROVIDER=nemotron` to use Nemotron instead.

#### Docker (Recommended)
Lumia ships with a lightweight Alpine Dockerfile that includes `ffmpeg` and `libwebp-tools` natively.
```bash
docker build -t lumia-bot .
docker run -d --env-file .env -v $(pwd)/data:/app/data lumia-bot
```

#### Direct Installation
Requirements: Node.js (v22+), system-level `ffmpeg` and `libwebp-tools` (webpmux).
1. Download the code and run `npm install`.
2. Ensure you have your `.env` configured.
3. Run `npm start` to start the bot.

---
*Disclaimer: AI assistance was involved in this project*
