'use strict';

/**
 * A small Matroska reader for the tests: enough EBML to list the clusters and blocks of a file written by the
 * recorder's muxer (or by FFmpeg), so tests can check the structure without trusting the muxer's own code.
 */

const MASTER = new Set([
    0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1, 0x1f43b675, 0xa0, 0x1c53bb6b, 0xbb, 0xb7, 0x114d9b74,
]);

function readId(buf, o) {
    const first = buf[o];
    let length = 1;
    while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > 4) throw new Error(`bad element id at ${o}`);
    let id = 0;
    for (let i = 0; i < length; i++) id = id * 256 + buf[o + i];
    return { id, length };
}

function readSize(buf, o) {
    const first = buf[o];
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > 8) throw new Error(`bad element size at ${o}`);
    let value = first & (0xff >> length);
    let allOnes = value === 0xff >> length;
    for (let i = 1; i < length; i++) {
        value = value * 256 + buf[o + i];
        if (buf[o + i] !== 0xff) allOnes = false;
    }
    return { size: allOnes ? -1 : value, length };
}

function readUint(buf, start, end) {
    let value = 0;
    for (let i = start; i < end; i++) value = value * 256 + buf[i];
    return value;
}

/** @returns {{docType: string, timecodeScale: number, tracks: object[], clusters: object[], segmentSize: number}} */
function parseMkv(buf) {
    const result = { docType: null, timecodeScale: null, tracks: [], clusters: [], segmentSize: null };
    let current = null;

    function walk(start, end, path) {
        let o = start;
        while (o < end) {
            const { id, length: idLength } = readId(buf, o);
            const { size, length: sizeLength } = readSize(buf, o + idLength);
            const dataStart = o + idLength + sizeLength;
            const dataEnd = size === -1 ? end : dataStart + size;
            if (dataEnd > end) throw new Error(`element ${id.toString(16)} at ${o} runs past its parent`);

            if (id === 0x1a45dfa3) {
                walk(dataStart, dataEnd, 'ebml');
            } else if (id === 0x4282 && path === 'ebml') {
                result.docType = buf.toString('ascii', dataStart, dataEnd);
            } else if (id === 0x18538067) {
                result.segmentSize = size;
                walk(dataStart, dataEnd, 'segment');
            } else if (id === 0x2ad7b1) {
                result.timecodeScale = readUint(buf, dataStart, dataEnd);
            } else if (id === 0x1549a966 || id === 0x1654ae6b) {
                walk(dataStart, dataEnd, id === 0x1549a966 ? 'info' : 'tracks');
            } else if (id === 0xae) {
                const track = {};
                result.tracks.push(track);
                let p = dataStart;
                while (p < dataEnd) {
                    const child = readId(buf, p);
                    const childSize = readSize(buf, p + child.length);
                    const cStart = p + child.length + childSize.length;
                    if (child.id === 0xd7) track.number = readUint(buf, cStart, cStart + childSize.size);
                    if (child.id === 0x83) track.type = readUint(buf, cStart, cStart + childSize.size);
                    if (child.id === 0x86) track.codec = buf.toString('ascii', cStart, cStart + childSize.size);
                    if (child.id === 0x63a2) track.codecPrivate = buf.subarray(cStart, cStart + childSize.size);
                    if (child.id === 0x56aa) track.codecDelay = readUint(buf, cStart, cStart + childSize.size);
                    if (child.id === 0x56bb) track.seekPreRoll = readUint(buf, cStart, cStart + childSize.size);
                    p = cStart + childSize.size;
                }
            } else if (id === 0x1f43b675) {
                current = { ts: null, blocks: [], size, start: o };
                result.clusters.push(current);
                walk(dataStart, dataEnd, 'cluster');
            } else if (id === 0xe7 && path === 'cluster') {
                current.ts = readUint(buf, dataStart, dataEnd);
            } else if (id === 0xa3 && path === 'cluster') {
                const track = buf[dataStart] & 0x7f;
                const rel = buf.readInt16BE(dataStart + 1);
                const flags = buf[dataStart + 3];
                current.blocks.push({
                    track,
                    rel,
                    ts: current.ts + rel,
                    key: (flags & 0x80) !== 0,
                    size: dataEnd - dataStart - 4,
                    data: buf.subarray(dataStart + 4, dataEnd),
                });
            } else if (MASTER.has(id)) {
                // not needed: skip
            }
            o = dataEnd;
        }
    }

    walk(0, buf.length, 'top');
    return result;
}

module.exports = { parseMkv };
