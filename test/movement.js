const expect = require('chai').expect;
const config = require('../config');
const Player = require('../src/server/map/player').Player;
const util = require('../src/server/lib/util');

function moveOnce(mass, targetX) {
    const player = new Player('movement-test');
    player.init({ x: 1500, y: 1500 }, config.defaultPlayerMass);
    player.cells[0].setMass(mass);
    player.massTotal = mass;
    player.target = { x: targetX, y: 0 };
    player.move(config.slowBase, config.gameWidth, config.gameHeight,
        util.mathLog(config.defaultPlayerMass, config.slowBase));
    return player.x - 1500;
}

describe('movement speed', () => {
    it('uses the configured starting speed', () => {
        expect(moveOnce(config.defaultPlayerMass, 1000)).to.be.closeTo(config.baseCellSpeed, 0.001);
    });

    it('keeps a large cell responsive when the pointer is beyond the steering distance', () => {
        const mass = 1000;
        const fullSpeed = config.baseCellSpeed / (1 + util.mathLog(mass / config.defaultPlayerMass, config.slowBase));
        expect(moveOnce(mass, 200)).to.be.closeTo(fullSpeed, 0.001);
    });
});

describe('split cell merging', () => {
    function splitPlayer() {
        const player = new Player('merge-test');
        player.init({ x: 1500, y: 1500 }, 100);
        player.userSplit(16, config.defaultPlayerMass);
        return player;
    }

    it('keeps cells separate during the merge cooldown', () => {
        const player = splitPlayer();
        player.target = { x: 1000, y: 0 };
        player.move(config.slowBase, config.gameWidth, config.gameHeight,
            util.mathLog(config.defaultPlayerMass, config.slowBase));
        expect(player.cells).to.have.length(2);
    });

    it('merges after cooldown within about a second, even while steering away', () => {
        const player = splitPlayer();
        player.cells[0].x = 1200;
        player.cells[1].x = 1800;
        player.cells[0].setMass(500);
        player.cells[1].setMass(10);
        player.timeToMerge = Date.now() - 1;
        player.target = { x: 1000, y: 0 };
        for (let i = 0; i < 90 && player.cells.length > 1; i++) {
            player.move(config.slowBase, config.gameWidth, config.gameHeight,
                util.mathLog(config.defaultPlayerMass, config.slowBase));
        }
        expect(player.cells).to.have.length(1);
    });

    it('merges after holding the pointer at the center for 1.5 seconds', () => {
        const player = splitPlayer();
        player.cells[0].x = 1300;
        player.cells[1].x = 1700;
        player.target = { x: 0, y: 0 };
        player.setMergeHeld(true);
        player.mergeHoldStartedAt = Date.now() - 1400;
        player.move(config.slowBase, config.gameWidth, config.gameHeight,
            util.mathLog(config.defaultPlayerMass, config.slowBase));
        expect(player.cells).to.have.length(2);
        player.mergeHoldStartedAt = Date.now() - 1600;
        player.move(config.slowBase, config.gameWidth, config.gameHeight,
            util.mathLog(config.defaultPlayerMass, config.slowBase));
        expect(player.cells).to.have.length(1);
        expect(player.cells[0].mass).to.be.closeTo(100, 0.001);
    });

    it('resets the center hold when the pointer leaves the center', () => {
        const player = splitPlayer();
        player.setMergeHeld(true);
        player.mergeHoldStartedAt = Date.now() - 1400;
        player.setMergeHeld(false);
        player.setMergeHeld(true);
        expect(player.mergeHoldStartedAt).to.be.above(Date.now() - 100);
    });
});
