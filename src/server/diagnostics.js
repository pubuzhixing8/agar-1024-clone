'use strict';

const { performance, monitorEventLoopDelay } = require('perf_hooks');

const MAX_HISTORY = 300;
const MAX_CLIENTS = 100;
const MAX_CLIENT_REPORTS = 12;

const number = (value) => Number.isFinite(value) ? Math.max(0, Math.min(value, 1000000)) : 0;
const round = (value) => Math.round(value * 10) / 10;

function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return round(sorted[Math.ceil(sorted.length * fraction) - 1]);
}

module.exports = function createDiagnostics(app, getState) {
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();

    const history = [];
    const clients = new Map();
    const durations = { tick: [], send: [] };
    let counters = { inputs: 0, snapshots: 0, backpressure: 0, sampledBytes: 0, byteSamples: 0 };
    let sampleNumber = 0;
    let previousCpu = process.cpuUsage();
    let previousTime = performance.now();

    function observe(kind, work) {
        const started = performance.now();
        try {
            return work();
        } finally {
            durations[kind].push(performance.now() - started);
        }
    }

    function recordSnapshot(socket, payload) {
        counters.snapshots++;
        if (socket.conn && socket.conn.transport && socket.conn.transport.writable === false) {
            counters.backpressure++;
        }
        if (++sampleNumber % 40 === 0) {
            counters.sampledBytes += Buffer.byteLength(JSON.stringify(payload));
            counters.byteSamples++;
        }
    }

    function attachSocket(socket, role) {
        clients.set(socket.id, {
            id: socket.id,
            role,
            connected: true,
            connectedAt: Date.now(),
            reports: []
        });

        socket.on('clientDiagnostics', report => {
            if (!report || typeof report !== 'object') return;
            const client = clients.get(socket.id);
            if (!client) return;
            client.lastReportAt = Date.now();
            client.reports.push({
                at: client.lastReportAt,
                windowMs: number(report.windowMs),
                updates: number(report.updates),
                frames: number(report.frames),
                inputs: number(report.inputs),
                maxUpdateGapMs: number(report.maxUpdateGapMs),
                maxFrameGapMs: number(report.maxFrameGapMs),
                lastUpdateAgeMs: number(report.lastUpdateAgeMs),
                transport: report.transport === 'websocket' ? 'websocket' : 'polling'
            });
            if (client.reports.length > MAX_CLIENT_REPORTS) client.reports.shift();
        });

        socket.on('disconnect', reason => {
            const client = clients.get(socket.id);
            if (!client) return;
            client.connected = false;
            client.disconnectedAt = Date.now();
            client.disconnectReason = reason;
        });
    }

    setInterval(() => {
        const now = performance.now();
        const elapsed = now - previousTime;
        previousTime = now;
        const cpu = process.cpuUsage(previousCpu);
        previousCpu = process.cpuUsage();
        const averageBytes = counters.byteSamples ? counters.sampledBytes / counters.byteSamples : 0;

        history.push({
            at: Date.now(),
            elapsedMs: round(elapsed),
            tick: { count: durations.tick.length, p95Ms: percentile(durations.tick, 0.95), maxMs: percentile(durations.tick, 1) },
            send: { count: durations.send.length, p95Ms: percentile(durations.send, 0.95), maxMs: percentile(durations.send, 1) },
            eventLoop: { p95Ms: round(eventLoop.percentile(95) / 1e6), maxMs: round(eventLoop.max / 1e6) },
            inputs: counters.inputs,
            snapshots: counters.snapshots,
            estimatedSnapshotBytes: Math.round(averageBytes * counters.snapshots),
            backpressure: counters.backpressure,
            cpuPercentOfCore: round((cpu.user + cpu.system) / (elapsed * 10)),
            rssMb: round(process.memoryUsage().rss / 1048576),
            ...getState()
        });
        if (history.length > MAX_HISTORY) history.shift();
        durations.tick.length = 0;
        durations.send.length = 0;
        counters = { inputs: 0, snapshots: 0, backpressure: 0, sampledBytes: 0, byteSamples: 0 };
        eventLoop.reset();

        const staleBefore = Date.now() - 120000;
        for (const [id, client] of clients) {
            if (!client.connected && client.disconnectedAt < staleBefore) clients.delete(id);
        }
        while (clients.size > MAX_CLIENTS) {
            const oldestDisconnected = [...clients].find(([, client]) => !client.connected);
            if (!oldestDisconnected) break;
            clients.delete(oldestDisconnected[0]);
        }
    }, 1000);

    app.get('/__diag/summary', (request, response) => {
        const requested = Number(request.query.seconds);
        const seconds = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_HISTORY, Math.floor(requested))) : 60;
        response.set('Cache-Control', 'no-store');
        response.json({
            now: Date.now(),
            history: history.slice(-seconds),
            clients: [...clients.values()]
        });
    });

    return {
        attachSocket,
        observeTick: work => observe('tick', work),
        observeSend: work => observe('send', work),
        recordInput: () => { counters.inputs++; },
        recordSnapshot
    };
};
