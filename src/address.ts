export interface TargetAddress {
    hostname: string;
    port: number;
    byteLength: number;
}

/**
 * 解析 Sudoku 协议开头携带的目标地址 (类似于 SOCKS5 地址格式)
 * 返回解析出的域名/IP、端口，以及占用字节数。如果数据不够返回 null。
 */
export function parseTargetAddress(buffer: Uint8Array): TargetAddress | null {
    if (buffer.length < 2) return null;

    const addrType = buffer[0];
    let hostname = '';
    let port = 0;
    let offset = 1;

    if (addrType === 0x01) { // IPv4
        if (buffer.length < offset + 4 + 2) return null;
        const ipBytes = buffer.subarray(offset, offset + 4);
        hostname = Array.from(ipBytes).join('.');
        offset += 4;
    } else if (addrType === 0x03) { // Domain
        const domainLen = buffer[1];
        if (buffer.length < offset + 1 + domainLen + 2) return null;
        offset += 1;
        const domainBytes = buffer.subarray(offset, offset + domainLen);
        hostname = new TextDecoder().decode(domainBytes);
        offset += domainLen;
    } else if (addrType === 0x04) { // IPv6
        if (buffer.length < offset + 16 + 2) return null;
        const ipBytes = buffer.subarray(offset, offset + 16);
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(((ipBytes[i] << 8) | ipBytes[i + 1]).toString(16));
        }
        hostname = `[${parts.join(':')}]`;
        offset += 16;
    } else {
        throw new Error(`Unknown address type: ${addrType}`);
    }

    // port is 2 bytes big-endian
    port = (buffer[offset] << 8) | buffer[offset + 1];
    offset += 2;

    return { hostname, port, byteLength: offset };
}
