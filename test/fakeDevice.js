// A fake Tapo device on localhost speaking KLAP v2 or AES securePassthrough, written from the device's
// side of the protocol as python-kasa describes it.
import crypto from 'node:crypto';
import http from 'node:http';

const sha1 = (data) => crypto.createHash('sha1').update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

export function createFakeDevice({ protocol, username, password, handle }) {
  const state = { requests: [], handshakes: 0, logins: [], expireNext: false, sessions: new Map() };
  const authHash = sha256(Buffer.concat([sha1(username), sha1(password)]));
  let nextSession = 1;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://localhost');
      const sessionId = /TP_SESSIONID=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      const session = sessionId ? state.sessions.get(sessionId) : undefined;
      try {
        if (protocol === 'klap') klap(url, body, session, res);
        else aes(url, body, session, res);
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });

  function newSession(res, data) {
    const id = `S${nextSession++}`;
    state.sessions.set(id, data);
    res.setHeader('Set-Cookie', `TP_SESSIONID=${id};TIMEOUT=86400`);
    return data;
  }

  function reply(request) {
    state.requests.push(request);
    return handle(request);
  }

  function klap(url, body, session, res) {
    if (url.pathname === '/app/handshake1') {
      state.handshakes++;
      const remoteSeed = crypto.randomBytes(16);
      newSession(res, { localSeed: body, remoteSeed, confirmed: false });
      res.writeHead(200);
      res.end(Buffer.concat([remoteSeed, sha256(Buffer.concat([body, remoteSeed, authHash]))]));
      return;
    }
    if (url.pathname === '/app/handshake2') {
      const ok = session && body.equals(sha256(Buffer.concat([session.remoteSeed, session.localSeed, authHash])));
      if (ok) session.confirmed = true;
      res.writeHead(ok ? 200 : 403);
      res.end();
      return;
    }
    if (url.pathname === '/app/request') {
      if (!session?.confirmed || state.expireNext) {
        state.expireNext = false;
        res.writeHead(403);
        res.end();
        return;
      }
      const seeds = Buffer.concat([session.localSeed, session.remoteSeed, authHash]);
      const key = sha256(Buffer.concat([Buffer.from('lsk'), seeds])).subarray(0, 16);
      const iv = Buffer.alloc(16);
      sha256(Buffer.concat([Buffer.from('iv'), seeds])).copy(iv, 0, 0, 12);
      iv.writeInt32BE(Number(url.searchParams.get('seq')), 12);
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      const request = JSON.parse(Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]).toString());
      const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(reply(request))), cipher.final()]);
      res.writeHead(200);
      res.end(Buffer.concat([Buffer.alloc(32), encrypted]));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  function aes(url, body, session, res) {
    if (url.pathname !== '/app') {
      res.writeHead(404);
      res.end();
      return;
    }
    const json = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const message = JSON.parse(body.toString());
    if (message.method === 'handshake') {
      state.handshakes++;
      const key = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      newSession(res, { key, iv, token: undefined });
      const encrypted = crypto.publicEncrypt({ key: message.params.key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([key, iv]));
      json({ error_code: 0, result: { key: encrypted.toString('base64') } });
      return;
    }
    if (message.method !== 'securePassthrough' || !session) return json({ error_code: -1003 });
    const token = url.searchParams.get('token');
    if ((token && token !== session.token) || state.expireNext) {
      state.expireNext = false;
      return json({ error_code: 9999 });
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', session.key, session.iv);
    const request = JSON.parse(Buffer.concat([decipher.update(Buffer.from(message.params.request, 'base64')), decipher.final()]).toString());
    let response;
    if (request.method === 'login_device') {
      state.logins.push(request.params);
      const expectedUser = Buffer.from(sha1(username).toString('hex')).toString('base64');
      const expectedPassword2 = Buffer.from(sha1(password).toString('hex')).toString('base64');
      if (request.params.username === expectedUser && request.params.password2 === expectedPassword2) {
        session.token = crypto.randomBytes(8).toString('hex');
        response = { error_code: 0, result: { token: session.token } };
      } else {
        response = { error_code: -1501 };
      }
    } else if (!token) {
      response = { error_code: -1501 };
    } else {
      response = reply(request);
    }
    const cipher = crypto.createCipheriv('aes-128-cbc', session.key, session.iv);
    json({ error_code: 0, result: { response: Buffer.concat([cipher.update(JSON.stringify(response)), cipher.final()]).toString('base64') } });
  }

  return {
    state,
    server,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return server.address().port;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
