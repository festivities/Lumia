import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttachment } from '../src/video.js';

describe('classifyAttachment', () => {
  const allGates = { channelMode: 'images+videos', animationScope: 'all' };
  const imagesOnlyGates = { channelMode: 'images', animationScope: 'all' };
  const autoplayOnlyGates = { channelMode: 'images+videos', animationScope: 'autoplay' };

  test('classifies image contentTypes as image regardless of gates', () => {
    assert.equal(classifyAttachment({ contentType: 'image/png' }, allGates), 'image');
    assert.equal(classifyAttachment({ contentType: 'image/jpeg' }, imagesOnlyGates), 'image');
    assert.equal(classifyAttachment({ contentType: 'image/gif' }, autoplayOnlyGates), 'image');
    assert.equal(classifyAttachment({ contentType: 'image/webp' }, imagesOnlyGates), 'image');
  });

  test('classifies video contentTypes respecting channel mode and animation scope', () => {
    // Mode images+videos & scope all -> player-video
    assert.equal(classifyAttachment({ contentType: 'video/mp4' }, allGates), 'player-video');
    assert.equal(classifyAttachment({ contentType: 'video/webm' }, allGates), 'player-video');

    // Channel mode images -> null (video blocked)
    assert.equal(classifyAttachment({ contentType: 'video/mp4' }, imagesOnlyGates), null);

    // Global scope autoplay -> null (video blocked)
    assert.equal(classifyAttachment({ contentType: 'video/mp4' }, autoplayOnlyGates), null);
  });

  test('handles null or octet-stream contentTypes via file extensions', () => {
    // Player video extensions
    assert.equal(classifyAttachment({ contentType: null, name: 'clip.mp4' }, allGates), 'player-video');
    assert.equal(classifyAttachment({ contentType: 'application/octet-stream', name: 'movie.mkv' }, allGates), 'player-video');
    assert.equal(classifyAttachment({ contentType: null, name: 'clip.mp4' }, imagesOnlyGates), null);

    // Image extensions
    assert.equal(classifyAttachment({ contentType: null, name: 'render.png' }, imagesOnlyGates), 'image');
    assert.equal(classifyAttachment({ contentType: 'application/octet-stream', name: 'anim.gif' }, autoplayOnlyGates), 'image');

    // Non-media extensions -> null
    assert.equal(classifyAttachment({ contentType: null, name: 'document.pdf' }, allGates), null);
    assert.equal(classifyAttachment({ contentType: 'application/octet-stream', name: 'archive.zip' }, allGates), null);
    assert.equal(classifyAttachment(null, allGates), null);
  });
});
