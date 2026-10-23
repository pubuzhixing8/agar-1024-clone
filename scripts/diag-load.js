'use strict';

// node scripts/diag-load.js <url> <players> <seconds>
const io = require('socket.io-client');
const base = process.argv[2] || 'http://localhost:3000';
const count = Math.min(100, Math.max(1, Number(process.argv[3]) || 10));
const seconds = Math.min(300, Math.max(5, Number(process.argv[4]) || 30));
const clients = [];
const results = { target: base, requestedPlayers: count, seconds, connected: 0, welcomed: 0, updates: 0, gapsOver100Ms: 0, gapsOver500Ms: 0, maxGapMs: 0, disconnects: {}, connectErrors: 0 };

for (let index = 0; index < count; index++) {
    const socket = io(base, { query: { type: 'player' }, transports: ['websocket'], reconnection: false, timeout: 10000 });
    let lastUpdate = 0;
    let moveTimer;
    socket.on('connect', () => { results.connected++; socket.emit('respawn', {}); });
    socket.on('welcome', player => {
        results.welcomed++;
        socket.emit('gotit', { ...player, name: `load${index}`, screenWidth: 1440, screenHeight: 900, target: { x: 0, y: 0 } });
        moveTimer = setInterval(() => socket.emit('0', { x: Math.round(Math.random() * 800 - 400), y: Math.round(Math.random() * 800 - 400) }), 50);
    });
    socket.on('serverTellPlayerMove', () => {
        const now = Date.now();
        if (lastUpdate) {
            const gap = now - lastUpdate;
            results.maxGapMs = Math.max(results.maxGapMs, gap);
            if (gap > 100) results.gapsOver100Ms++;
            if (gap > 500) results.gapsOver500Ms++;
        }
        lastUpdate = now;
        results.updates++;
    });
    socket.on('connect_error', () => { results.connectErrors++; });
    socket.on('disconnect', reason => { results.disconnects[reason] = (results.disconnects[reason] || 0) + 1; clearInterval(moveTimer); });
    clients.push(socket);
}

setTimeout(async () => {
    for (const socket of clients) socket.disconnect();
    try {
        const response = await fetch(`${base}/__diag/summary?seconds=${seconds}`);
        const summary = await response.json();
        const history = summary.history || [];
        const max = (path) => Math.max(0, ...history.map(sample => path(sample) || 0));
        results.server = {
            samples: history.length,
            maxPlayers: max(sample => sample.players),
            maxSendMs: max(sample => sample.send.maxMs),
            maxTickMs: max(sample => sample.tick.maxMs),
            maxEventLoopMs: max(sample => sample.eventLoop.maxMs),
            maxCpuPercentOfCore: max(sample => sample.cpuPercentOfCore),
            maxEstimatedBytesPerSecond: max(sample => sample.estimatedSnapshotBytes),
            maxBackpressurePerSecond: max(sample => sample.backpressure)
        };
    } catch (error) { results.diagnosticError = error.message; }
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
}, seconds * 1000);
