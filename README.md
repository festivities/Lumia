<h1 align="center">
  Lumia
</h1>

> A Discord bot to automatically screen and moderate media (images, videos, animations) using NVIDIA's Nemotron-3.5-content-safety model.

---
Lumia is a moderation bot built to moderate communities with heavy media usage. It leverages vision models to detect unsafe imagery (including drawn/rendered sexual content, animations, and videos) without relying on human staff.

It uses Discord features like slash commands, interactive staff review alerts, and timeouts to keep your server safe around the clock.

### Features
- **Media Screening:** Screens static images, autoplay animations, and player videos.
- **Link Unfurling:** Automatically detects media URLs in messages and embedded content.
- **False Positive Approval:** Staff alerts include an interactive "Approve (False Positive)" button to instantly lift timeouts and reinstate original media with user attribution.
- **Customizable Scope:** Configure global animation scanning rules, filesize limits, and per-channel monitoring scopes (`images` vs `images+videos`).
- **NVIDIA Nemotron Integration:** Robust API polling, retry logic with exponential backoff, and quota-friendly frame sampling for videos.

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

### Why use Lumia?
SFW anime art is common in many communities, but standard photo-oriented safe-search APIs routinely miss unsafe 2D/3D renders or flag safe art as false positives. Lumia uses NVIDIA's Nemotron model, which is safety-trained on a broader taxonomy (including drawn/rendered explicit content). 
Because false positives can still happen, Lumia empowers staff with an instant "Approve" flow to effortlessly restore content.

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
Lumia is designed to be self-hosted, particularly optimized for environments like Oracle Ampere ARM64 instances. You will need an [NVIDIA API key](https://build.nvidia.com/) and a [Discord application](https://discord.com/developers/applications/):

1. Create a Discord application and enable the MESSAGE CONTENT intent.
2. Add a bot to the application and copy the auth token.
3. Set your tokens in `.env`:
   ```env
   DISCORD_TOKEN=your_discord_bot_token
   NVIDIA_API_KEY=your_nvidia_api_key
   ```

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
*Disclaimer: AI models used for the project were GLM-5.3, Gemini 3.1 Pro, and Gemini 3.7 Flash.*
