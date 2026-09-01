import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../src/settings.js';

describe('settings', () => {
  beforeEach(() => {
    // Reset in-memory data for testing
    settings._data = { guilds: {} };
  });

  test('returns default guild configuration for unconfigured guild', () => {
    const cfg = settings.getGuild('guild_123');
    assert.deepEqual(cfg, {
      channels: {},
      animationScope: 'all',
      maxFileMb: 50,
      timeoutMs: 3600000,
      staffChannelId: null,
      staffRoleId: null,
    });
  });

  test('migrates array channels to map format', () => {
    settings._data = {
      guilds: {
        guild_legacy: {
          channels: ['ch_1', 'ch_2'],
          timeoutMs: 1800000,
        },
      },
    };

    settings._migrateGuild(settings._data.guilds.guild_legacy);
    const cfg = settings.getGuild('guild_legacy');

    assert.deepEqual(cfg.channels, {
      ch_1: { mode: 'images+videos' },
      ch_2: { mode: 'images+videos' },
    });
    assert.equal(cfg.animationScope, 'all');
    assert.equal(cfg.maxFileMb, 50);
    assert.equal(cfg.timeoutMs, 1800000);
  });

  test('adds and removes channels with modes', async () => {
    await settings.addChannel('guild_test', 'ch_100', 'images');
    let cfg = settings.getGuild('guild_test');
    assert.deepEqual(cfg.channels.ch_100, { mode: 'images' });

    await settings.addChannel('guild_test', 'ch_200', 'images+videos');
    cfg = settings.getGuild('guild_test');
    assert.deepEqual(cfg.channels.ch_200, { mode: 'images+videos' });

    await settings.setChannelMode('guild_test', 'ch_100', 'images+videos');
    cfg = settings.getGuild('guild_test');
    assert.deepEqual(cfg.channels.ch_100, { mode: 'images+videos' });

    await settings.removeChannel('guild_test', 'ch_100');
    cfg = settings.getGuild('guild_test');
    assert.equal(cfg.channels.ch_100, undefined);
    assert.deepEqual(cfg.channels.ch_200, { mode: 'images+videos' });
  });

  test('updates animation scope and maxFileMb with clamping', async () => {
    await settings.setAnimationScope('guild_test', 'autoplay');
    let cfg = settings.getGuild('guild_test');
    assert.equal(cfg.animationScope, 'autoplay');

    await settings.setMaxFileMb('guild_test', 100);
    cfg = settings.getGuild('guild_test');
    assert.equal(cfg.maxFileMb, 100);

    // Clamping limits 1..500
    await settings.setMaxFileMb('guild_test', 9999);
    cfg = settings.getGuild('guild_test');
    assert.equal(cfg.maxFileMb, 500);

    await settings.setMaxFileMb('guild_test', -5);
    cfg = settings.getGuild('guild_test');
    assert.equal(cfg.maxFileMb, 1);
  });
});
