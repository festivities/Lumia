import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONFIG_TMP_FILE = path.join(DATA_DIR, 'config.json.tmp');

export const DEFAULT_GUILD_CONFIG = Object.freeze({
  channels: {}, // { "<channelId>": { mode: "images+videos" } }
  animationScope: 'all', // "all" | "autoplay"
  maxFileMb: 50, // 1..500 MB threshold
  timeoutMs: 3600000, // 1 hour default
  staffChannelId: null,
  staffRoleId: null,
});

class SettingsManager {
  constructor() {
    this._data = null;
    this._savePromise = Promise.resolve();
  }

  _migrateGuild(guild) {
    let migrated = false;

    // Migration: convert array channels to map { id: { mode: "images+videos" } }
    if (Array.isArray(guild.channels)) {
      const newChannels = {};
      for (const chId of guild.channels) {
        if (typeof chId === 'string' && chId.length > 0) {
          newChannels[chId] = { mode: 'images+videos' };
        }
      }
      guild.channels = newChannels;
      migrated = true;
    } else if (!guild.channels || typeof guild.channels !== 'object') {
      guild.channels = {};
      migrated = true;
    }

    if (guild.animationScope !== 'all' && guild.animationScope !== 'autoplay') {
      guild.animationScope = DEFAULT_GUILD_CONFIG.animationScope;
      migrated = true;
    }

    if (typeof guild.maxFileMb !== 'number' || guild.maxFileMb < 1 || guild.maxFileMb > 500) {
      guild.maxFileMb = DEFAULT_GUILD_CONFIG.maxFileMb;
      migrated = true;
    }

    return migrated;
  }

  _ensureLoaded() {
    if (this._data !== null) return;

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(CONFIG_FILE)) {
      this._data = { guilds: {} };
      const content = JSON.stringify(this._data, null, 2);
      fs.writeFileSync(CONFIG_TMP_FILE, content, 'utf-8');
      fs.renameSync(CONFIG_TMP_FILE, CONFIG_FILE);
      return;
    }

    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      this._data = JSON.parse(raw);
      if (!this._data || typeof this._data !== 'object' || !this._data.guilds) {
        this._data = { guilds: {} };
      }

      let needsSave = false;
      for (const [guildId, guildCfg] of Object.entries(this._data.guilds)) {
        if (this._migrateGuild(guildCfg)) {
          needsSave = true;
          this._data.guilds[guildId] = guildCfg;
        }
      }

      if (needsSave) {
        this.save();
      }
    } catch (err) {
      console.error('[Settings] Failed to parse config.json, initializing empty:', err);
      this._data = { guilds: {} };
    }
  }

  /**
   * Retrieves the guild configuration merged with defaults.
   * @param {string} guildId
   * @returns {{
   *   channels: Record<string, { mode: 'images' | 'images+videos' }>,
   *   animationScope: 'all' | 'autoplay',
   *   maxFileMb: number,
   *   timeoutMs: number,
   *   staffChannelId: string | null,
   *   staffRoleId: string | null
   * }}
   */
  getGuild(guildId) {
    this._ensureLoaded();
    const guild = this._data.guilds[guildId] || {};

    const rawChannels = typeof guild.channels === 'object' && !Array.isArray(guild.channels)
      ? guild.channels
      : {};

    const mergedChannels = {};
    for (const [chId, val] of Object.entries(rawChannels)) {
      mergedChannels[chId] = {
        mode: val?.mode === 'images' ? 'images' : 'images+videos',
      };
    }

    return {
      channels: mergedChannels,
      animationScope: guild.animationScope === 'autoplay' ? 'autoplay' : 'all',
      maxFileMb: typeof guild.maxFileMb === 'number' && guild.maxFileMb >= 1 && guild.maxFileMb <= 500
        ? Math.round(guild.maxFileMb)
        : DEFAULT_GUILD_CONFIG.maxFileMb,
      timeoutMs: typeof guild.timeoutMs === 'number' ? guild.timeoutMs : DEFAULT_GUILD_CONFIG.timeoutMs,
      staffChannelId: guild.staffChannelId ?? DEFAULT_GUILD_CONFIG.staffChannelId,
      staffRoleId: guild.staffRoleId ?? DEFAULT_GUILD_CONFIG.staffRoleId,
    };
  }

  /**
   * Internal helper to update a guild config and persist.
   * @param {string} guildId
   * @param {Function} updater
   * @returns {Promise<void>}
   */
  async _updateGuild(guildId, updater) {
    this._ensureLoaded();
    const current = this.getGuild(guildId);
    const updated = updater(current);
    this._data.guilds[guildId] = {
      channels: updated.channels,
      animationScope: updated.animationScope,
      maxFileMb: updated.maxFileMb,
      timeoutMs: updated.timeoutMs,
      staffChannelId: updated.staffChannelId,
      staffRoleId: updated.staffRoleId,
    };
    return this.save();
  }

  /**
   * Adds or updates a channel in the monitored list.
   * @param {string} guildId
   * @param {string} channelId
   * @param {'images' | 'images+videos'} [mode='images+videos']
   * @returns {Promise<void>}
   */
  async addChannel(guildId, channelId, mode = 'images+videos') {
    return this._updateGuild(guildId, (cfg) => {
      const validMode = mode === 'images' ? 'images' : 'images+videos';
      cfg.channels[channelId] = { mode: validMode };
      return cfg;
    });
  }

  /**
   * Removes a channel from the monitored list.
   * @param {string} guildId
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async removeChannel(guildId, channelId) {
    return this._updateGuild(guildId, (cfg) => {
      delete cfg.channels[channelId];
      return cfg;
    });
  }

  /**
   * Sets mode for an existing channel.
   * @param {string} guildId
   * @param {string} channelId
   * @param {'images' | 'images+videos'} mode
   * @returns {Promise<boolean>} True if channel existed and was updated
   */
  async setChannelMode(guildId, channelId, mode) {
    let existed = false;
    await this._updateGuild(guildId, (cfg) => {
      if (cfg.channels[channelId]) {
        existed = true;
        cfg.channels[channelId].mode = mode === 'images' ? 'images' : 'images+videos';
      }
      return cfg;
    });
    return existed;
  }

  /**
   * Sets the global animation scope ('all' or 'autoplay').
   * @param {string} guildId
   * @param {'all' | 'autoplay'} scope
   * @returns {Promise<void>}
   */
  async setAnimationScope(guildId, scope) {
    return this._updateGuild(guildId, (cfg) => {
      cfg.animationScope = scope === 'autoplay' ? 'autoplay' : 'all';
      return cfg;
    });
  }

  /**
   * Sets the maximum file size threshold in MB (1..500).
   * @param {string} guildId
   * @param {number} mb
   * @returns {Promise<void>}
   */
  async setMaxFileMb(guildId, mb) {
    return this._updateGuild(guildId, (cfg) => {
      cfg.maxFileMb = Math.min(Math.max(Math.round(mb), 1), 500);
      return cfg;
    });
  }

  /**
   * Updates timeout duration in milliseconds.
   * @param {string} guildId
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async setTimeoutMs(guildId, timeoutMs) {
    return this._updateGuild(guildId, (cfg) => {
      cfg.timeoutMs = timeoutMs;
      return cfg;
    });
  }

  /**
   * Sets staff alert channel.
   * @param {string} guildId
   * @param {string | null} staffChannelId
   * @returns {Promise<void>}
   */
  async setStaffChannelId(guildId, staffChannelId) {
    return this._updateGuild(guildId, (cfg) => {
      cfg.staffChannelId = staffChannelId;
      return cfg;
    });
  }

  /**
   * Sets staff role to ping.
   * @param {string} guildId
   * @param {string | null} staffRoleId
   * @returns {Promise<void>}
   */
  async setStaffRoleId(guildId, staffRoleId) {
    return this._updateGuild(guildId, (cfg) => {
      cfg.staffRoleId = staffRoleId;
      return cfg;
    });
  }

  /**
   * Atomically writes configuration to disk via tmp file + rename.
   * Serializes consecutive saves.
   * @returns {Promise<void>}
   */
  async save() {
    this._ensureLoaded();
    this._savePromise = this._savePromise.then(async () => {
      if (!fs.existsSync(DATA_DIR)) {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
      }
      const serialized = JSON.stringify(this._data, null, 2);
      await fs.promises.writeFile(CONFIG_TMP_FILE, serialized, 'utf-8');
      await fs.promises.rename(CONFIG_TMP_FILE, CONFIG_FILE);
    }).catch((err) => {
      console.error('[Settings] Error saving config.json:', err);
    });

    return this._savePromise;
  }
}

export const settings = new SettingsManager();
export default settings;
