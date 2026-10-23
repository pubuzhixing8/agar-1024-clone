'use strict';

const { performance, monitorEventLoopDelay } = require('perf_hooks');

const MAX_HISTORY = 300;
const MAX_CLIENTS = 100;
const MAX_CLIENT_REPORTS = 12;
const MAX_NETWORK_REPORTS = 60;
const MAX_CLIENT_SPIKES = 6;

const number = (value) => Number.isFinite(value) ? Math.max(0, Math.min(value, 1000000)) : 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value < 10000000000000 ? value : 0;
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
    const sockets = new Map();
    const durations = { tick: [], send: [] };
    let counters = { inputs: 0, snapshots: 0, sentSnapshots: 0, droppedSnapshots: 0, backpressure: 0, sampledBytes: 0, byteSamples: 0, maxQueuedPackets: 0, maxBufferedBytes: 0 };
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

    function connectionState(socket) {
        const conn = socket && socket.conn;
        const transport = conn && conn.transport;
        const ws = transport && transport.name === 'websocket' && transport.socket;
        return {
            transport: transport ? transport.name : 'unknown',
            writable: Boolean(socket && socket.connected && transport && transport.writable),
            queuedPackets: conn && Array.isArray(conn.writeBuffer) ? conn.writeBuffer.length : 0,
            bufferedBytes: ws && Number.isFinite(ws.bufferedAmount) ? ws.bufferedAmount : null
        };
    }

    function recordSnapshot(socket, payload) {
        counters.snapshots++;
        const state = connectionState(socket);
        const client = socket && clients.get(socket.id);
        counters.maxQueuedPackets = Math.max(counters.maxQueuedPackets, state.queuedPackets);
        if (state.bufferedBytes !== null) counters.maxBufferedBytes = Math.max(counters.maxBufferedBytes, state.bufferedBytes);
        if (client) {
            client.maxQueuedPackets = Math.max(client.maxQueuedPackets, state.queuedPackets);
            if (state.bufferedBytes !== null) client.maxBufferedBytes = Math.max(client.maxBufferedBytes, state.bufferedBytes);
        }
        if (!state.writable) {
            counters.backpressure++;
            counters.droppedSnapshots++;
            if (client) client.droppedSnapshots++;
            return false;
        }
        counters.sentSnapshots++;
        if (client) client.sentSnapshots++;
        if (++sampleNumber % 40 === 0) {
            counters.sampledBytes += Buffer.byteLength(JSON.stringify(payload));
            counters.byteSamples++;
        }
        return true;
    }

    function attachSocket(socket, role) {
        sockets.set(socket.id, socket);
        clients.set(socket.id, {
            id: socket.id,
            role,
            connected: true,
            connectedAt: Date.now(),
            reports: [],
            spikes: [],
            networkReports: [],
            sentSnapshots: 0,
            droppedSnapshots: 0,
            maxQueuedPackets: 0,
            maxBufferedBytes: 0,
            rttMs: null,
            rttTimeouts: 0,
            lastInputAt: null,
            inputs: 0
        });

        const pingTimer = setInterval(() => {
            if (!socket.connected) return;
            const started = performance.now();
            socket.timeout(4000).emit('diagnosticPing', error => {
                const client = clients.get(socket.id);
                if (!client || !client.connected) return;
                if (error) {
                    client.rttTimeouts++;
                    client.rttMs = null;
                } else {
                    client.rttMs = round(performance.now() - started);
                }
            });
        }, 5000);

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
                missingSnapshots: number(report.missingSnapshots),
                maxInputAckMs: number(report.maxInputAckMs),
                maxDeliverySkewMs: number(report.maxDeliverySkewMs),
                lastUpdateAgeMs: number(report.lastUpdateAgeMs),
                transport: report.transport === 'websocket' ? 'websocket' : 'polling'
            });
            if (client.reports.length > MAX_CLIENT_REPORTS) client.reports.shift();
        });

        socket.on('clientDiagnosticsSpike', report => {
            if (!report || typeof report !== 'object') return;
            const client = clients.get(socket.id);
            if (!client) return;
            const event = entry => ({
                at: timestamp(entry.at),
                kind: ['input', 'update', 'frameGap'].includes(entry.kind) ? entry.kind : 'unknown',
                seq: number(entry.seq),
                serverAt: timestamp(entry.serverAt),
                inputSeq: number(entry.inputSeq),
                gapMs: number(entry.gapMs),
                serverGapMs: number(entry.serverGapMs),
                inputAckMs: number(entry.inputAckMs)
            });
            client.spikes.push({
                receivedAt: Date.now(),
                clientAt: timestamp(report.at),
                updateGapMs: number(report.updateGapMs),
                before: Array.isArray(report.before) ? report.before.slice(-120).filter(x => x && typeof x === 'object').map(event) : [],
                after: Array.isArray(report.after) ? report.after.slice(0, 80).filter(x => x && typeof x === 'object').map(event) : [],
                transport: report.transport === 'websocket' ? 'websocket' : 'polling'
            });
            if (client.spikes.length > MAX_CLIENT_SPIKES) client.spikes.shift();
        });

        socket.on('disconnect', reason => {
            clearInterval(pingTimer);
            sockets.delete(socket.id);
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
        const timestamp = Date.now();
        const currentRtts = [];
        for (const [id, socket] of sockets) {
            const client = clients.get(id);
            if (!client) continue;
            const state = connectionState(socket);
            client.networkReports.push({
                at: timestamp,
                ...state,
                maxQueuedPackets: client.maxQueuedPackets,
                maxBufferedBytes: client.maxBufferedBytes,
                sentSnapshots: client.sentSnapshots,
                droppedSnapshots: client.droppedSnapshots,
                inputs: client.inputs,
                inputAgeMs: client.lastInputAt === null ? null : timestamp - client.lastInputAt,
                rttMs: client.rttMs,
                rttTimeouts: client.rttTimeouts
            });
            if (client.networkReports.length > MAX_NETWORK_REPORTS) client.networkReports.shift();
            if (client.rttMs !== null) currentRtts.push(client.rttMs);
            client.sentSnapshots = 0;
            client.droppedSnapshots = 0;
            client.maxQueuedPackets = 0;
            client.maxBufferedBytes = 0;
            client.inputs = 0;
        }

        history.push({
            at: timestamp,
            elapsedMs: round(elapsed),
            tick: { count: durations.tick.length, p95Ms: percentile(durations.tick, 0.95), maxMs: percentile(durations.tick, 1) },
            send: { count: durations.send.length, p95Ms: percentile(durations.send, 0.95), maxMs: percentile(durations.send, 1) },
            eventLoop: { p95Ms: round(eventLoop.percentile(95) / 1e6), maxMs: round(eventLoop.max / 1e6) },
            inputs: counters.inputs,
            snapshots: counters.snapshots,
            sentSnapshots: counters.sentSnapshots,
            droppedSnapshots: counters.droppedSnapshots,
            estimatedSnapshotBytes: Math.round(averageBytes * counters.sentSnapshots),
            backpressure: counters.backpressure,
            maxQueuedPackets: counters.maxQueuedPackets,
            maxBufferedBytes: counters.maxBufferedBytes,
            rttP95Ms: percentile(currentRtts, 0.95),
            cpuPercentOfCore: round((cpu.user + cpu.system) / (elapsed * 10)),
            rssMb: round(process.memoryUsage().rss / 1048576),
            ...getState()
        });
        if (history.length > MAX_HISTORY) history.shift();
        durations.tick.length = 0;
        durations.send.length = 0;
        counters = { inputs: 0, snapshots: 0, sentSnapshots: 0, droppedSnapshots: 0, backpressure: 0, sampledBytes: 0, byteSamples: 0, maxQueuedPackets: 0, maxBufferedBytes: 0 };
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
        recordInput: socket => {
            counters.inputs++;
            const client = clients.get(socket.id);
            if (client) {
                client.lastInputAt = Date.now();
                client.inputs++;
            }
        },
        recordSnapshot
    };
};
