'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceKind, isTrustedUrl, canStartProcessAudio } = require('../src/capture-policy');

test('classifica somente fontes reconhecidas', () => {
    assert.equal(sourceKind('window:123:0'), 'window');
    assert.equal(sourceKind('screen:0:0'), 'screen');
    assert.equal(sourceKind('tab:123'), null);
});

test('aceita somente a origem de desenvolvimento exata', () => {
    const origin = 'https://mirotalk-dev.5-161-64-137.sslip.io';
    assert.equal(isTrustedUrl(`${origin}/join/link`, origin), true);
    assert.equal(isTrustedUrl('https://mirotalk-dev.5-161-64-137.sslip.io.attacker.invalid/', origin), false);
    assert.equal(isTrustedUrl('not-a-url', origin), false);
});

test('autoriza apenas o PID positivo escolhido pelo usuário', () => {
    assert.equal(canStartProcessAudio(4321, 4321), true);
    assert.equal(canStartProcessAudio(4321, 9999), false);
    assert.equal(canStartProcessAudio(undefined, 4321), false);
    assert.equal(canStartProcessAudio(4321, -1), false);
});
