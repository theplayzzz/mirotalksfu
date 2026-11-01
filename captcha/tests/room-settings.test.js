import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stretch } from '../src/games/rooftops-game.js';
import { buildWebCourse } from '../src/games/web-course.js';

test('room intensity adjusts rooftop difficulty without changing launch physics', () => {
    const easy = new Stretch({ intensity: 0.7 }),
        normal = new Stretch({ intensity: 0.9 }),
        hard = new Stretch({ intensity: 1.5 });
    assert.ok(easy.buildings[1].w > normal.buildings[1].w);
    assert.ok(hard.buildings[1].w < normal.buildings[1].w);
    assert.equal(normal.buildings[1].w, 126);
    assert.equal(hard.launchX, normal.launchX);
});
test('room intensity narrows web openings; baseline course retains the approved geometry', () => {
    const normal = buildWebCourse(25, 514),
        hard = buildWebCourse(25, 514, 1.5),
        easy = buildWebCourse(25, 514, 0.7);
    const gap = (course) => course.gates[2].spans[1].y - (course.gates[2].spans[0].y + course.gates[2].spans[0].h);
    assert.equal(gap(normal), 202);
    assert.ok(gap(hard) < gap(normal));
    assert.ok(gap(easy) > gap(normal));
});
