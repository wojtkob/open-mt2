import { expect } from 'chai';
import sinon from 'sinon';
import Behavior from '@/core/domain/entities/game/mob/behavior/Behavior';
import MapAttributeGrid from '@/core/util/MapAttributeGrid';
import MathUtil from '@/core/domain/util/MathUtil';
import { MapAttributeFlagEnum } from '@/core/enum/MapAttributeFlagEnum';
import { EntityStateEnum } from '@/core/enum/EntityStateEnum';

const CELL_SIZE = 100;

const buildGrid = (widthCells: number, heightCells: number, cells: Array<[number, number, number]>) => {
    const header = Buffer.alloc(17);
    header.write('MATR', 0, 'latin1');
    header.writeUInt8(1, 4);
    header.writeUInt32LE(CELL_SIZE, 5);
    header.writeUInt32LE(widthCells, 9);
    header.writeUInt32LE(heightCells, 13);

    const data = Buffer.alloc(widthCells * heightCells);
    for (const [x, y, value] of cells) data.writeUInt8(value, y * widthCells + x);

    return MapAttributeGrid.fromBuffer(Buffer.concat([header, data]), 0, 0);
};

const createMonster = (grid?: MapAttributeGrid, positionX = 500, positionY = 500) => {
    const area = grid ? { isPositionBlocked: (x: number, y: number) => grid.isPositionBlocked(x, y) } : undefined;

    return {
        goto: sinon.stub(),
        setState: sinon.stub(),
        setPos: sinon.stub(),
        setRotation: sinon.stub(),
        removeTarget: sinon.stub(),
        getRotation: () => 0,
        getPositionX: () => positionX,
        getPositionY: () => positionY,
        getTarget: () => undefined,
        getArea: () => area,
        isDead: () => false,
        isAffectByFlag: () => false,
        isAggresive: () => false,
        getShouldProtectStone: () => false,
        getAttackRange: () => 200,
        getMovementSpeed: () => 100,
        getNearbyEntities: () => new Map(),
        getState: () => EntityStateEnum.IDLE,
    };
};

/** Forces idleState past its random delay so the wander runs on demand. */
const wander = (behavior: Behavior) => {
    (behavior as any).nextMove = 0;
    behavior.idleState();
};

/**
 * Pins the wander offset instead of drawing it.
 *
 * moveToRandomLocation picks each axis with getRandomInt(-600, 600), so the
 * destination lands on the monster's own free cell whenever both draws come back
 * 0. In "should skip the wander when the destination is blocked" that cell is
 * the only free one, so the wander is *not* skipped and the assertion fails on a
 * 1-in-1_500_000 draw. A CI gate that turns red on its own is not a gate.
 *
 * A fixed non-zero offset makes the wander deterministic. `sinon.restore()` in
 * afterEach puts the real implementation back.
 *
 * Behavior imports MathUtil through a relative path; it is the same resolved
 * file, and therefore the same module instance, as the alias used here.
 */
const pinWanderOffset = (offset: number) => sinon.stub(MathUtil, 'getRandomInt').returns(offset);

describe('Behavior map attribute awareness', () => {
    afterEach(() => sinon.restore());

    describe('idle wander', () => {
        it('should move when the destination and the halfway point are free', () => {
            pinWanderOffset(300);
            const monster = createMonster(buildGrid(16, 16, []));
            const behavior = new Behavior(monster as any);
            behavior.init();

            wander(behavior);

            expect(monster.goto.calledOnce).to.be.equal(true);
            // Also pins the stub in place: without it the destination is drawn
            // at random and this assertion would be a coin flip.
            expect(monster.goto.calledOnceWith(800, 800)).to.be.equal(true);
        });

        it('should skip the wander when the destination is blocked', () => {
            // Without this the offset is drawn at random, and a draw of 0 on both
            // axes lands the destination on the only free cell in the map - the
            // monster's own - which is a 1-in-1_500_000 flake.
            pinWanderOffset(300);
            // Everything blocked except the monster's own cell (5,5).
            const cells: Array<[number, number, number]> = [];
            for (let y = 0; y < 16; y++)
                for (let x = 0; x < 16; x++) if (!(x === 5 && y === 5)) cells.push([x, y, MapAttributeFlagEnum.BLOCK]);

            const monster = createMonster(buildGrid(16, 16, cells));
            const behavior = new Behavior(monster as any);
            behavior.init();

            wander(behavior);

            expect(monster.goto.called).to.be.equal(false);
        });

        it('should skip the wander when only the halfway point is blocked', () => {
            // Monster at (500,500) = cell (5,5). Block a ring of cells around it
            // so any destination's midpoint falls on a blocked cell.
            const cells: Array<[number, number, number]> = [];
            for (let x = 3; x <= 7; x++) {
                for (let y = 3; y <= 7; y++) {
                    if (x === 5 && y === 5) continue;
                    cells.push([x, y, MapAttributeFlagEnum.BLOCK]);
                }
            }

            const monster = createMonster(buildGrid(16, 16, cells));
            const behavior = new Behavior(monster as any);
            behavior.init();

            // POSITION_OFFSET is 600 units = 6 cells, so with a pinned offset of
            // 300 the destination is (800,800) = cell (8,8), which is free, while
            // its midpoint (650,650) = cell (6,6) is inside the blocked ring. The
            // wander must be skipped, so goto is never called.
            pinWanderOffset(300);
            wander(behavior);

            expect(monster.goto.called).to.be.equal(false);

            // Guards the premise of the assertion above: the destination really is
            // free and only the midpoint is blocked. Without this the test would
            // pass again if the blocked ring grew to cover it.
            const grid = buildGrid(16, 16, cells);
            expect(grid.isPositionBlocked(800, 800), 'destination must be free').to.be.equal(false);
            expect(grid.isPositionBlocked(650, 650), 'midpoint must be blocked').to.be.equal(true);
        });

        it('should always move on maps without attribute data', () => {
            pinWanderOffset(300);
            const monster = createMonster(undefined);
            const behavior = new Behavior(monster as any);
            behavior.init();

            wander(behavior);

            expect(monster.goto.calledOnce).to.be.equal(true);
        });
    });

    describe('attack repositioning', () => {
        const reposition = (behavior: Behavior, args: any) => (behavior as any).changeAttackPosition(args);

        it('should pick a free spot around the target when one exists', () => {
            // Block the left half of the map; the target sits on the boundary.
            const cells: Array<[number, number, number]> = [];
            for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) cells.push([x, y, MapAttributeFlagEnum.BLOCK]);
            const grid = buildGrid(16, 16, cells);

            const monster = createMonster(grid, 900, 800);
            const behavior = new Behavior(monster as any);
            behavior.init();

            for (let i = 0; i < 25; i++) {
                const { dx, dy } = reposition(behavior, {
                    targetX: 900,
                    targetY: 800,
                    monsterX: 900,
                    monsterY: 800,
                    minDistance: 200,
                });
                expect(grid.isPositionBlocked(dx, dy)).to.be.equal(false);
            }
        });

        it('should still return a position when everything around is blocked', () => {
            const cells: Array<[number, number, number]> = [];
            for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) cells.push([x, y, MapAttributeFlagEnum.BLOCK]);

            const monster = createMonster(buildGrid(16, 16, cells), 800, 800);
            const behavior = new Behavior(monster as any);
            behavior.init();

            const result = reposition(behavior, {
                targetX: 800,
                targetY: 800,
                monsterX: 800,
                monsterY: 800,
                minDistance: 200,
            });

            expect(result).to.have.keys(['dx', 'dy']);
            expect(Number.isFinite(result.dx)).to.be.equal(true);
            expect(Number.isFinite(result.dy)).to.be.equal(true);
        });
    });
});
