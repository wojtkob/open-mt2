import { expect } from 'chai';

interface TarEntry {
    name: string;
    data?: Buffer;
    mode?: number;
    type?: 'file' | 'directory' | 'symlink';
    linkname?: string;
}

interface TarDefaults {
    mtime?: number;
    uid?: number;
    gid?: number;
    uname?: string;
    gname?: string;
}

// The tar writer is plain CommonJS JavaScript (`tools/` is excluded from
// `tsconfig.build.json`), so it is loaded through `require` with an explicit
// contract instead of relying on JS type inference.
/* eslint-disable @typescript-eslint/no-require-imports -- the `tools/` scripts are plain CommonJS and ship no type declarations. */
const { BLOCK_SIZE, createTarArchive, splitName, readTarArchive } = require('../../../../tools/package/tarWriter') as {
    BLOCK_SIZE: number;
    createTarArchive: (entries: TarEntry[], defaults?: TarDefaults) => Buffer;
    splitName: (name: string) => { prefix: string; name: string } | null;
    readTarArchive: (buffer: Buffer) => Array<{
        name: string;
        size: number;
        mode: number;
        mtime: number;
        type: string;
        data: Buffer;
    }>;
};

const LONG_NAME_TYPE = 'L';
const SYMLINK_TYPE = '2';

interface ParsedHeader {
    name: string;
    prefix: string;
    mode: string;
    size: number;
    mtime: string;
    typeflag: string;
    linkname: string;
    magic: string;
    uname: string;
    checksum: string;
    computedChecksum: number;
}

function readField(block: Buffer, offset: number, length: number): string {
    return block
        .subarray(offset, offset + length)
        .toString('ascii')
        .replace(/\0[\s\S]*$/, '');
}

function readOctal(block: Buffer, offset: number, length: number): number {
    const text = readField(block, offset, length).trim();
    return text.length === 0 ? 0 : parseInt(text, 8);
}

function parseHeader(block: Buffer): ParsedHeader {
    // The header checksum is computed with the checksum field itself filled
    // with spaces, so the stored value must be blanked out before summing.
    const checksumBlock = Buffer.from(block);
    checksumBlock.write('        ', 148, 8, 'ascii');

    let computed = 0;
    for (const byte of checksumBlock) {
        computed += byte;
    }

    return {
        name: readField(block, 0, 100),
        mode: readField(block, 100, 8).trim(),
        size: readOctal(block, 124, 12),
        mtime: readField(block, 136, 12).trim(),
        typeflag: readField(block, 156, 1),
        linkname: readField(block, 157, 100),
        magic: readField(block, 257, 6),
        uname: readField(block, 265, 32),
        checksum: readField(block, 148, 8).trim(),
        computedChecksum: computed,
        prefix: readField(block, 345, 155),
    };
}

/** Walks an uncompressed tar buffer and returns one entry per header block. */
function parseEntries(archive: Buffer): Array<{ header: ParsedHeader; data: Buffer }> {
    const entries: Array<{ header: ParsedHeader; data: Buffer }> = [];
    let offset = 0;

    while (offset + BLOCK_SIZE <= archive.length) {
        const block = archive.subarray(offset, offset + BLOCK_SIZE);
        if (block.equals(Buffer.alloc(BLOCK_SIZE))) {
            break;
        }

        const header = parseHeader(block);
        const dataStart = offset + BLOCK_SIZE;
        entries.push({ header, data: archive.subarray(dataStart, dataStart + header.size) });
        offset = dataStart + Math.ceil(header.size / BLOCK_SIZE) * BLOCK_SIZE;
    }

    return entries;
}

describe('tarWriter', () => {
    describe('splitName', () => {
        it('should keep a short path entirely inside the name field', () => {
            expect(splitName('opt/open-mt2/dist/game/main.js')).to.deep.equal({
                prefix: '',
                name: 'opt/open-mt2/dist/game/main.js',
            });
        });

        it('should split a long path at a separator into prefix and name', () => {
            const long = `opt/open-mt2/dist/core/infra/config/data/spawn/${'a'.repeat(60)}/regen.json`;
            const split = splitName(long);

            expect(split).to.not.be.null;
            expect(split!.prefix.length).to.be.lessThanOrEqual(155);
            expect(split!.name.length).to.be.lessThanOrEqual(100);
            expect(`${split!.prefix}/${split!.name}`).to.equal(long);
        });

        it('should return null when a single component is longer than the name field', () => {
            expect(splitName(`${'x'.repeat(101)}.js`)).to.be.null;
        });

        it('should return null when no split point leaves both fields within their limits', () => {
            expect(splitName(`${'segment/'.repeat(40)}file.js`)).to.be.null;
        });
    });

    describe('createTarArchive', () => {
        it('should produce an archive aligned on 512 byte blocks', () => {
            const archive = createTarArchive([{ name: 'a.txt', data: Buffer.from('hello') }]);

            expect(archive.length % BLOCK_SIZE).to.equal(0);
        });

        it('should terminate the archive with two zero blocks', () => {
            const archive = createTarArchive([{ name: 'a.txt', data: Buffer.from('hello') }]);

            expect(archive.subarray(archive.length - BLOCK_SIZE * 2).equals(Buffer.alloc(BLOCK_SIZE * 2))).to.be.true;
        });

        it('should write a valid ustar header with a correct checksum', () => {
            const archive = createTarArchive([{ name: 'hello.txt', data: Buffer.from('hi'), mode: 0o644 }]);
            const [entry] = parseEntries(archive);

            expect(entry.header.magic).to.equal('ustar');
            expect(entry.header.typeflag).to.equal('0');
            expect(entry.header.name).to.equal('hello.txt');
            expect(entry.header.mode).to.equal('0000644');
            expect(entry.header.size).to.equal(2);
            expect(entry.data.toString('utf8')).to.equal('hi');
            expect(parseInt(entry.header.checksum, 8)).to.equal(entry.header.computedChecksum);
        });

        it('should not leak the padding of an entry into the next header', () => {
            const archive = createTarArchive([
                { name: 'a.txt', data: Buffer.from('abc') },
                { name: 'b.txt', data: Buffer.from('de') },
            ]);
            const entries = parseEntries(archive);

            expect(entries).to.have.length(2);
            expect(entries[0].data.toString('utf8')).to.equal('abc');
            expect(entries[1].data.toString('utf8')).to.equal('de');
            expect(entries[1].header.name).to.equal('b.txt');
        });

        it('should default file entries to mode 0644 and directories to 0755', () => {
            const archive = createTarArchive([
                { name: 'dir/', type: 'directory' },
                { name: 'dir/file.txt', data: Buffer.from('x') },
            ]);
            const [dir, file] = parseEntries(archive);

            expect(dir.header.typeflag).to.equal('5');
            expect(dir.header.mode).to.equal('0000755');
            expect(dir.header.size).to.equal(0);
            expect(file.header.mode).to.equal('0000644');
        });

        it('should record the symlink target instead of a payload', () => {
            const archive = createTarArchive([{ name: 'link', type: 'symlink', linkname: '../real/target' }]);
            const [entry] = parseEntries(archive);

            expect(entry.header.typeflag).to.equal(SYMLINK_TYPE);
            expect(entry.header.linkname).to.equal('../real/target');
            expect(entry.header.size).to.equal(0);
        });

        it('should apply the supplied mtime and owner defaults to every entry', () => {
            const archive = createTarArchive(
                [
                    { name: 'one.txt', data: Buffer.from('1') },
                    { name: 'two.txt', data: Buffer.from('2') },
                ],
                { mtime: 1700000000, uid: 1000, gid: 1001, uname: 'open-mt2', gname: 'open-mt2' },
            );
            const entries = parseEntries(archive);

            expect(entries).to.have.length(2);
            for (const entry of entries) {
                expect(entry.header.mtime).to.equal((1700000000).toString(8));
                expect(entry.header.uname).to.equal('open-mt2');
            }
        });

        it('should default every entry to mtime 0 and root ownership for reproducible builds', () => {
            const archive = createTarArchive([{ name: 'a.txt', data: Buffer.from('a') }]);
            const [entry] = parseEntries(archive);

            expect(entry.header.mtime).to.equal('00000000000');
            expect(entry.header.uname).to.equal('root');
        });

        it('should emit a GNU long-name entry for a path that cannot fit in ustar', () => {
            const longName = `opt/open-mt2/dist/core/infra/config/data/spawn/${'m'.repeat(120)}/regen.json`;
            const archive = createTarArchive([{ name: longName, data: Buffer.from('{}') }]);
            const entries = parseEntries(archive);

            expect(entries).to.have.length(2);
            expect(entries[0].header.typeflag).to.equal(LONG_NAME_TYPE);
            expect(entries[0].header.name).to.equal('././@LongLink');
            expect(entries[0].data.toString('utf8')).to.equal(`${longName}\0`);
            expect(entries[1].header.size).to.equal(2);
        });

        it('should reuse a split prefix/name header without a long-name entry', () => {
            const name = `opt/open-mt2/dist/core/infra/config/data/spawn/${'map'.repeat(15)}/regen.json`;
            const archive = createTarArchive([{ name, data: Buffer.from('{}') }]);
            const entries = parseEntries(archive);

            expect(entries).to.have.length(1);
            expect(entries[0].header.prefix.length).to.be.greaterThan(0);
            expect(`${entries[0].header.prefix}/${entries[0].header.name}`).to.equal(name);
            expect(entries[0].header.typeflag).to.equal('0');
        });

        it('should refuse to use the long-name extension for a directory', () => {
            const longDirectory = `opt/open-mt2/dist/core/infra/config/data/spawn/${'d'.repeat(120)}/`;

            expect(() => createTarArchive([{ name: longDirectory, type: 'directory' }])).to.throw(
                'Only file entries can use the GNU long-name extension',
            );
        });

        it('should produce byte-identical output for identical input', () => {
            const entries: TarEntry[] = [
                { name: 'a.txt', data: Buffer.from('a'), mode: 0o644 },
                { name: 'dir/', type: 'directory', mode: 0o755 },
            ];

            expect(createTarArchive(entries, { mtime: 42 })).to.deep.equal(createTarArchive(entries, { mtime: 42 }));
        });
    });

    describe('readTarArchive', () => {
        it('should round-trip a directory and a file entry', () => {
            const archive = createTarArchive([
                { name: 'dist/', type: 'directory', mode: 0o755 },
                { name: 'dist/game/main.js', data: Buffer.from('console.log(1);'), mode: 0o644 },
            ]);

            expect(readTarArchive(archive)).to.deep.equal([
                { name: 'dist/', size: 0, mode: 0o755, mtime: 0, type: '5', data: Buffer.alloc(0) },
                {
                    name: 'dist/game/main.js',
                    size: 15,
                    mode: 0o644,
                    mtime: 0,
                    type: '0',
                    data: Buffer.from('console.log(1);'),
                },
            ]);
        });

        it('should reassemble a prefix/name split into the original path', () => {
            const name = `opt/open-mt2/dist/core/infra/config/data/spawn/${'map'.repeat(15)}/regen.json`;
            const [entry] = readTarArchive(createTarArchive([{ name, data: Buffer.from('{}') }]));

            expect(entry.name).to.equal(name);
            expect(entry.data.toString('utf8')).to.equal('{}');
        });

        it('should resolve a GNU long-name entry back to the full path', () => {
            const name = `opt/open-mt2/dist/core/infra/config/data/spawn/${'m'.repeat(120)}/regen.json`;
            const entries = readTarArchive(createTarArchive([{ name, data: Buffer.from('{}') }]));

            expect(entries).to.have.length(1);
            expect(entries[0].name).to.equal(name);
        });

        it('should stop at the zero-block terminator instead of reading past it', () => {
            const archive = createTarArchive([{ name: 'a.txt', data: Buffer.from('a') }]);

            expect(readTarArchive(archive)).to.have.length(1);
            expect(readTarArchive(Buffer.concat([archive, Buffer.alloc(BLOCK_SIZE)]))).to.have.length(1);
        });

        it('should report the mtime that was written', () => {
            const [entry] = readTarArchive(
                createTarArchive([{ name: 'a.txt', data: Buffer.from('a') }], { mtime: 1700000000 }),
            );

            expect(entry.mtime).to.equal(1700000000);
        });
    });
});
