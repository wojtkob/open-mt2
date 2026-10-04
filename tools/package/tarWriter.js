#!/usr/bin/env node
/**
 * Minimal, dependency-free tar (ustar + GNU long-name) writer.
 *
 * The release artefacts must be buildable from any machine that can run
 * `npm run build` — including a Windows dev box with no GNU tar and no admin
 * rights — and must produce byte-identical layout on the Pine A64 target.
 * Implementing the ~200 byte format here removes both the external dependency
 * and the platform difference.
 *
 * Format reference: POSIX.1-1988 ustar headers, plus GNU `L` (LongLink) entries
 * for names that do not fit in the 100 byte `name`/`prefix` pair (the spawn
 * data alone exceeds it, e.g.
 * `opt/open-mt2/dist/core/infra/config/data/spawn/metin2_map_dragon_timeattack_01/regen.json`).
 */
'use strict';

const BLOCK_SIZE = 512;

const Field = {
    name: { offset: 0, length: 100 },
    mode: { offset: 100, length: 8 },
    uid: { offset: 108, length: 8 },
    gid: { offset: 116, length: 8 },
    size: { offset: 124, length: 12 },
    mtime: { offset: 136, length: 12 },
    chksum: { offset: 148, length: 8 },
    typeflag: { offset: 156, length: 1 },
    linkname: { offset: 157, length: 100 },
    magic: { offset: 257, length: 6 },
    version: { offset: 263, length: 2 },
    uname: { offset: 265, length: 32 },
    gname: { offset: 297, length: 32 },
    devmajor: { offset: 329, length: 8 },
    devminor: { offset: 337, length: 8 },
    prefix: { offset: 345, length: 155 },
};

const TypeFlag = {
    file: '0',
    link: '1',
    symlink: '2',
    directory: '5',
    longName: 'L',
};

const LONG_NAME_ENTRY = '././@LongLink';

function padTo(value, length, padByte = 0x00) {
    const buffer = Buffer.alloc(length, padByte);
    buffer.write(value, 0, length, 'ascii');
    return buffer;
}

function writeOctal(header, value, field) {
    const text = Math.floor(value).toString(8).padStart(field.length - 1, '0');
    if (text.length > field.length - 1) {
        throw new Error(`Value ${value} does not fit in a ${field.length}-byte octal tar field`);
    }
    header.write(text, field.offset, field.length - 1, 'ascii');
    header[field.offset + field.length - 1] = 0x00;
}

/**
 * ustar splits long paths into `prefix` + `name` at a `/`. Returns `null` when
 * the path cannot be represented, in which case a GNU LongLink entry is used.
 */
function splitName(name) {
    const nameBytes = Buffer.byteLength(name, 'utf8');
    if (nameBytes <= Field.name.length) {
        return { prefix: '', name };
    }

    // The split point must leave <=100 bytes for `name` and <=155 for `prefix`.
    let index = name.lastIndexOf('/', Field.prefix.length);
    while (index > 0) {
        const prefix = name.slice(0, index);
        const remainder = name.slice(index + 1);
        if (
            Buffer.byteLength(prefix, 'utf8') <= Field.prefix.length &&
            Buffer.byteLength(remainder, 'utf8') <= Field.name.length
        ) {
            return { prefix, name: remainder };
        }
        index = name.lastIndexOf('/', index - 1);
    }

    return null;
}

function buildHeader({
    name,
    prefix,
    size,
    mode,
    mtime,
    uid,
    gid,
    uname,
    gname,
    typeflag,
    linkname,
}) {
    const header = Buffer.alloc(BLOCK_SIZE);

    padTo(name, Field.name.length).copy(header, Field.name.offset);
    writeOctal(header, mode, Field.mode);
    writeOctal(header, uid, Field.uid);
    writeOctal(header, gid, Field.gid);
    writeOctal(header, size, Field.size);
    writeOctal(header, mtime, Field.mtime);
    header.write('        ', Field.chksum.offset, Field.chksum.length, 'ascii');
    header.write(typeflag, Field.typeflag.offset, Field.typeflag.length, 'ascii');
    padTo(linkname ?? '', Field.linkname.length).copy(header, Field.linkname.offset);
    header.write('ustar\0', Field.magic.offset, Field.magic.length, 'ascii');
    header.write('00', Field.version.offset, Field.version.length, 'ascii');
    padTo(uname, Field.uname.length).copy(header, Field.uname.offset);
    padTo(gname, Field.gname.length).copy(header, Field.gname.offset);
    writeOctal(header, 0, Field.devmajor);
    writeOctal(header, 0, Field.devminor);
    padTo(prefix ?? '', Field.prefix.length).copy(header, Field.prefix.offset);

    let checksum = 0;
    for (const byte of header) {
        checksum += byte;
    }
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(checksumText, Field.chksum.offset, 6, 'ascii');
    header[Field.chksum.offset + 6] = 0x00;
    header[Field.chksum.offset + 7] = 0x20;

    return header;
}

function dataBlocks(data) {
    const padded = Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE;
    const buffer = Buffer.alloc(padded, 0x00);
    data.copy(buffer, 0);
    return buffer;
}

/**
 * @param {Array<{name: string, data?: Buffer, mode?: number, type?: 'file'|'directory'|'symlink', linkname?: string}>} entries
 * @param {{mtime?: number, uid?: number, gid?: number, uname?: string, gname?: string}} [defaults]
 * @returns {Buffer} the complete (uncompressed) tar archive
 */
function createTarArchive(entries, defaults = {}) {
    const base = {
        mtime: defaults.mtime ?? 0,
        uid: defaults.uid ?? 0,
        gid: defaults.gid ?? 0,
        uname: defaults.uname ?? 'root',
        gname: defaults.gname ?? 'root',
    };

    const chunks = [];

    for (const entry of entries) {
        const type = entry.type ?? 'file';
        const mode = entry.mode ?? (type === 'directory' ? 0o755 : 0o644);
        const size = type === 'file' ? (entry.data ?? Buffer.alloc(0)).length : 0;
        const linkname = type === 'symlink' ? (entry.linkname ?? '') : '';

        const split = splitName(entry.name);
        if (split === null) {
            if (type !== 'file') {
                throw new Error(`Only file entries can use the GNU long-name extension: ${entry.name}`);
            }
            const nameBuffer = Buffer.concat([Buffer.from(entry.name, 'utf8'), Buffer.from([0])]);
            chunks.push(
                buildHeader({
                    name: LONG_NAME_ENTRY,
                    prefix: '',
                    size: nameBuffer.length,
                    mode: 0o644,
                    typeflag: TypeFlag.longName,
                    linkname: '',
                    ...base,
                }),
                dataBlocks(nameBuffer),
            );
        }

        const resolved = split ?? { prefix: '', name: entry.name.slice(0, Field.name.length) };

        chunks.push(
            buildHeader({
                name: resolved.name,
                prefix: resolved.prefix,
                size,
                mode,
                typeflag: TypeFlag[type],
                linkname,
                ...base,
            }),
        );

        if (size > 0) {
            chunks.push(dataBlocks(entry.data));
        }
    }

    // Two zero blocks terminate the archive.
    chunks.push(Buffer.alloc(BLOCK_SIZE * 2));

    return Buffer.concat(chunks);
}

/**
 * Reads back an uncompressed tar archive, resolving GNU long-name entries so
 * that the returned names are the real paths. Used by the release verification
 * step (and its unit tests) to prove that a generated archive round-trips.
 *
 * @param {Buffer} buffer
 * @returns {Array<{name: string, size: number, mode: number, type: string, mtime: number, data: Buffer}>}
 */
function readTarArchive(buffer) {
    const entries = [];
    let offset = 0;
    let pendingLongName = null;

    while (offset + BLOCK_SIZE <= buffer.length) {
        const header = buffer.subarray(offset, offset + BLOCK_SIZE);
        if (header.equals(Buffer.alloc(BLOCK_SIZE))) {
            break;
        }

        const field = (name, encoding = 'ascii') =>
            header
                .subarray(Field[name].offset, Field[name].offset + Field[name].length)
                .toString(encoding)
                .replace(/\0[\s\S]*$/, '');

        const octal = (name) => {
            const text = field(name).trim();
            return text.length === 0 ? 0 : Number.parseInt(text, 8);
        };

        const typeflag = String.fromCharCode(header[Field.typeflag.offset]);
        const dataStart = offset + BLOCK_SIZE;
        const size = octal('size');
        const data = buffer.subarray(dataStart, dataStart + size);

        if (typeflag === TypeFlag.longName) {
            pendingLongName = data.toString('utf8').replace(/\0[\s\S]*$/, '');
        } else {
            const prefix = field('prefix');
            const name = field('name');
            entries.push({
                name: pendingLongName ?? (prefix ? `${prefix}/${name}` : name),
                size,
                mode: octal('mode'),
                mtime: octal('mtime'),
                type: typeflag,
                data,
            });
            pendingLongName = null;
        }

        offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    }

    return entries;
}

module.exports = { createTarArchive, BLOCK_SIZE, splitName, readTarArchive };