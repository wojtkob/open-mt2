#!/usr/bin/env node
/**
 * Minimal `ar` archive writer — used to assemble a `.deb`.
 *
 * A Debian binary package is just an `ar` archive holding `debian-binary`,
 * `control.tar.gz` and `data.tar.gz`, so this is ~80 lines of format and lets
 * the release build produce an installable `dpkg -i` artefact on any host,
 * without `dpkg-deb`, `ar` or a Linux container.
 *
 * Member header layout (60 bytes):
 *   0..15   name      (16)  BSD/GNU style, terminated by `/` then spaces
 *  16..27   mtime     (12)  decimal
 *  28..33   uid       (6)   decimal
 *  34..39   gid       (6)   decimal
 *  40..47   mode      (8)   octal
 *  48..57   size      (10)  decimal
 *  58..59   magic     (2)   "`\n"
 */
'use strict';

const GLOBAL_HEADER = Buffer.from('!<arch>\n', 'ascii');
const MEMBER_HEADER_SIZE = 60;
/** File magic closing an `ar` member header: a backtick followed by a newline. */
const FILE_MAGIC = '`\n';

const Field = {
    name: { offset: 0, length: 16 },
    mtime: { offset: 16, length: 12 },
    uid: { offset: 28, length: 6 },
    gid: { offset: 34, length: 6 },
    mode: { offset: 40, length: 8 },
    size: { offset: 48, length: 10 },
    magic: { offset: 58, length: 2 },
};

function padField(header, value, field, padByte = 0x20) {
    const text = String(value);
    if (text.length > field.length) {
        throw new Error(`Value "${text}" does not fit in a ${field.length}-byte ar field`);
    }
    header.write(text, field.offset, field.length, 'ascii');
    header.fill(padByte, field.offset + text.length, field.offset + field.length);
    return header;
}

/**
 * @param {Array<{name: string, data: Buffer, mtime?: number, uid?: number, gid?: number, mode?: number}>} members
 * @returns {Buffer}
 */
function createArArchive(members) {
    const chunks = [GLOBAL_HEADER];

    for (const member of members) {
        if (member.name.endsWith('/') || member.name.endsWith(' ')) {
            throw new Error(`ar member name must not end with a separator: "${member.name}"`);
        }

        const header = Buffer.alloc(MEMBER_HEADER_SIZE, 0x20);
        padField(header, `${member.name}/`, Field.name);
        padField(header, member.mtime ?? 0, Field.mtime);
        padField(header, member.uid ?? 0, Field.uid);
        padField(header, member.gid ?? 0, Field.gid);
        padField(header, (member.mode ?? 0o100644).toString(8), Field.mode);
        padField(header, member.data.length, Field.size);
        padField(header, FILE_MAGIC, Field.magic);

        chunks.push(header, member.data);

        // Members are aligned on an even byte boundary with '\n'.
        if (member.data.length % 2 === 1) {
            chunks.push(Buffer.from('\n', 'ascii'));
        }
    }

    return Buffer.concat(chunks);
}

/**
 * Reads back an `ar` archive. Used by the release verification step (and its
 * unit tests) to prove that a generated `.deb` really is a valid container
 * instead of assuming the writer was correct.
 *
 * @param {Buffer} buffer
 * @returns {Array<{name: string, size: number, mode: number, mtime: number, data: Buffer}>}
 */
function readArArchive(buffer) {
    if (!buffer.subarray(0, GLOBAL_HEADER.length).equals(GLOBAL_HEADER)) {
        throw new Error('Not an ar archive: missing "!<arch>\\n" global header');
    }

    const members = [];
    let offset = GLOBAL_HEADER.length;

    while (offset + MEMBER_HEADER_SIZE <= buffer.length) {
        const header = buffer.subarray(offset, offset + MEMBER_HEADER_SIZE);
        const magic = header.subarray(Field.magic.offset, Field.magic.offset + Field.magic.length).toString('ascii');
        if (magic !== FILE_MAGIC) {
            throw new Error(`Invalid ar member header at offset ${offset}: expected ${JSON.stringify(FILE_MAGIC)}`);
        }

        const field = (name) => header.subarray(Field[name].offset, Field[name].offset + Field[name].length).toString('ascii').trim();
        const name = field('name').replace(/\/$/, '');
        const size = Number.parseInt(field('size'), 10);
        const mtime = Number.parseInt(field('mtime'), 10);
        const mode = Number.parseInt(field('mode'), 8);
        const dataStart = offset + MEMBER_HEADER_SIZE;

        members.push({ name, size, mode, mtime, data: buffer.subarray(dataStart, dataStart + size) });

        // Members are padded to an even byte boundary with a single '\n'.
        offset = dataStart + size + (size % 2);
    }

    return members;
}

module.exports = { createArArchive, readArArchive, GLOBAL_HEADER, MEMBER_HEADER_SIZE };