'use strict';

// Room-owned rolls. The hub subscribes without owning a roll's lifetime.
window.RoomUtilities = (() => {
    let socket,
        session = '',
        rolls = [],
        offset = 0,
        timer,
        online = false,
        generation = 0,
        pending = false,
        nextAt = 0;
    const subscribers = new Set(),
        handlers = [];
    const now = () => Date.now() + offset;
    const result = (roll) => (roll.kind === 'coin' ? (roll.value === 1 ? 'Cara' : 'Coroa') : String(roll.value));
    const current = () => ({
        session,
        rolls: rolls.slice().sort((a, b) => b.sequence - a.sequence),
        online,
        busy: pending || now() < nextAt,
        now: now(),
    });
    function publish(incoming = []) {
        clearTimeout(timer);
        for (const fn of subscribers) fn(current(), incoming);
        const future = rolls.filter((r) => r.revealAt > now()).map((r) => r.revealAt);
        if (future.length) timer = setTimeout(() => publish(), Math.max(20, Math.min(...future) - now() + 10));
    }
    function ingest(data, live = false) {
        if (!data || typeof data.session !== 'string') return;
        if (Number.isFinite(data.now)) offset = data.now - Date.now();
        if (session !== data.session) {
            session = data.session;
            rolls = [];
        }
        const fresh = [];
        for (const r of data.rolls || [data.roll]) {
            const sides = { d6: 6, d10: 10, d20: 20, coin: 2 }[r?.kind];
            if (
                !r ||
                typeof r.id !== 'string' ||
                !Number.isInteger(r.sequence) ||
                !Number.isFinite(r.revealAt) ||
                !sides ||
                !Number.isInteger(r.value) ||
                r.value < 1 ||
                r.value > sides
            )
                continue;
            if (rolls.some((x) => x.id === r.id)) continue;
            rolls.push(r);
            if (live && r.revealAt > now()) fresh.push(r);
        }
        rolls.sort((a, b) => a.sequence - b.sequence);
        rolls = rolls.slice(-50);
        publish(fresh);
    }
    function listen(event, fn) {
        socket.on(event, fn);
        handlers.push([event, fn]);
    }
    function history() {
        if (!socket?.connected) return;
        const g = generation;
        socket.emit('utilityHistory', {}, (data) => {
            if (g === generation) ingest(data);
        });
    }
    function connect(value) {
        if (socket === value) {
            history();
            return;
        }
        disconnect();
        socket = value;
        online = !!socket.connected;
        listen('utilityRolled', (data) => ingest(data, true));
        listen('connect', () => {
            online = true;
            history();
            publish();
        });
        listen('disconnect', () => {
            online = false;
            publish();
        });
        history();
        publish();
    }
    function disconnect() {
        generation++;
        clearTimeout(timer);
        for (const [event, fn] of handlers.splice(0)) socket?.off(event, fn);
        socket = null;
        session = '';
        rolls = [];
        online = false;
        pending = false;
        nextAt = 0;
        publish();
    }
    async function roll(kind) {
        if (!online || !socket?.connected) throw new Error('A conexão com a sala está sendo restabelecida.');
        if (pending || now() < nextAt) throw new Error('Espere um instante antes de rolar novamente.');
        pending = true;
        publish();
        const g = generation,
            requestId = crypto.randomUUID();
        try {
            const data = await new Promise((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error('Sem confirmação. Consulte o histórico antes de rolar novamente.')),
                    8000
                );
                socket.emit('utilityRoll', { kind, requestId }, (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                });
            });
            if (g !== generation) return;
            if (data.error) throw new Error(data.error);
            nextAt = now() + 1200;
            ingest(data, true);
        } finally {
            if (g === generation) {
                pending = false;
                publish();
                setTimeout(() => {
                    if (g === generation) publish();
                }, 1250);
            }
        }
    }
    return {
        connect,
        disconnect,
        roll,
        current,
        now,
        result,
        subscribe(fn) {
            subscribers.add(fn);
            fn(current(), []);
            return () => subscribers.delete(fn);
        },
    };
})();
