// A fake Kasa device on localhost speaking the XOR protocol on TCP (python-kasa's XorTransport, device side).
import net from 'node:net';

const KEY = 171;

function encrypt(text) {
  const plain = Buffer.from(text);
  const out = Buffer.alloc(plain.length + 4);
  out.writeUInt32BE(plain.length);
  let key = KEY;
  for (let i = 0; i < plain.length; i++) out[i + 4] = key = key ^ plain[i];
  return out;
}

function decrypt(data) {
  const out = Buffer.alloc(data.length);
  let key = KEY;
  for (let i = 0; i < data.length; i++) {
    out[i] = key ^ data[i];
    key = data[i];
  }
  return out.toString();
}

export function createFakeKasaDevice(handle) {
  const state = { requests: [] };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32BE(0) + 4) return;
      const request = JSON.parse(decrypt(buffer.subarray(4, buffer.readUInt32BE(0) + 4)));
      buffer = Buffer.alloc(0);
      state.requests.push(request);
      const response = encrypt(JSON.stringify(handle(request)));
      // Answer in two pieces, like a slow device
      socket.write(response.subarray(0, 3));
      setTimeout(() => socket.write(response.subarray(3)), 5);
    });
  });
  return {
    state,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return server.address().port;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
