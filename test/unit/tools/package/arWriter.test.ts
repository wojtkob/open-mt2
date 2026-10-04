import { expect } from 'chai';

interface ArMember {
    name: string;
    data: Buffer;
    mtime?: number;
    uid?: number;
    gid?: number;
    mode?: number;
}

interface ParsedMember {
    name: string;
    mtime: string;
    uid: string;
    gid: string;
    mode: string;
    size: number;
    magic: string;
    data: Buffer;
}

// The `ar` writer is plain CommonJS JavaScript (`tools/` is excluded from
// `tsconfig.build.json`), so it is loaded through `require` with an explicit
// contract instead of relying on JS type inference.
/* eslint-disable @typescript-eslint/no-require-imports -- the `tools/` scripts are plain CommonJS and ship no type declarations. */
const { createArArchive, readArArchive, GLOBAL_HEADER, MEMBER_HEADER_SIZE } =
    require('../../../../tools/package/arWriter') as {
        createArArchive: (members: ArMember[]) => Buffer;
        readArArchive: (buffer: Buffer) => Array<{
            name: string;
            size: number;
            mode: number;
            mtime: number;
            data: Buffer;
        }>;
        GLOBAL_HEADER: Buffer;
        MEMBER_HEADER_SIZE: number;
    };

function readField(block: Buffer, offset: number, length: number): string {
    return block
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0[\s\S]*$/, '')
        .trim();
}

function parseMembers(archive: Buffer): ParsedMember[] {
    expect(archive.subarray(0, GLOBAL_HEADER.length).equals(GLOBAL_HEADER)).to.be.true;

    const members: ParsedMember[] = [];
    let offset = GLOBAL_HEADER.length;

    while (offset + MEMBER_HEADER_SIZE <= archive.length) {
        const header = archive.subarray(offset, offset + MEMBER_HEADER_SIZE);
        const size = Number.parseInt(readField(header, 48, 10), 10);
        const dataStart = offset + MEMBER_HEADER_SIZE;

        members.push({
            name: readField(header, 0, 16).replace(/\/$/, ''),
            mtime: readField(header, 16, 12),
            uid: readField(header, 28, 6),
            gid: readField(header, 34, 6),
            mode: readField(header, 40, 8),
            size,
            magic: header.subarray(58, 60).toString('ascii'),
            data: archive.subarray(dataStart, dataStart + size),
        });

        offset = dataStart + size + (size % 2);
    }

    return members;
}

describe('arWriter', () => {
    describe('createArArchive', () => {
        it('should start with the ar global header', () => {
            const archive = createArArchive([]);

            expect(archive.subarray(0, 8).toString('ascii')).to.equal('!<arch>\n');
            expect(archive.length).to.equal(8);
        });

        it('should lay out the three members of a .deb in order', () => {
            const archive = createArArchive([
                { name: 'debian-binary', data: Buffer.from('2.0\n') },
                { name: 'control.tar.gz', data: Buffer.from('control') },
                { name: 'data.tar.gz', data: Buffer.from('data') },
            ]);
            const members = parseMembers(archive);

            expect(members.map((member) => member.name)).to.deep.equal([
                'debian-binary',
                'control.tar.gz',
                'data.tar.gz',
            ]);
            expect(members.map((member) => member.data.toString('utf8'))).to.deep.equal(['2.0\n', 'control', 'data']);
        });

        it('should terminate every member header with the backtick-newline magic', () => {
            const [member] = parseMembers(createArArchive([{ name: 'debian-binary', data: Buffer.from('2.0\n') }]));

            expect(member.magic).to.equal('`\n');
        });

        it('should space-pad the name field and terminate it with a slash', () => {
            const [member] = parseMembers(createArArchive([{ name: 'debian-binary', data: Buffer.from('x') }]));

            expect(member.name).to.equal('debian-binary');
            expect(member.name).to.not.match(/\s/);
        });

        it('should default ownership, mtime and mode to the regular-file convention', () => {
            const [member] = parseMembers(createArArchive([{ name: 'data.tar.gz', data: Buffer.from('x') }]));

            expect(member.mtime).to.equal('0');
            expect(member.uid).to.equal('0');
            expect(member.gid).to.equal('0');
            expect(member.mode).to.equal('100644');
        });

        it('should honour explicit mtime/uid/gid/mode overrides', () => {
            const [member] = parseMembers(
                createArArchive([
                    {
                        name: 'postinst',
                        data: Buffer.from('#!/bin/sh\n'),
                        mtime: 1700000000,
                        uid: 0,
                        gid: 0,
                        mode: 0o100755,
                    },
                ]),
            );

            expect(member.mtime).to.equal('1700000000');
            expect(member.mode).to.equal('100755');
        });

        it('should record the declared size in the header', () => {
            const data = Buffer.alloc(1234, 0x61);
            const [member] = parseMembers(createArArchive([{ name: 'data.tar.gz', data }]));

            expect(member.size).to.equal(1234);
            expect(member.data.equals(data)).to.be.true;
        });

        it('should pad an odd-sized member with a newline so the next header stays aligned', () => {
            const archive = createArArchive([
                { name: 'debian-binary', data: Buffer.from('2.0\n') },
                { name: 'control.tar.gz', data: Buffer.from('control') },
            ]);
            const members = parseMembers(archive);

            expect(members).to.have.length(2);
            expect(members[1].data.toString('utf8')).to.equal('control');
            expect(archive.length).to.equal(
                GLOBAL_HEADER.length + (MEMBER_HEADER_SIZE + 4 + 1) + (MEMBER_HEADER_SIZE + 7),
            );
        });

        it('should not pad an even-sized member', () => {
            const archive = createArArchive([{ name: 'data.tar.gz', data: Buffer.alloc(8, 0x62) }]);

            expect(archive.length).to.equal(GLOBAL_HEADER.length + MEMBER_HEADER_SIZE + 8);
        });

        it('should reject a member name that already ends with a separator', () => {
            expect(() => createArArchive([{ name: 'data.tar.gz/', data: Buffer.from('x') }])).to.throw(
                'ar member name must not end with a separator',
            );
        });

        it('should reject a member name that does not fit in the 16 byte name field', () => {
            expect(() => createArArchive([{ name: 'a'.repeat(17), data: Buffer.from('x') }])).to.throw(
                'does not fit in a 16-byte ar field',
            );
        });
    });

    describe('readArArchive', () => {
        it('should round-trip the three members of a .deb', () => {
            const members: ArMember[] = [
                { name: 'debian-binary', data: Buffer.from('2.0\n'), mtime: 0 },
                { name: 'control.tar.gz', data: Buffer.alloc(512, 0x11), mode: 0o100644, mtime: 0 },
                { name: 'data.tar.gz', data: Buffer.alloc(4096, 0x22), mode: 0o100644, mtime: 0 },
            ];

            expect(readArArchive(createArArchive(members))).to.deep.equal(
                members.map((member) => ({
                    name: member.name,
                    size: member.data.length,
                    mode: member.mode ?? 0o100644,
                    mtime: member.mtime ?? 0,
                    data: member.data,
                })),
            );
        });

        it('should round-trip an odd-sized member without losing the next header', () => {
            const [odd, even] = readArArchive(
                createArArchive([
                    { name: 'debian-binary', data: Buffer.from('2.0\n') },
                    { name: 'control.tar.gz', data: Buffer.from('seven!!') },
                ]),
            );

            expect(odd.data.toString('utf8')).to.equal('2.0\n');
            expect(even.data.toString('utf8')).to.equal('seven!!');
        });

        it('should return an empty list for an archive with no members', () => {
            expect(readArArchive(createArArchive([]))).to.deep.equal([]);
        });

        it('should reject a buffer without the global header', () => {
            expect(() => readArArchive(Buffer.from('not an archive'))).to.throw('missing "!<arch>\\n" global header');
        });

        it('should reject a member header whose magic is corrupted', () => {
            const archive = createArArchive([{ name: 'debian-binary', data: Buffer.from('2.0\n') }]);
            archive[GLOBAL_HEADER.length + 58] = 0x00;

            expect(() => readArArchive(archive)).to.throw('Invalid ar member header');
        });
    });
});
