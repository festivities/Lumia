import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { settings } from './settings.js';
import { parseDuration, formatDuration } from './parse.js';

export const commandData = new SlashCommandBuilder()
  .setName('lumia')
  .setDescription('Lumia AI media moderation configuration')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false)
  // /lumia channel add | remove | mode
  .addSubcommandGroup((group) =>
    group
      .setName('channel')
      .setDescription('Manage channels monitored by Lumia')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a channel for Lumia to monitor')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('The channel to monitor')
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
                ChannelType.GuildMedia,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
                ChannelType.AnnouncementThread
              )
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Screening mode (default: images+videos)')
              .setRequired(false)
              .addChoices(
                { name: 'Images & Videos (images+videos)', value: 'images+videos' },
                { name: 'Images Only (images)', value: 'images' }
              )
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a channel from Lumia monitoring')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('The channel to remove')
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName('mode')
          .setDescription('Change screening mode for an existing channel')
          .addChannelOption((opt) =>
            opt
              .setName('channel')
              .setDescription('The monitored channel')
              .setRequired(true)
          )
          .addStringOption((opt) =>
            opt
              .setName('mode')
              .setDescription('Screening mode')
              .setRequired(true)
              .addChoices(
                { name: 'Images & Videos (images+videos)', value: 'images+videos' },
                { name: 'Images Only (images)', value: 'images' }
              )
          )
      )
  )
  // /lumia animations <scope>
  .addSubcommand((sub) =>
    sub
      .setName('animations')
      .setDescription('Set the global animation screening scope')
      .addStringOption((opt) =>
        opt
          .setName('scope')
          .setDescription('Animation scope (all vs autoplay-only quota brake)')
          .setRequired(true)
          .addChoices(
            { name: 'All animation types (GIF, WebP, MP4/Videos)', value: 'all' },
            { name: 'Autoplay animations only (GIF, animated WebP)', value: 'autoplay' }
          )
      )
  )
  // /lumia maxsize <megabytes>
  .addSubcommand((sub) =>
    sub
      .setName('maxsize')
      .setDescription('Set maximum media file size threshold in megabytes (1..500 MB)')
      .addIntegerOption((opt) =>
        opt
          .setName('megabytes')
          .setDescription('Size threshold in MB')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(500)
      )
  )
  // /lumia timeout <duration>
  .addSubcommand((sub) =>
    sub
      .setName('timeout')
      .setDescription('Set the timeout duration for users posting flagged media')
      .addStringOption((opt) =>
        opt
          .setName('duration')
          .setDescription('Duration string (e.g. 10m, 1h30m, 2d, 45s)')
          .setRequired(true)
      )
  )
  // /lumia staffchannel <channel>
  .addSubcommand((sub) =>
    sub
      .setName('staffchannel')
      .setDescription('Set the channel where moderation alerts are posted')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('The staff review channel')
          .setRequired(true)
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildAnnouncement
          )
      )
  )
  // /lumia role [role]
  .addSubcommand((sub) =>
    sub
      .setName('role')
      .setDescription('Set or clear the staff role pinged on moderation alerts')
      .addRoleOption((opt) =>
        opt
          .setName('role')
          .setDescription('Staff role to ping (leave empty to clear)')
          .setRequired(false)
      )
  )
  // /lumia show
  .addSubcommand((sub) =>
    sub
      .setName('show')
      .setDescription('Show the current Lumia moderation configuration')
  );

/**
 * Handles incoming slash command interactions for /lumia.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function handleCommand(interaction) {
  if (!interaction.inGuild() || !interaction.guildId) {
    return interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true,
    });
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (group === 'channel') {
    const channel = interaction.options.getChannel('channel', true);

    if (sub === 'add') {
      const mode = interaction.options.getString('mode', false) || 'images+videos';
      await settings.addChannel(guildId, channel.id, mode);
      return interaction.reply({
        content: `Added <#${channel.id}> to monitored channels (mode: \`${mode}\`).`,
        ephemeral: true,
      });
    }

    if (sub === 'remove') {
      await settings.removeChannel(guildId, channel.id);
      return interaction.reply({
        content: `Removed <#${channel.id}> from monitored channels.`,
        ephemeral: true,
      });
    }

    if (sub === 'mode') {
      const mode = interaction.options.getString('mode', true);
      const updated = await settings.setChannelMode(guildId, channel.id, mode);
      if (updated) {
        return interaction.reply({
          content: `Updated <#${channel.id}> mode to \`${mode}\`.`,
          ephemeral: true,
        });
      } else {
        // Channel wasn't added yet, add it with mode
        await settings.addChannel(guildId, channel.id, mode);
        return interaction.reply({
          content: `Added <#${channel.id}> to monitored channels with mode \`${mode}\`.`,
          ephemeral: true,
        });
      }
    }
  }

  if (sub === 'animations') {
    const scope = interaction.options.getString('scope', true);
    await settings.setAnimationScope(guildId, scope);
    const label = scope === 'autoplay' ? 'Autoplay animations only (GIF, WebP)' : 'All animations and videos (MP4, GIF, WebP, etc.)';
    return interaction.reply({
      content: `Global animation scope set to: **${label}**.`,
      ephemeral: true,
    });
  }

  if (sub === 'maxsize') {
    const mb = interaction.options.getInteger('megabytes', true);
    await settings.setMaxFileMb(guildId, mb);
    return interaction.reply({
      content: `Maximum media file size threshold set to **${mb} MB**.`,
      ephemeral: true,
    });
  }

  if (sub === 'timeout') {
    const durationInput = interaction.options.getString('duration', true);
    const parsedMs = parseDuration(durationInput);

    if (parsedMs === null) {
      return interaction.reply({
        content:
          '❌ Invalid duration format.\n' +
          '**Usage**: `/lumia timeout <duration>`\n' +
          '**Examples**: `10m`, `1h30m`, `2d`, `45s`, `1d12h`\n' +
          '**Limits**: Minimum 1s, maximum 28d.',
        ephemeral: true,
      });
    }

    await settings.setTimeoutMs(guildId, parsedMs);
    return interaction.reply({
      content: `Timeout duration set to **${formatDuration(parsedMs)}** (${parsedMs.toLocaleString()} ms).`,
      ephemeral: true,
    });
  }

  if (sub === 'staffchannel') {
    const channel = interaction.options.getChannel('channel', true);
    await settings.setStaffChannelId(guildId, channel.id);
    return interaction.reply({
      content: `Staff alert channel set to <#${channel.id}>.`,
      ephemeral: true,
    });
  }

  if (sub === 'role') {
    const role = interaction.options.getRole('role', false);
    if (role) {
      await settings.setStaffRoleId(guildId, role.id);
      return interaction.reply({
        content: `Staff alert role set to <@&${role.id}>.`,
        ephemeral: true,
      });
    } else {
      await settings.setStaffRoleId(guildId, null);
      return interaction.reply({
        content: 'Staff alert role cleared. Staff alerts will not ping any role.',
        ephemeral: true,
      });
    }
  }

  if (sub === 'show') {
    const cfg = settings.getGuild(guildId);

    const channelEntries = Object.entries(cfg.channels);
    const channelsText =
      channelEntries.length > 0
        ? channelEntries.map(([id, val]) => `<#${id}> (\`${val.mode}\`)`).join('\n')
        : '*None (no channels currently screened)*';

    const staffChannelText = cfg.staffChannelId ? `<#${cfg.staffChannelId}>` : '*None configured*';
    const staffRoleText = cfg.staffRoleId ? `<@&${cfg.staffRoleId}>` : '*None configured*';
    const timeoutText = `${formatDuration(cfg.timeoutMs)} (${cfg.timeoutMs.toLocaleString()} ms)`;
    const animationScopeText = cfg.animationScope === 'autoplay' ? 'Autoplay only' : 'All animation types';
    const maxFileSizeText = `${cfg.maxFileMb} MB`;

    const embed = new EmbedBuilder()
      .setTitle('🛡️ Lumia Configuration')
      .setColor(0x76b900) // NVIDIA Green
      .addFields(
        { name: 'Monitored Channels', value: channelsText, inline: false },
        { name: 'Animation Scope', value: animationScopeText, inline: true },
        { name: 'Max File Size', value: maxFileSizeText, inline: true },
        { name: 'Timeout Duration', value: timeoutText, inline: true },
        { name: 'Staff Channel', value: staffChannelText, inline: true },
        { name: 'Staff Role', value: staffRoleText, inline: true }
      )
      .setFooter({ text: 'Lumia AI Media Moderation' })
      .setTimestamp();

    return interaction.reply({
      embeds: [embed],
      ephemeral: true,
    });
  }

  return interaction.reply({
    content: 'Unknown command option.',
    ephemeral: true,
  });
}

export default {
  commandData,
  handleCommand,
};
