import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import { settings } from './settings.js';
import { enqueueImage, enqueueVideo } from './safety.js';
import { commandData, handleCommand } from './commands.js';
import { formatDuration } from './parse.js';
import {
  classifyAttachment,
  sniffImage,
  normalizeStillImage,
} from './video.js';
import {
  extractCandidateUrls,
  fetchGuarded,
  dedupeCache,
} from './links.js';

// 1. Startup validation: ensure required env vars exist
const missingEnv = [];
if (!process.env.NVIDIA_API_KEY) missingEnv.push('NVIDIA_API_KEY');
if (!process.env.DISCORD_TOKEN) missingEnv.push('DISCORD_TOKEN');

if (missingEnv.length > 0) {
  console.error(`[Lumia] FATAL: Missing required environment variable(s): ${missingEnv.join(', ')}`);
  console.error('[Lumia] Please set these variables in your .env file or environment.');
  process.exit(1);
}

const isVerbose = process.env.VERBOSE === 'true' || process.env.VERBOSE === '1' || process.env.DEBUG === 'true';
export function logVerbose(...args) {
  if (isVerbose) {
    console.log(...args);
  }
}

// 2. Boot-time temp sweep (cleans leftover lumia-* temp files older than 24h)
function sweepTempDirs() {
  try {
    const tmpDir = os.tmpdir();
    const entries = fs.readdirSync(tmpDir);
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    for (const entry of entries) {
      if (entry.startsWith('lumia-')) {
        const fullPath = path.join(tmpDir, entry);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.mtimeMs < oneDayAgo) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        } catch {
          // Ignore individual stat/rm errors
        }
      }
    }
  } catch (err) {
    console.warn('[Lumia] Temp sweep encountered warning:', err.message);
  }
}
sweepTempDirs();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Process-level crash prevention
process.on('unhandledRejection', (reason) => {
  console.error('[Lumia] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Lumia] Uncaught Exception:', err);
});

client.on('error', (err) => {
  console.error('[Lumia] Discord Client Error:', err);
});

// Slash command registration per guild (instant propagation)
async function registerGuildCommands(guild) {
  try {
    await guild.commands.set([commandData]);
    console.log(`[Lumia] Registered /lumia commands for guild ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`[Lumia] Failed to register commands for guild ${guild.id}:`, err);
  }
}

client.once('ready', async () => {
  console.log(`[Lumia] Logged in as ${client.user.tag} (ID: ${client.user.id})`);

  for (const guild of client.guilds.cache.values()) {
    await registerGuildCommands(guild);
  }

  console.log('[Lumia] Ready and monitoring configured channels.');
  if (isVerbose) {
    console.log('[Lumia] Verbose logging is ENABLED.');
  }
});

client.on('guildCreate', async (guild) => {
  console.log(`[Lumia] Joined new guild: ${guild.name} (${guild.id})`);
  await registerGuildCommands(guild);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'lumia') {
      try {
        await handleCommand(interaction);
      } catch (err) {
        console.error('[Lumia] Error executing command:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'An error occurred while executing the command.',
            ephemeral: true,
          }).catch(() => {});
        }
      }
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('approve_fp:')) {
      try {
        await handleFalsePositiveApproval(interaction);
      } catch (err) {
        console.error('[Lumia] Error approving false positive:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'An error occurred while approving the false positive.',
            ephemeral: true,
          }).catch(() => {});
        }
      }
    }
  }
});

/**
 * Handles False Positive approval button clicks.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleFalsePositiveApproval(interaction) {
  if (!interaction.inGuild() || !interaction.guildId) return;

  const guildId = interaction.guildId;
  const config = settings.getGuild(guildId);
  const member = interaction.member;

  // Permission check: ManageGuild, ModerateMembers, ManageMessages, or configured staff role
  const hasPerm =
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions?.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions?.has(PermissionFlagsBits.ManageMessages) ||
    (config.staffRoleId && member.roles?.cache?.has(config.staffRoleId));

  if (!hasPerm) {
    return interaction.reply({
      content: '❌ You do not have permission to approve false positives.',
      ephemeral: true,
    });
  }

  const parts = interaction.customId.split(':');
  const channelId = parts[1];
  const authorId = parts[2];

  let originalUrl = null;
  if (parts.length > 3) {
    const encoded = parts.slice(3).join(':');
    if (encoded) {
      try {
        originalUrl = decodeURIComponent(encoded);
      } catch {
        // Fallback
      }
    }
  }

  if (!originalUrl) {
    const detailsField = interaction.message.embeds[0]?.fields?.find(
      (f) => f.name === 'Source & Details'
    );
    if (detailsField?.value) {
      const match = detailsField.value.match(/\[Media Link\]\((https?:\/\/[^\s)]+)\)/);
      if (match) {
        originalUrl = match[1];
      }
    }
  }

  await interaction.deferUpdate();

  // 1. Lift member timeout
  try {
    const targetMember = await interaction.guild.members.fetch(authorId).catch(() => null);
    if (targetMember) {
      await targetMember.timeout(null, `False positive approved by ${interaction.user.tag}`);
    }
  } catch (err) {
    console.warn(`[Lumia] Failed to remove timeout for user ${authorId}:`, err.message);
  }

  // 2. Restore media to original channel with author attribution
  try {
    const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    const originalUser = await interaction.client.users.fetch(authorId).catch(() => null);

    if (targetChannel) {
      const restoredEmbed = new EmbedBuilder()
        .setColor(0x57f287) // Green
        .setFooter({
          text: `Restored by staff (${interaction.user.tag}) • False positive approved`,
          iconURL: interaction.user.displayAvatarURL(),
        })
        .setTimestamp();

      if (originalUser) {
        restoredEmbed.setAuthor({
          name: originalUser.tag,
          iconURL: originalUser.displayAvatarURL(),
        });
      }

      // Try re-fetching original media file if URL is available
      let restoredPayload = null;
      if (originalUrl) {
        const fetched = await fetchGuarded(originalUrl, config.maxFileMb * 1024 * 1024).catch(() => null);
        if (fetched?.buffer) {
          const fileName = path.basename(new URL(originalUrl).pathname) || 'restored_media';
          restoredPayload = {
            embeds: [restoredEmbed],
            files: [{ attachment: fetched.buffer, name: fileName }],
          };
          if (fetched.contentType.startsWith('image/')) {
            restoredEmbed.setImage(`attachment://${fileName}`);
          }
        }
      }

      // Fallback: restore with flagged frame image from alert
      if (!restoredPayload) {
        const alertImgUrl =
          interaction.message.embeds[0]?.image?.url ||
          interaction.message.attachments.first()?.url;

        if (alertImgUrl) {
          restoredEmbed.setImage(alertImgUrl);
        }
        restoredPayload = { embeds: [restoredEmbed] };
      }

      await targetChannel.send(restoredPayload);
    }
  } catch (err) {
    console.error(`[Lumia] Failed to restore media to channel ${channelId}:`, err);
  }

  // 3. Update the staff alert message
  try {
    const originalEmbed = interaction.message.embeds[0];
    const updatedEmbed = EmbedBuilder.from(originalEmbed);

    updatedEmbed.addFields({
      name: 'Staff Action',
      value: `✅ **False Positive Approved** by <@${interaction.user.id}> (${interaction.user.tag})\n• Timeout lifted\n• Media restored to <#${channelId}>`,
      inline: false,
    });

    const disabledButton = new ButtonBuilder()
      .setCustomId(`approved_fp:${channelId}:${authorId}`)
      .setLabel('Approved (False Positive)')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true)
      .setEmoji('✅');

    const row = new ActionRowBuilder().addComponents(disabledButton);

    await interaction.message.edit({
      embeds: [updatedEmbed],
      components: [row],
    });
  } catch (err) {
    console.error('[Lumia] Failed to update staff alert message:', err);
  }
}

/**
 * Checks if a channel (or thread parent) is configured and returns its mode.
 * @param {import('discord.js').GuildBasedChannel} channel
 * @param {Record<string, { mode: 'images' | 'images+videos' }>} configuredChannels
 * @returns {{ configured: boolean, mode: 'images' | 'images+videos' | null }}
 */
function getChannelConfig(channel, configuredChannels) {
  if (!configuredChannels || Object.keys(configuredChannels).length === 0) {
    return { configured: false, mode: null };
  }

  if (configuredChannels[channel.id]) {
    return { configured: true, mode: configuredChannels[channel.id].mode };
  }

  // Check thread parent chain
  let current = channel;
  while (current?.parentId) {
    if (configuredChannels[current.parentId]) {
      return { configured: true, mode: configuredChannels[current.parentId].mode };
    }
    current = current.parent;
  }

  return { configured: false, mode: null };
}

/**
 * Downloads media from URL with a streaming max byte cap.
 * @param {string} url
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function downloadWithCap(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when downloading media`);
  }

  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error(`Content-Length (${contentLength}) exceeds limit of ${maxBytes} bytes`);
  }

  if (!res.body) {
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Downloaded size (${arrayBuffer.byteLength}) exceeds limit of ${maxBytes} bytes`);
    }
    return Buffer.from(arrayBuffer);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error(`Streamed size exceeded limit of ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

/**
 * Handles action execution when an unsafe item is detected.
 */
async function handleUnsafeVerdict({
  message,
  verdict,
  config,
  source,
  originalUrl,
  flaggedFrameBuffer,
  sampleSummary,
  flaggedAt,
}) {
  const categoriesList = verdict.categories.length > 0 ? verdict.categories.join(', ') : 'Unspecified';
  console.log(`[Lumia] Flagged unsafe ${source} from ${message.author.tag} (${message.author.id}) in #${message.channel.name}. Categories: ${categoriesList}`);

  let timeoutOutcome = 'Not attempted';
  let deleteOutcome = 'Not attempted';

  // 1. Timeout member
  try {
    let member = message.member;
    if (!member) {
      member = await message.guild.members.fetch(message.author.id).catch(() => null);
    }

    if (member) {
      await member.timeout(config.timeoutMs, `Lumia Content Safety: ${categoriesList}`);
      timeoutOutcome = `✓ Timed out for ${formatDuration(config.timeoutMs)}`;
    } else {
      timeoutOutcome = '✗ Member not found in guild';
    }
  } catch (err) {
    timeoutOutcome = `✗ Failed: ${err.message || 'Permission or hierarchy error'}`;
    console.warn(`[Lumia] Timeout failed for member ${message.author.id}:`, err.message);
  }

  // 2. Delete flagged message
  try {
    await message.delete();
    deleteOutcome = '✓ Flagged message deleted';
  } catch (err) {
    deleteOutcome = `✗ Failed to delete: ${err.message || 'Missing permissions'}`;
    console.warn(`[Lumia] Message delete failed for ${message.id}:`, err.message);
  }

  // 3. Post alert to staff channel
  let staffChannel = null;
  if (config.staffChannelId) {
    staffChannel =
      message.guild.channels.cache.get(config.staffChannelId) ||
      (await message.guild.channels.fetch(config.staffChannelId).catch(() => null));
  }

  if (staffChannel) {
    try {
      const alertEmbed = new EmbedBuilder()
        .setTitle('🚨 Content Safety Flag')
        .setColor(0xed4245) // Red
        .addFields(
          {
            name: 'Author',
            value: `${message.author.tag} (<@${message.author.id}> \`${message.author.id}\`)`,
            inline: true,
          },
          {
            name: 'Channel',
            value: `<#${message.channel.id}>`,
            inline: true,
          },
          {
            name: 'Timeout Duration',
            value: formatDuration(config.timeoutMs),
            inline: true,
          },
          {
            name: 'Safety Categories',
            value: categoriesList,
            inline: false,
          },
          {
            name: 'Source & Details',
            value: [
              `• **Source**: ${source === 'link' ? 'Linked URL' : 'Uploaded Attachment'}`,
              originalUrl ? `• **Original File**: [Media Link](${originalUrl})` : '',
              sampleSummary ? `• **Sampled Frames**: ${sampleSummary}` : '',
              flaggedAt ? `• **Flagged At**: ${flaggedAt}` : '',
            ].filter(Boolean).join('\n'),
            inline: false,
          },
          {
            name: 'Moderation Outcomes',
            value: [
              `• **Timeout**: ${timeoutOutcome}`,
              `• **Delete**: ${deleteOutcome}`,
              '• **Staff Review**: Flagged evidence attached below',
            ].join('\n'),
            inline: false,
          }
        )
        .setImage('attachment://flagged_frame.jpg')
        .setFooter({ text: 'Lumia AI Media Moderation' })
        .setTimestamp();

      const approveButton = new ButtonBuilder()
        .setCustomId(`approve_fp:${message.channel.id}:${message.author.id}`)
        .setLabel('Approve (False Positive)')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅');

      const actionRow = new ActionRowBuilder().addComponents(approveButton);

      const alertPayload = {
        embeds: [alertEmbed],
        components: [actionRow],
        files: [
          {
            attachment: flaggedFrameBuffer,
            name: 'flagged_frame.jpg',
          },
        ],
      };

      if (config.staffRoleId) {
        alertPayload.content = `<@&${config.staffRoleId}>`;
        alertPayload.allowedMentions = { roles: [config.staffRoleId] };
      }

      await staffChannel.send(alertPayload);
    } catch (err) {
      console.error('[Lumia] Failed to send alert to staff channel:', err);
    }
  }
}

/**
 * Screens candidate URLs from embeds or text links in a message.
 */
async function screenMessageLinks(message, config, channelInfo) {
  const candidateUrls = extractCandidateUrls(message);
  if (candidateUrls.length === 0) return;

  logVerbose(`[Lumia] Found ${candidateUrls.length} media candidate URL(s) in message ${message.id} from ${message.author?.tag || message.author?.id} in #${message.channel.name}`);

  const maxBytes = config.maxFileMb * 1024 * 1024;
  const gates = {
    channelMode: channelInfo.mode,
    animationScope: config.animationScope,
  };

  for (const url of candidateUrls) {
    if (dedupeCache.has(message.id, url)) continue;
    dedupeCache.add(message.id, url);

    const fetched = await fetchGuarded(url, maxBytes);
    if (!fetched || !fetched.buffer) continue;

    const classification = classifyAttachment(
      { contentType: fetched.contentType, name: url },
      gates
    );
    if (!classification) continue;

    logVerbose(`[Lumia] Screening link media "${url}" (${classification}) from ${message.author?.tag || message.author?.id}...`);

    let verdict = null;
    let flaggedBuffer = fetched.buffer;
    let sampleSummary = null;
    let flaggedAt = null;

    try {
      if (classification === 'player-video') {
        const tmpPath = path.join(os.tmpdir(), `lumia-link-${Date.now()}-${path.basename(new URL(url).pathname || 'video.mp4')}`);
        fs.writeFileSync(tmpPath, fetched.buffer);
        const res = await enqueueVideo(tmpPath, 'player-video');
        verdict = res;
        flaggedBuffer = res.flaggedFrameBuffer || fetched.buffer;
        sampleSummary = res.sampleSummary;
        flaggedAt = res.flaggedAt;
      } else {
        const sniff = sniffImage(fetched.buffer);
        if (sniff.animated) {
          const tmpPath = path.join(os.tmpdir(), `lumia-link-${Date.now()}-${path.basename(new URL(url).pathname || 'anim.gif')}`);
          fs.writeFileSync(tmpPath, fetched.buffer);
          const res = await enqueueVideo(tmpPath, 'autoplay-animation');
          verdict = res;
          flaggedBuffer = res.flaggedFrameBuffer || fetched.buffer;
          sampleSummary = res.sampleSummary;
          flaggedAt = res.flaggedAt;
        } else {
          const norm = await normalizeStillImage(fetched.buffer);
          verdict = await enqueueImage(norm.buffer, norm.contentType);
          flaggedBuffer = norm.buffer;
        }
      }
    } catch (err) {
      console.error(`[Lumia] Failed screening link ${url}:`, err.message);
      continue; // Fail-open
    }

    if (verdict) {
      logVerbose(`[Lumia] Link media verdict for "${url}": ${verdict.safe ? 'SAFE' : 'UNSAFE [' + (verdict.categories?.join(', ') || 'flagged') + ']'}`);
    }

    if (verdict && !verdict.safe) {
      await handleUnsafeVerdict({
        message,
        verdict,
        config,
        source: 'link',
        originalUrl: url,
        flaggedFrameBuffer: flaggedBuffer,
        sampleSummary,
        flaggedAt,
      });
      break; // Message deleted; stop processing further links
    }
  }
}

// Moderation flow on messageCreate
client.on('messageCreate', async (message) => {
  // 1. Ignore: non-guild messages, bots, and webhooks
  if (!message.guild || message.author.bot || message.webhookId) return;

  const config = settings.getGuild(message.guild.id);
  const channelInfo = getChannelConfig(message.channel, config.channels);
  if (!channelInfo.configured) {
    return;
  }

  const maxBytes = config.maxFileMb * 1024 * 1024;
  const gates = {
    channelMode: channelInfo.mode,
    animationScope: config.animationScope,
  };

  // 2. Classify attachments
  let targetAttachment = null;
  let classification = null;

  for (const att of message.attachments.values()) {
    const cls = classifyAttachment(att, gates);
    if (cls) {
      targetAttachment = att;
      classification = cls;
      break;
    }
  }

  if (targetAttachment && classification) {
    logVerbose(`[Lumia] [Attachment] Screening "${targetAttachment.name || targetAttachment.id}" (${classification}) from ${message.author.tag} in #${message.channel.name}...`);

    // 3. Size check vs threshold
    if (targetAttachment.size > maxBytes) {
      console.warn(`[Lumia] Attachment ${targetAttachment.name || targetAttachment.id} (${targetAttachment.size} bytes) exceeds threshold (${maxBytes} bytes). Skipping.`);
      return;
    }

    let buffer;
    try {
      buffer = await downloadWithCap(targetAttachment.url, maxBytes);
    } catch (err) {
      console.error(`[Lumia] Failed to download attachment ${targetAttachment.url}:`, err.message);
      return; // Fail-open
    }

    let verdict = null;
    let flaggedBuffer = buffer;
    let sampleSummary = null;
    let flaggedAt = null;

    try {
      if (classification === 'player-video') {
        const ext = path.extname(targetAttachment.name || 'video.mp4') || '.mp4';
        const tmpPath = path.join(os.tmpdir(), `lumia-att-${Date.now()}${ext}`);
        fs.writeFileSync(tmpPath, buffer);
        const res = await enqueueVideo(tmpPath, 'player-video');
        verdict = res;
        flaggedBuffer = res.flaggedFrameBuffer || buffer;
        sampleSummary = res.sampleSummary;
        flaggedAt = res.flaggedAt;
      } else {
        const sniff = sniffImage(buffer);
        if (sniff.animated) {
          const ext = path.extname(targetAttachment.name || 'anim.gif') || '.gif';
          const tmpPath = path.join(os.tmpdir(), `lumia-att-${Date.now()}${ext}`);
          fs.writeFileSync(tmpPath, buffer);
          const res = await enqueueVideo(tmpPath, 'autoplay-animation');
          verdict = res;
          flaggedBuffer = res.flaggedFrameBuffer || buffer;
          sampleSummary = res.sampleSummary;
          flaggedAt = res.flaggedAt;
        } else {
          const norm = await normalizeStillImage(buffer);
          verdict = await enqueueImage(norm.buffer, norm.contentType);
          flaggedBuffer = norm.buffer;
        }
      }
    } catch (err) {
      console.error('[Lumia] Screening attachment failed (fail-open):', err.message);
      return;
    }

    if (verdict) {
      logVerbose(`[Lumia] [Attachment] Verdict for "${targetAttachment.name || targetAttachment.id}": ${verdict.safe ? 'SAFE' : 'UNSAFE [' + (verdict.categories?.join(', ') || 'flagged') + ']'}`);
    }

    if (verdict && !verdict.safe) {
      await handleUnsafeVerdict({
        message,
        verdict,
        config,
        source: 'attachment',
        originalUrl: targetAttachment.url,
        flaggedFrameBuffer: flaggedBuffer,
        sampleSummary,
        flaggedAt,
      });
      return;
    }
  }

  // 4. If no attachment flagged, screen embeds/text links
  await screenMessageLinks(message, config, channelInfo);
});

// Moderation flow on messageUpdate (for link embeds)
client.on('messageUpdate', async (_oldMessage, newMessage) => {
  if (!newMessage.guild || newMessage.author?.bot || newMessage.webhookId) return;

  const config = settings.getGuild(newMessage.guild.id);
  const channelInfo = getChannelConfig(newMessage.channel, config.channels);
  if (!channelInfo.configured) {
    return;
  }

  logVerbose(`[Lumia] Message ${newMessage.id} updated in #${newMessage.channel?.name}. Checking candidate links...`);
  await screenMessageLinks(newMessage, config, channelInfo);
});

// Login
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('[Lumia] Discord login failed:', err);
});
