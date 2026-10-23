const crypto = require('crypto');

module.exports = {
    host: "0.0.0.0",
    port: 3000,
    logpath: "logger.php",
    foodMass: 1,
    fireFood: 20,
    limitSplit: 16,
    defaultPlayerMass: 10,
	virus: {
        fill: "#33ff33",
        stroke: "#19D119",
        strokeWidth: 20,
        defaultMass: {
            from: 100,
            to: 150
        },
        splitMass: 180,
        uniformDisposition: false,
	},
    gameWidth: 3000,
    gameHeight: 3000,
    adminPass: process.env.ADMIN_PASS || crypto.randomBytes(32).toString('hex'),
    gameMass: 20000,
    maxFood: 360,
    maxVirus: 18,
    baseCellSpeed: 4.5,
    slowBase: 30,
    maxSteeringRadius: 150,
    logChat: 0,
    networkUpdateFactor: 30,
    maxHeartbeatInterval: 15000,
    foodUniformDisposition: true,
    newPlayerInitialPosition: "farthest",
    massLossRate: 1,
    minMassLoss: 50,
    sqlinfo: {
      fileName: "db.sqlite3",
    }
};
