var io = require('socket.io-client');
var render = require('./render');
var ChatClient = require('./chat-client');
var Canvas = require('./canvas');
var global = require('./global');

var playerNameInput = document.getElementById('playerNameInput');
var socket;
var lastTargetSentAt = 0;
var lastTargetX = null;
var lastTargetY = null;
var lastServerUpdateAt = 0;
var visualX = null;
var visualY = null;
var lastVisualAt = 0;
var movementSlowBase = 4.5;
var movementInitialMass = 10;
var movementBaseSpeed = 6.25;
var maxSteeringRadius = Infinity;
var diagnosticsWindowStartedAt = Date.now();
var diagnosticsLastFrameAt = 0;
var diagnosticsCounters = { updates: 0, frames: 0, inputs: 0, maxUpdateGapMs: 0, maxFrameGapMs: 0 };
var RESUME_TOKEN_KEY = 'agar1024ResumeToken';
var RESUME_NAME_KEY = 'agar1024ResumeName';

function readSession(key) {
    try { return sessionStorage.getItem(key); } catch (error) { return null; }
}

function saveSession(token, name) {
    try {
        sessionStorage.setItem(RESUME_TOKEN_KEY, token);
        sessionStorage.setItem(RESUME_NAME_KEY, name);
    } catch (error) { /* Playing still works when storage is unavailable. */ }
}

function clearSession() {
    try {
        sessionStorage.removeItem(RESUME_TOKEN_KEY);
        sessionStorage.removeItem(RESUME_NAME_KEY);
    } catch (error) { /* Ignore unavailable storage. */ }
}

var debug = function (args) {
    if (console && console.log) {
        console.log(args);
    }
};

if (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)) {
    global.mobile = true;
}

function startGame(type) {
    global.playerName = playerNameInput.value.replace(/(<([^>]+)>)/ig, '').substring(0, 25);
    if (type === 'player' && readSession(RESUME_NAME_KEY) !== global.playerName) clearSession();
    global.playerType = type;

    global.screen.width = window.innerWidth;
    global.screen.height = window.innerHeight;

    document.getElementById('startMenuWrapper').style.maxHeight = '0px';
    document.getElementById('gameAreaWrapper').style.opacity = 1;
    if (!socket) {
        socket = io({ query: "type=" + type });
        setupSocket(socket);
    }
    if (!global.animLoopHandle)
        animloop();
    socket.emit('respawn', { resumeToken: type === 'player' ? readSession(RESUME_TOKEN_KEY) : null });
    window.chat.socket = socket;
    window.chat.registerFunctions();
    window.canvas.socket = socket;
    global.socket = socket;
}

// Checks if the nick chosen contains valid alphanumeric characters (and underscores).
function validNick() {
    var regex = /^[\w\u3400-\u9fff]*$/;
    debug('Regex Test', regex.exec(playerNameInput.value));
    return regex.exec(playerNameInput.value) !== null;
}

window.onload = function () {

    var btn = document.getElementById('startButton'),
        btnS = document.getElementById('spectateButton'),
        nickErrorText = document.querySelector('#startMenu .input-error');

    btnS.onclick = function () {
        startGame('spectator');
    };

    btn.onclick = function () {

        // Checks if the nick is valid.
        if (validNick()) {
            nickErrorText.style.opacity = 0;
            startGame('player');
        } else {
            nickErrorText.style.opacity = 1;
        }
    };

    var settingsMenu = document.getElementById('settingsButton');
    var settings = document.getElementById('settings');

    settingsMenu.onclick = function () {
        if (settings.style.maxHeight == '300px') {
            settings.style.maxHeight = '0px';
        } else {
            settings.style.maxHeight = '300px';
        }
    };

    playerNameInput.addEventListener('keypress', function (e) {
        var key = e.which || e.keyCode;

        if (key === global.KEY_ENTER) {
            if (validNick()) {
                nickErrorText.style.opacity = 0;
                startGame('player');
            } else {
                nickErrorText.style.opacity = 1;
            }
        }
    });

    var savedName = readSession(RESUME_NAME_KEY);
    if (savedName && readSession(RESUME_TOKEN_KEY)) {
        playerNameInput.value = savedName;
        startGame('player');
    }
};

// TODO: Break out into GameControls.

var playerConfig = {
    border: 6,
    textColor: '#FFFFFF',
    textBorder: '#000000',
    textBorderSize: 3,
    defaultSize: 30
};

var player = {
    id: -1,
    x: global.screen.width / 2,
    y: global.screen.height / 2,
    screenWidth: global.screen.width,
    screenHeight: global.screen.height,
    target: { x: global.screen.width / 2, y: global.screen.height / 2 }
};
global.player = player;

var foods = [];
var viruses = [];
var fireFood = [];
var users = [];
var leaderboard = [];
var target = { x: player.x, y: player.y };
global.target = target;

window.canvas = new Canvas();
window.chat = new ChatClient();

var visibleBorderSetting = document.getElementById('visBord');
visibleBorderSetting.onchange = settings.toggleBorder;

var showMassSetting = document.getElementById('showMass');
showMassSetting.onchange = settings.toggleMass;

var continuitySetting = document.getElementById('continuity');
continuitySetting.onchange = settings.toggleContinuity;

var roundFoodSetting = document.getElementById('roundFood');
roundFoodSetting.onchange = settings.toggleRoundFood;

var c = window.canvas.cv;
var graph = c.getContext('2d');

document.getElementById('feed').addEventListener('click', function () {
    socket.emit('1');
    window.canvas.reenviar = false;
});

document.getElementById('split').addEventListener('click', function () {
    socket.emit('2');
    window.canvas.reenviar = false;
});

function handleDisconnect() {
    if (global.kicked) return;
    global.gameStart = false;
    visualX = null;
    visualY = null;
    var status = document.getElementById('connectionStatus');
    status.textContent = '连接已断开，正在重连…';
    status.hidden = false;
}

function sendTargetIfNeeded() {
    if (!global.gameStart || !socket || !socket.connected) return;
    var now = Date.now();
    var target = window.canvas.target;
    var changed = target.x !== lastTargetX || target.y !== lastTargetY;
    if (now - lastTargetSentAt < (changed ? 50 : 250)) return;
    // Only the newest direction matters after a slow connection recovers.
    socket.volatile.emit('0', {
        x: target.x,
        y: target.y,
        mergeHeld: window.canvas.pointerInside && Math.hypot(target.x, target.y) <= 60
    });
    diagnosticsCounters.inputs++;
    lastTargetSentAt = now;
    lastTargetX = target.x;
    lastTargetY = target.y;
}

// Keep input delivery independent from canvas rendering and its frame rate.
window.setInterval(sendTargetIfNeeded, 50);

window.setInterval(function () {
    if (!global.gameStart || !lastServerUpdateAt || !socket) return;
    var age = Date.now() - lastServerUpdateAt;
    if (age > 2000) {
        var status = document.getElementById('connectionStatus');
        status.textContent = '游戏更新延迟，正在恢复…';
        status.hidden = false;
    }
    if (age > 8000 && socket.connected) socket.io.engine.close();
}, 500);

window.setInterval(function () {
    if (!socket || !global.gameStart) return;
    var now = Date.now();
    var report = {
        windowMs: now - diagnosticsWindowStartedAt,
        updates: diagnosticsCounters.updates,
        frames: diagnosticsCounters.frames,
        inputs: diagnosticsCounters.inputs,
        maxUpdateGapMs: diagnosticsCounters.maxUpdateGapMs,
        maxFrameGapMs: diagnosticsCounters.maxFrameGapMs,
        lastUpdateAgeMs: lastServerUpdateAt ? now - lastServerUpdateAt : 0,
        transport: socket.io.engine && socket.io.engine.transport ? socket.io.engine.transport.name : 'unknown'
    };
    window.__agarDiagnostics = report;
    console.info('[game-diagnostics]', report);
    if (socket.connected) socket.emit('clientDiagnostics', report);
    diagnosticsWindowStartedAt = now;
    diagnosticsCounters = { updates: 0, frames: 0, inputs: 0, maxUpdateGapMs: 0, maxFrameGapMs: 0 };
}, 5000);

// socket stuff.
function setupSocket(socket) {
    var hasConnected = false;
    socket.on('diagnosticPing', function (reply) {
        if (typeof reply === 'function') reply();
    });
    socket.on('connect', function () {
        if (hasConnected && !global.kicked) {
            socket.emit('respawn', { resumeToken: readSession(RESUME_TOKEN_KEY) });
        }
        hasConnected = true;
    });
    // Handle ping.
    socket.on('pongcheck', function () {
        var latency = Date.now() - global.startPingTime;
        debug('Latency: ' + latency + 'ms');
        window.chat.addSystemLine('Ping: ' + latency + 'ms');
    });

    // Handle error.
    socket.on('connect_error', handleDisconnect);
    socket.on('disconnect', function (reason) {
        console.warn('[game-diagnostics] disconnected', { reason: reason, lastUpdateAgeMs: lastServerUpdateAt ? Date.now() - lastServerUpdateAt : 0 });
        handleDisconnect();
        if (reason === 'io server disconnect' && !global.kicked) socket.connect();
    });

    // Handle connection.
    socket.on('welcome', function (playerSettings, gameSizes, resume) {
        var previousToken = readSession(RESUME_TOKEN_KEY);
        if (global.playerType === 'player' && resume && resume.resumeToken) {
            saveSession(resume.resumeToken, resume.resumed ? playerSettings.name : global.playerName);
        }
        player = playerSettings;
        player.name = resume && resume.resumed ? playerSettings.name : global.playerName;
        player.screenWidth = global.screen.width;
        player.screenHeight = global.screen.height;
        player.target = window.canvas.target;
        global.player = player;
        window.chat.player = player;
        socket.emit('gotit', player);
        global.gameStart = true;
        lastServerUpdateAt = Date.now();
        lastTargetSentAt = 0;
        visualX = null;
        visualY = null;
        movementSlowBase = gameSizes.slowBase || 4.5;
        movementInitialMass = gameSizes.defaultPlayerMass || 10;
        movementBaseSpeed = gameSizes.baseCellSpeed || 6.25;
        maxSteeringRadius = gameSizes.maxSteeringRadius || Infinity;
        document.getElementById('connectionStatus').hidden = true;
        window.chat.addSystemLine(resume && resume.resumed ? '连接已恢复，继续游戏！' : '已进入游戏！');
        if (previousToken && resume && !resume.resumed) {
            window.chat.addSystemLine('原游戏状态已过期，已重新开始。');
        }
        window.chat.addSystemLine('输入 <b>-help</b> 查看命令。');
        if (global.mobile && document.getElementById('chatbox').parentNode) {
            document.getElementById('chatbox').remove();
        }
        c.focus();
        global.game.width = gameSizes.width;
        global.game.height = gameSizes.height;
        resize();
    });

    socket.on('playerDied', (data) => {
        const player = isUnnamedCell(data.playerEatenName) ? '匿名玩家' : data.playerEatenName;
        //const killer = isUnnamedCell(data.playerWhoAtePlayerName) ? 'An unnamed cell' : data.playerWhoAtePlayerName;

        //window.chat.addSystemLine('{GAME} - <b>' + (player) + '</b> was eaten by <b>' + (killer) + '</b>');
        window.chat.addSystemLine('{GAME} - <b>' + (player) + '</b> was eaten');
    });

    socket.on('playerDisconnect', (data) => {
        window.chat.addSystemLine('{GAME} - <b>' + (isUnnamedCell(data.name) ? '匿名玩家' : data.name) + '</b> 离开了游戏。');
    });

    socket.on('playerJoin', (data) => {
        window.chat.addSystemLine('{GAME} - <b>' + (isUnnamedCell(data.name) ? '匿名玩家' : data.name) + '</b> 加入了游戏。');
    });

    socket.on('leaderboard', (data) => {
        leaderboard = data.leaderboard;
        var status = '<span class="title">排行榜</span>';
        for (var i = 0; i < leaderboard.length; i++) {
            status += '<br />';
            if (leaderboard[i].id == player.id) {
                if (leaderboard[i].name.length !== 0)
                    status += '<span class="me">' + (i + 1) + '. ' + leaderboard[i].name + "</span>";
                else
                    status += '<span class="me">' + (i + 1) + ". 匿名玩家</span>";
            } else {
                if (leaderboard[i].name.length !== 0)
                    status += (i + 1) + '. ' + leaderboard[i].name;
                else
                    status += (i + 1) + '. 匿名玩家';
            }
        }
        //status += '<br />Players: ' + data.players;
        document.getElementById('status').innerHTML = status;
    });

    socket.on('serverMSG', function (data) {
        window.chat.addSystemLine(data);
    });

    // Chat.
    socket.on('serverSendPlayerChat', function (data) {
        window.chat.addChatLine(data.sender, data.message, false);
    });

    // Handle movement.
    socket.on('serverTellPlayerMove', function (playerData, userData, foodsList, massList, virusList) {
        var updateAt = Date.now();
        if (lastServerUpdateAt) diagnosticsCounters.maxUpdateGapMs = Math.max(diagnosticsCounters.maxUpdateGapMs, updateAt - lastServerUpdateAt);
        diagnosticsCounters.updates++;
        lastServerUpdateAt = updateAt;
        document.getElementById('connectionStatus').hidden = true;
        if (global.playerType == 'player') {
            player.x = playerData.x;
            player.y = playerData.y;
            player.hue = playerData.hue;
            player.massTotal = playerData.massTotal;
            player.cells = playerData.cells;
        }
        users = userData;
        foods = foodsList;
        viruses = virusList;
        fireFood = massList;
    });

    // Death.
    socket.on('RIP', function () {
        clearSession();
        global.gameStart = false;
        visualX = null;
        visualY = null;
        render.drawErrorMessage('你被吃掉了！', graph, global.screen);
        window.setTimeout(() => {
            document.getElementById('gameAreaWrapper').style.opacity = 0;
            document.getElementById('startMenuWrapper').style.maxHeight = '1000px';
            if (global.animLoopHandle) {
                window.cancelAnimationFrame(global.animLoopHandle);
                global.animLoopHandle = undefined;
            }
        }, 2500);
    });

    socket.on('kick', function (reason) {
        clearSession();
        global.gameStart = false;
        global.kicked = true;
        if (reason !== '') {
            render.drawErrorMessage('You were kicked for: ' + reason, graph, global.screen);
        }
        else {
            render.drawErrorMessage('You were kicked!', graph, global.screen);
        }
        socket.close();
    });
}

const isUnnamedCell = (name) => name.length < 1;

const getPosition = (entity, player, screen) => {
    return {
        x: entity.x - player.x + screen.width / 2,
        y: entity.y - player.y + screen.height / 2
    }
}

window.requestAnimFrame = (function () {
    return window.requestAnimationFrame ||
        window.webkitRequestAnimationFrame ||
        window.mozRequestAnimationFrame ||
        window.msRequestAnimationFrame ||
        function (callback) {
            window.setTimeout(callback, 1000 / 60);
        };
})();

window.cancelAnimFrame = (function (handle) {
    return window.cancelAnimationFrame ||
        window.mozCancelAnimationFrame;
})();

function animloop() {
    global.animLoopHandle = window.requestAnimFrame(animloop);
    var frameAt = Date.now();
    if (diagnosticsLastFrameAt) diagnosticsCounters.maxFrameGapMs = Math.max(diagnosticsCounters.maxFrameGapMs, frameAt - diagnosticsLastFrameAt);
    diagnosticsLastFrameAt = frameAt;
    diagnosticsCounters.frames++;
    gameLoop();
}

function getVisualPlayer(now) {
    var desiredX = player.x;
    var desiredY = player.y;
    // Prediction changes only the camera and the local cell's drawing position.
    // The authoritative player and collision state are never modified here.
    if (global.playerType === 'player' && player.cells && player.cells.length === 1 && lastServerUpdateAt) {
        var cell = player.cells[0];
        var input = window.canvas.target;
        var distance = Math.hypot(input.x, input.y);
        var radius = cell.radius;
        if (distance > 0 && Number.isFinite(distance) && Number.isFinite(cell.mass)) {
            var slowDown = Math.log(cell.mass / movementInitialMass) / Math.log(movementSlowBase) + 1;
            var speed = movementBaseSpeed / Math.max(1, slowDown);
            var nearTarget = Math.min(1, distance / (50 + Math.min(radius, maxSteeringRadius)));
            var ticks = Math.min(300, Math.max(0, now - lastServerUpdateAt)) * 60 / 1000;
            desiredX += input.x / distance * speed * nearTarget * ticks;
            desiredY += input.y / distance * speed * nearTarget * ticks;
            var boundary = radius * 4 / 3;
            desiredX = Math.max(boundary, Math.min(global.game.width - boundary, desiredX));
            desiredY = Math.max(boundary, Math.min(global.game.height - boundary, desiredY));
        }
    }
    if (visualX === null || visualY === null || now - lastVisualAt > 500) {
        visualX = desiredX;
        visualY = desiredY;
    } else {
        var blend = 1 - Math.exp(-(now - lastVisualAt) / 35);
        visualX += (desiredX - visualX) * blend;
        visualY += (desiredY - visualY) * blend;
    }
    lastVisualAt = now;
    return { x: visualX, y: visualY };
}

function gameLoop() {
    if (global.gameStart) {
        var viewPlayer = getVisualPlayer(Date.now());
        graph.fillStyle = global.backgroundColor;
        graph.fillRect(0, 0, global.screen.width, global.screen.height);

        render.drawGrid(global, viewPlayer, global.screen, graph);
        foods.forEach(food => {
            let position = getPosition(food, viewPlayer, global.screen);
            render.drawFood(position, food, graph);
        });
        fireFood.forEach(fireFood => {
            let position = getPosition(fireFood, viewPlayer, global.screen);
            render.drawFireFood(position, fireFood, playerConfig, graph);
        });
        viruses.forEach(virus => {
            let position = getPosition(virus, viewPlayer, global.screen);
            render.drawVirus(position, virus, graph);
        });


        let borders = { // Position of the borders on the screen
            left: global.screen.width / 2 - viewPlayer.x,
            right: global.screen.width / 2 + global.game.width - viewPlayer.x,
            top: global.screen.height / 2 - viewPlayer.y,
            bottom: global.screen.height / 2 + global.game.height - viewPlayer.y
        }
        if (global.borderDraw) {
            render.drawBorder(borders, graph);
        }

        var cellsToDraw = [];
        for (var i = 0; i < users.length; i++) {
            let color = 'hsl(' + users[i].hue + ', 100%, 50%)';
            let borderColor = 'hsl(' + users[i].hue + ', 100%, 45%)';
            for (var j = 0; j < users[i].cells.length; j++) {
                cellsToDraw.push({
                    color: color,
                    borderColor: borderColor,
                    mass: users[i].cells[j].mass,
                    name: users[i].name,
                    radius: users[i].cells[j].radius,
                    x: users[i].cells[j].x - viewPlayer.x + global.screen.width / 2 + (users[i].id === player.id ? viewPlayer.x - player.x : 0),
                    y: users[i].cells[j].y - viewPlayer.y + global.screen.height / 2 + (users[i].id === player.id ? viewPlayer.y - player.y : 0)
                });
            }
        }
        cellsToDraw.sort(function (obj1, obj2) {
            return obj1.mass - obj2.mass;
        });
        render.drawCells(cellsToDraw, playerConfig, global.toggleMassState, borders, graph);

    }
}

window.addEventListener('resize', resize);

function resize() {
    if (!socket) return;

    player.screenWidth = c.width = global.screen.width = global.playerType == 'player' ? window.innerWidth : global.game.width;
    player.screenHeight = c.height = global.screen.height = global.playerType == 'player' ? window.innerHeight : global.game.height;

    if (global.playerType == 'spectator') {
        player.x = global.game.width / 2;
        player.y = global.game.height / 2;
    }

    socket.emit('windowResized', { screenWidth: global.screen.width, screenHeight: global.screen.height });
}
