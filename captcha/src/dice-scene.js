import DiceBox from '@3d-dice/dice-box-threejs';

// One lazily-created WebGL scene. Outcomes are supplied by the room server;
// the library pre-simulates the throw and labels the final physical faces.
export async function createDiceScene(container) {
    container.id ||= `room-dice-${crypto.randomUUID()}`;
    const box = new DiceBox(`#${CSS.escape(container.id)}`, {
        sounds: false,
        shadows: true,
        theme_colorset: 'white',
        theme_texture: 'none',
        theme_material: 'plastic',
        assetPath: '/captcha/play/',
        baseScale: 65,
        strength: 0.7,
        iterationLimit: 240,
    });
    box.DiceFactory.get('d2').setLabels(['CARA', 'COROA']);
    box.DiceFactory.get('d10').setLabels(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    await box.initialize();
    box.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    const observer = new ResizeObserver(() => {
        if (container.clientWidth && container.clientHeight)
            box.setDimensions({ x: container.clientWidth, y: container.clientHeight });
    });
    observer.observe(container);
    let disposed = false;
    return {
        async roll(rolls) {
            if (disposed) return;
            const notation = rolls.map((r) => `1${r.kind === 'coin' ? 'd2' : r.kind}`).join('+');
            return await box.roll(`${notation}@${rolls.map((r) => r.value).join(',')}`);
        },
        stop() {
            box.running = false;
            box.rolling = false;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            observer.disconnect();
            box.running = false;
            box.rolling = false;
            box.clearDice();
            box.scene.traverse((object) => {
                object.geometry?.dispose();
                const materials = Array.isArray(object.material) ? object.material : [object.material];
                for (const material of materials) {
                    if (!material) continue;
                    for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
                    material.dispose();
                }
            });
            box.renderer.dispose();
            box.renderer.forceContextLoss();
            container.replaceChildren();
        },
    };
}
