import DiceBox from '@3d-dice/dice-box-threejs';

const THROW_DURATION = 4800;
const random = (min, max) => min + Math.random() * (max - min);

// These two faces are local canvas artwork, so the coin never needs a model,
// font, texture download or the library's optional silvercoin asset pack.
function coinFace(label, template) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    const gold = context.createRadialGradient(175, 145, 20, 256, 256, 280);
    gold.addColorStop(0, '#fff3bb');
    gold.addColorStop(0.5, '#e9bc5b');
    gold.addColorStop(1, '#99602a');
    context.fillStyle = gold;
    context.fillRect(0, 0, 512, 512);
    context.strokeStyle = '#835027';
    context.lineWidth = 9;
    context.beginPath();
    context.arc(256, 256, 219, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = '#fff0b0';
    context.lineWidth = 4;
    context.beginPath();
    context.arc(256, 256, 204, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = '#6a421e';
    context.strokeStyle = '#6a421e';
    if (label === 'CARA') {
        // A profile in relief, kept broad enough to read at phone size.
        context.beginPath();
        context.moveTo(175, 328);
        context.bezierCurveTo(183, 294, 218, 298, 219, 272);
        context.bezierCurveTo(168, 253, 164, 188, 186, 150);
        context.bezierCurveTo(216, 98, 290, 107, 310, 154);
        context.lineTo(317, 183);
        context.lineTo(342, 211);
        context.lineTo(320, 223);
        context.bezierCurveTo(323, 262, 299, 271, 275, 272);
        context.lineTo(273, 292);
        context.bezierCurveTo(301, 297, 320, 307, 333, 328);
        context.closePath();
        context.fill();
        context.fillStyle = '#ffe6a0';
        context.beginPath();
        context.arc(294, 189, 5, 0, Math.PI * 2);
        context.fill();
    } else {
        context.beginPath();
        context.moveTo(160, 185);
        context.lineTo(213, 226);
        context.lineTo(256, 148);
        context.lineTo(299, 226);
        context.lineTo(352, 185);
        context.lineTo(327, 299);
        context.lineTo(185, 299);
        context.closePath();
        context.fill();
        context.lineWidth = 13;
        context.beginPath();
        context.moveTo(184, 321);
        context.lineTo(328, 321);
        context.stroke();
        for (const [x, y] of [
            [159, 170],
            [256, 131],
            [353, 170],
        ]) {
            context.beginPath();
            context.arc(x, y, 11, 0, Math.PI * 2);
            context.fill();
        }
    }
    context.fillStyle = '#5d381a';
    context.font = 'bold 49px sans-serif';
    context.textAlign = 'center';
    context.fillText(label, 256, 394);
    const material = template.clone();
    // Reuse the renderer's bundled Three constructors rather than ship another
    // Three copy only to create two local textures.
    material.map = new template.map.constructor(canvas);
    material.map.name = `coin-${label.toLowerCase()}`;
    material.bumpMap = null;
    material.color.setHex(0xffffff);
    material.specular?.setHex(0xffedb8);
    material.metalness = 0.24;
    material.roughness = 0.32;
    material.shininess = 55;
    material.depthTest = true;
    material.transparent = false;
    return material;
}

// One lazily-created WebGL scene. The pinned library still pre-simulates the
// physical throw and assigns its final faces to the server-supplied outcomes.
export async function createDiceScene(container) {
    container.id ||= `room-dice-${crypto.randomUUID()}`;
    const box = new DiceBox(`#${CSS.escape(container.id)}`, {
        sounds: false,
        shadows: true,
        theme_colorset: 'white',
        theme_texture: 'none',
        theme_material: 'plastic',
        assetPath: '/captcha/play/',
        baseScale: 76,
        gravity_multiplier: 190,
        strength: 1,
        iterationLimit: 480,
    });
    // setLabels registers/appends faces; calling it on a populated preset leaves
    // the original blank/1/2 materials in place. Replace, do not append.
    const coin = box.DiceFactory.get('d2');
    coin.labels = [];
    coin.setLabels(['CARA', 'COROA']);
    const d10 = box.DiceFactory.get('d10');
    d10.labels = [];
    d10.setLabels(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    // The library installs an anonymous window resize listener. Own resizing here
    // instead, so disposal can remove it and a phone rotation cannot alter the
    // already simulated collision path midway through a throw.
    box.resizeWorld = () => {};
    try {
        await box.initialize();
    } catch (error) {
        box.renderer?.dispose();
        box.renderer?.domElement.remove();
        throw error;
    }
    box.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    const coinTemplate = box.DiceFactory.create('d2').material;
    // Match the rendered 32-sided rim; an eight-sided collider can stop upright
    // on a broad edge facet instead of falling onto a readable face.
    const coinShape = box.DiceFactory.geometries.d2.cannon_shape;
    box.DiceFactory.geometries.d2.cannon_shape = new coinShape.constructor(
        coinShape.radiusTop,
        coinShape.radiusBottom,
        coinShape.height,
        32
    );
    const rim = coinTemplate[0].clone();
    rim.map = rim.bumpMap = null;
    rim.color.setHex(0xb38336);
    rim.specular?.setHex(0xffe0a0);
    rim.metalness = 0.65;
    rim.roughness = 0.3;
    rim.shininess = 65;
    rim.depthTest = true;
    const coinMaterials = [rim, coinFace('CARA', coinTemplate[1]), coinFace('COROA', coinTemplate[2])];
    const ownedMaterials = new Set([...coinTemplate, ...coinMaterials]);
    const ownedGeometries = new Set(Object.values(box.DiceFactory.geometries));
    const swapDiceFace = box.swapDiceFace.bind(box);
    box.swapDiceFace = (die, value) => {
        swapDiceFace(die, value);
        ownedGeometries.add(die.geometry);
    };
    for (const contact of box.world.contactmaterials) {
        contact.restitution = contact.materials.includes(box.box_body.desk.material) ? 0.52 : 0.55;
        contact.friction = 0.58;
    }
    const notationVectors = box.getNotationVectors.bind(box);
    box.getNotationVectors = (...args) => {
        const notation = notationVectors(...args);
        const side = Math.random() < 0.5 ? -1 : 1;
        for (const [index, vector] of notation.vectors.entries()) {
            const isCoin = vector.type === 'd2';
            const axis = [random(-1, 1), random(-1, 1), random(-1, 1)];
            const length = Math.hypot(...axis) || 1;
            vector.pos = {
                x: side * box.display.containerWidth * (isCoin ? 0.22 : 0.62),
                y: random(-0.37, 0.37) * box.display.containerHeight + (index % 2 ? 25 : -25),
                z: random(130, 190),
            };
            vector.velocity = {
                x: -side * random(isCoin ? 170 : 560, isCoin ? 260 : 780),
                y: random(-160, 160),
                z: random(isCoin ? 650 : 510, isCoin ? 820 : 690),
            };
            vector.angle = {
                x: random(29, 37) * (Math.random() < 0.5 ? -1 : 1),
                y: random(isCoin ? 3 : 27, isCoin ? 7 : 35),
                z: random(6, 13),
            };
            vector.axis = { x: axis[0] / length, y: axis[1] / length, z: axis[2] / length, a: Math.random() };
        }
        return notation;
    };
    function coinUpFace(die) {
        // CylinderGeometry stores whole caps as indexed groups. The library's
        // generic groupIndex*9 normal lookup instead samples the side wall.
        // Inspect each real cap normal, so the visible face and forced outcome
        // agree even after swapDiceFace remaps a cap's material index.
        const normal = die.geometry.getAttribute('normal').array;
        const index = die.geometry.index?.array;
        const { x, y, z, w } = die.body.quaternion;
        let highest = -Infinity,
            value = 1;
        for (const group of die.geometry.groups) {
            if (group.materialIndex !== 1 && group.materialIndex !== 2) continue;
            const offset = (index ? index[group.start] : group.start) * 3;
            const up =
                2 * (x * z - y * w) * normal[offset] +
                2 * (y * z + x * w) * normal[offset + 1] +
                (1 - 2 * x * x - 2 * y * y) * normal[offset + 2];
            if (up > highest) {
                highest = up;
                value = group.materialIndex;
            }
        }
        return value;
    }
    const spawnDice = box.spawnDice.bind(box);
    box.spawnDice = (vector, existing) => {
        spawnDice(vector, existing);
        const die = existing || box.diceList.at(-1);
        die.body.linearDamping = 0.25;
        die.body.angularDamping = die.shape === 'd2' ? 0.52 : 0.3;
        die.body.sleepSpeedLimit = die.shape === 'd2' ? 2 : 6;
        die.body.sleepTimeLimit = 0.25;
        if (die.shape === 'd2') {
            // A sub-pixel mass offset breaks the numerical edge-balancing case.
            // The room outcome is still assigned independently by face mapping.
            die.body.shapeOffsets[0].set(0, 0.7, 0);
            die.body.updateMassProperties();
        }
        if (!existing) {
            for (const material of die.material) ownedMaterials.add(material);
            const faceValue = die.getFaceValue.bind(die);
            die.getFaceValue = () => {
                if (die.shape === 'd2') {
                    const value = coinUpFace(die);
                    return { value, label: value === 1 ? 'CARA' : 'COROA', reason: die.resultReason };
                }
                const result = faceValue();
                return {
                    ...result,
                    label: die.shape === 'd2' ? (result.value === 1 ? 'CARA' : 'COROA') : String(result.value),
                };
            };
            if (die.shape === 'd2') {
                for (const material of die.material) {
                    material.dispose();
                    ownedMaterials.delete(material);
                }
                die.material = coinMaterials;
            }
        }
    };
    let disposed = false,
        frameId,
        simulationSteps = 1,
        physicalFrames = [],
        finish,
        pendingSize = false,
        rolling = false,
        activeRolls = [];
    const simulateThrow = box.simulateThrow.bind(box);
    const worldStep = box.world.step.bind(box.world);
    function captureFrame() {
        return box.diceList.map((die) => ({
            position: die.body.position.toArray(),
            quaternion: die.body.quaternion.toArray(),
            angularVelocity: die.body.angularVelocity.toArray(),
        }));
    }
    box.simulateThrow = () => {
        physicalFrames = [captureFrame()];
        box.world.step = (...args) => {
            worldStep(...args);
            physicalFrames.push(captureFrame());
        };
        try {
            simulateThrow();
        } finally {
            box.world.step = worldStep;
        }
        simulationSteps = Math.max(1, physicalFrames.length - 1);
    };
    // Replay the actual Cannon trajectory rather than integrate it twice. A
    // second integration can differ by a sleep/contact tick and disagree with
    // the pre-simulated forced face. Presentation alone lasts a readable 4.8s.
    box.animateThrow = (_thread, completed) => {
        const startedAt = performance.now();
        box.animstate = 'throw';
        box.iteration = box.steps = 0;
        for (const die of box.diceList) die.playbackQuaternion = die.quaternion.clone();
        const render = (time) => {
            if (disposed || !rolling) return;
            const progress = Math.max(0, Math.min(1, (time - startedAt) / THROW_DURATION));
            const step = progress * simulationSteps;
            const before = Math.floor(step),
                after = Math.min(simulationSteps, before + 1);
            const blend = step - before;
            for (const [index, die] of box.diceList.entries()) {
                const a = physicalFrames[before][index],
                    b = physicalFrames[after][index];
                die.body.position.set(...a.position.map((value, axis) => value + (b.position[axis] - value) * blend));
                die.position.copy(die.body.position);
                die.quaternion.fromArray(a.quaternion).slerp(die.playbackQuaternion.fromArray(b.quaternion), blend);
                die.body.quaternion.copy(die.quaternion);
                die.body.angularVelocity.set(...a.angularVelocity);
            }
            box.iteration = box.steps = before;
            box.renderer.render(box.scene, box.camera);
            if (progress === 1) {
                for (const die of box.diceList) die.body.sleep();
                box.throwFinished();
                box.running = box.rolling = false;
                box.animstate = 'afterthrow';
                completed?.call(box, box.notationVectors);
                return;
            }
            frameId = requestAnimationFrame(render);
        };
        frameId = requestAnimationFrame(render);
    };
    function resize(force = false) {
        if (disposed) return;
        const width = container.clientWidth,
            height = container.clientHeight;
        if (!width || !height) return;
        if ((rolling || box.diceList.length) && !force) {
            pendingSize = true;
            box.renderer.setSize(width, height);
            box.camera.aspect = width / height;
            box.camera.position.z =
                (Math.max(box.display.containerHeight, box.display.containerWidth / box.camera.aspect) * 1.06) /
                Math.tan(Math.PI / 18);
            box.camera.far = box.camera.position.z * 1.5;
            box.camera.updateProjectionMatrix();
        } else {
            box.setDimensions({ x: width, y: height });
            pendingSize = false;
        }
        // setSize clears the drawing buffer. A settled throw has no animation
        // frame left to repaint it after a phone rotation or panel resize.
        box.renderer.render(box.scene, box.camera);
    }
    const observer = new ResizeObserver(() => resize());
    observer.observe(container);
    function stop() {
        cancelAnimationFrame(frameId);
        box.running = box.rolling = rolling = false;
        container.dataset.phase = 'idle';
        finish?.({ cancelled: true, sets: [] });
        finish = undefined;
    }
    return {
        async roll(rolls) {
            if (disposed) return { cancelled: true, sets: [] };
            if (rolling) throw new Error('Aguarde a rolagem atual terminar.');
            if (
                pendingSize ||
                container.clientWidth !== box.display.currentWidth * 2 ||
                container.clientHeight !== box.display.currentHeight * 2
            )
                resize(true);
            // Cached geometry/textures are shared; retire only per-roll clones
            // and materials so repeated throws do not accumulate GPU objects.
            const cachedGeometry = new Set(Object.values(box.DiceFactory.geometries));
            for (const die of box.diceList) {
                if (!cachedGeometry.has(die.geometry)) {
                    die.geometry.dispose();
                    ownedGeometries.delete(die.geometry);
                }
                for (const material of die.material)
                    if (!coinMaterials.includes(material)) {
                        material.dispose();
                        ownedMaterials.delete(material);
                    }
            }
            rolling = true;
            activeRolls = rolls;
            container.dataset.phase = 'rolling';
            return await new Promise((resolve, reject) => {
                finish = resolve;
                const notation = rolls.map((r) => `1${r.kind === 'coin' ? 'd2' : r.kind}`).join('+');
                box.roll(`${notation}@${rolls.map((r) => r.value).join(',')}`).then(
                    (result) => {
                        if (!rolling) return;
                        rolling = false;
                        finish = undefined;
                        container.dataset.phase = 'settled';
                        resolve(result);
                        if (pendingSize) resize();
                    },
                    (error) => {
                        cancelAnimationFrame(frameId);
                        box.running = box.rolling = rolling = false;
                        finish = undefined;
                        container.dataset.phase = 'idle';
                        reject(error);
                    }
                );
            });
        },
        // Geometry-only snapshot for renderer/layout diagnostics. It does not
        // determine a result; the server's result remains authoritative.
        snapshot() {
            return {
                rolling,
                dice: box.diceList.map((die, index) => ({
                    id: activeRolls[index]?.id,
                    kind: activeRolls[index]?.kind,
                    position: die.position.toArray(),
                    quaternion: die.quaternion.toArray(),
                    angularVelocity: die.body.angularVelocity.toArray(),
                    faces: die.shape === 'd2' ? die.material.slice(1).map((material) => material.map.name) : [],
                    visibleCoinFace: die.shape === 'd2' ? die.material[coinUpFace(die)].map.name : undefined,
                    coinUpAlignment:
                        die.shape === 'd2'
                            ? Math.abs(
                                  2 *
                                      (die.body.quaternion.y * die.body.quaternion.z +
                                          die.body.quaternion.x * die.body.quaternion.w)
                              )
                            : undefined,
                })),
            };
        },
        stop,
        dispose() {
            if (disposed) return;
            stop();
            disposed = true;
            observer.disconnect();
            for (const die of box.diceList) {
                box.scene.remove(die);
                box.world.removeBody(die.body);
            }
            const geometries = new Set(ownedGeometries),
                materials = new Set(ownedMaterials),
                textures = new Set();
            box.scene.traverse((object) => {
                if (object.geometry) geometries.add(object.geometry);
                for (const material of Array.isArray(object.material) ? object.material : [object.material])
                    if (material) materials.add(material);
            });
            for (const geometry of Object.values(box.DiceFactory.geometries)) geometries.add(geometry);
            for (const geometry of geometries) geometry.dispose();
            for (const material of materials) {
                for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
                material.dispose();
            }
            for (const texture of textures) texture.dispose();
            box.renderer.dispose();
            box.renderer.forceContextLoss();
            box.renderer.domElement.remove();
        },
    };
}
