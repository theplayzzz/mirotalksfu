'use strict';

// Room-owned rolls. The hub subscribes without owning a roll's lifetime.
window.RoomUtilities = (() => {
    let socket,
        session = '',
        rolls = [],
        selfRollIds = new Set(),
        offset = 0,
        timer,
        historyTimer,
        online = false,
        clockReady = false,
        synchronizing = false,
        generation = 0,
        historyGeneration = 0,
        pending = false,
        nextAt = 0;
    const subscribers = new Set(),
        handlers = [];
    const now = () => Date.now() + offset;
    const result = (roll) => (roll.kind === 'coin' ? (roll.value === 1 ? 'Cara' : 'Coroa') : String(roll.value));
    const current = () => ({
        session,
        rolls: rolls.slice().sort((a, b) => b.sequence - a.sequence),
        selfRollIds: [...selfRollIds],
        online,
        busy: pending || synchronizing || now() < nextAt,
        busyUntil: nextAt,
        pending,
        synchronizing,
        now: now(),
    });
    function publish(incoming = []) {
        clearTimeout(timer);
        for (const fn of subscribers) fn(current(), incoming);
        const future = rolls.filter((r) => r.revealAt > now()).map((r) => r.revealAt);
        if (nextAt > now()) future.push(nextAt);
        if (future.length) timer = setTimeout(() => publish(), Math.max(20, Math.min(...future) - now() + 10));
    }
    function ingest(data, live = false) {
        if (!data || typeof data.session !== 'string') return;
        if (Number.isFinite(data.now)) {
            // Late acknowledgments must not move the room clock back and prolong a roll.
            offset = (clockReady ? Math.max(now(), data.now) : data.now) - Date.now();
            clockReady = true;
        }
        if (session !== data.session) {
            session = data.session;
            rolls = [];
            selfRollIds.clear();
            nextAt = 0;
        }
        if (Number.isFinite(data.selfBusyUntil)) nextAt = Math.max(nextAt, data.selfBusyUntil);
        for (const id of data.selfRollIds || [data.selfRollId]) if (typeof id === 'string') selfRollIds.add(id);
        const fresh = [];
        for (const r of data.rolls || [data.roll]) {
            const sides = { d6: 6, d10: 10, d20: 20, coin: 2 }[r?.kind];
            if (
                !r ||
                typeof r.id !== 'string' ||
                !Number.isInteger(r.sequence) ||
                !Number.isFinite(r.at) ||
                !Number.isFinite(r.revealAt) ||
                !sides ||
                !Number.isInteger(r.value) ||
                r.value < 1 ||
                r.value > sides
            )
                continue;
            if (rolls.some((x) => x.id === r.id)) continue;
            rolls.push(r);
            // Compatibility with an in-flight result from the caller's own socket.
            if (r.peerId === socket?.id) {
                selfRollIds.add(r.id);
                nextAt = Math.max(nextAt, r.revealAt);
            }
            if (live && r.revealAt > now()) fresh.push(r);
        }
        rolls.sort((a, b) => a.sequence - b.sequence);
        rolls = rolls.slice(-50);
        const retained = new Set(rolls.map((roll) => roll.id));
        selfRollIds = new Set([...selfRollIds].filter((id) => retained.has(id)));
        publish(fresh);
    }
    function listen(event, fn) {
        socket.on(event, fn);
        handlers.push([event, fn]);
    }
    function history() {
        if (!socket?.connected) return;
        const g = generation,
            h = ++historyGeneration;
        synchronizing = true;
        clearTimeout(historyTimer);
        historyTimer = setTimeout(() => {
            if (g !== generation || h !== historyGeneration) return;
            synchronizing = false;
            publish();
        }, 8000);
        socket.emit('utilityHistory', {}, (data) => {
            if (g !== generation || h !== historyGeneration) return;
            clearTimeout(historyTimer);
            synchronizing = false;
            ingest(data);
            publish();
        });
        publish();
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
            generation++;
            clearTimeout(historyTimer);
            pending = false;
            nextAt = 0;
            clockReady = false;
            synchronizing = false;
            online = false;
            publish();
        });
        history();
        publish();
    }
    function disconnect() {
        generation++;
        clearTimeout(timer);
        clearTimeout(historyTimer);
        for (const [event, fn] of handlers.splice(0)) socket?.off(event, fn);
        socket = null;
        session = '';
        rolls = [];
        selfRollIds.clear();
        online = false;
        clockReady = false;
        synchronizing = false;
        pending = false;
        nextAt = 0;
        publish();
    }
    async function roll(kind) {
        if (!online || !socket?.connected) throw new Error('A conexão com a sala está sendo restabelecida.');
        if (pending || synchronizing || now() < nextAt)
            throw new Error('Sua rolagem ainda está em andamento. Espere ela terminar.');
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
            ingest(data, true);
            if (data.error) throw new Error(data.error);
        } catch (error) {
            if (g !== generation) return;
            // A lost ACK does not mean that the room rejected the roll. Recover its
            // accepted result and personal lock from shared history before enabling.
            history();
            throw error;
        } finally {
            if (g === generation) {
                pending = false;
                publish();
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
