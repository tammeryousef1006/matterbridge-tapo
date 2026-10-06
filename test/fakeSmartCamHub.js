// A fake H200/H500 hub on localhost speaking the HTTPS "smartcam" protocol from the device's side,
// as python-kasa's SslAesTransport describes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

const sha256U = (s) => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

export function createFakeSmartCamHub({ password, children, basicInfo }) {
  const state = { logins: [], requests: [], expireNext: false, sessions: new Map() };
  const pwdHash = sha256U(password);
  let pending;

  const server = https.createServer(
    { key: fs.readFileSync(new URL('./fixtures/selfsigned.key', import.meta.url)), cert: fs.readFileSync(new URL('./fixtures/selfsigned.crt', import.meta.url)) },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const json = (status, body) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        const body = JSON.parse(raw);
        if (req.url === '/') {
          const { params } = body;
          state.logins.push(params.username);
          if (params.username !== 'admin') return json(200, { error_code: -40411 });
          if (!params.digest_passwd) {
            const nonce = crypto.randomBytes(8).toString('hex').toUpperCase();
            pending = { cnonce: params.cnonce, nonce };
            return json(200, {
              error_code: -40413,
              result: { data: { nonce, device_confirm: sha256U(params.cnonce + pwdHash + nonce) + nonce + params.cnonce, code: -40413 } },
            });
          }
          if (params.digest_passwd !== sha256U(pwdHash + pending.cnonce + pending.nonce) + pending.cnonce + pending.nonce) return json(200, { error_code: -40413 });
          const stok = crypto.randomBytes(8).toString('hex');
          const hashedKey = sha256U(pending.cnonce + pwdHash + pending.nonce);
          const token = (type) => sha256(type + pending.cnonce + pending.nonce + hashedKey).subarray(0, 16);
          state.sessions.set(stok, { key: token('lsk'), iv: token('ivb'), seq: 100, cnonce: pending.cnonce });
          return json(200, { error_code: 0, result: { stok, start_seq: 100, user_group: 'root' } });
        }
        const stok = /^\/stok=([^/]+)\/ds$/.exec(req.url)?.[1];
        const session = stok && state.sessions.get(stok);
        if (!session || state.expireNext) {
          state.expireNext = false;
          return json(401, { error_code: -40401 });
        }
        const tag = sha256U(sha256U(pwdHash + session.cnonce) + raw + req.headers.seq);
        if (Number(req.headers.seq) !== session.seq || req.headers.tapo_tag !== tag) return json(200, { error_code: -40401 });
        session.seq++;
        const decipher = crypto.createDecipheriv('aes-128-cbc', session.key, session.iv);
        const request = JSON.parse(Buffer.concat([decipher.update(Buffer.from(body.params.request, 'base64')), decipher.final()]).toString());
        state.requests.push(request);
        const responses = request.params.requests.map(({ method, params }) => ({ method, error_code: 0, result: handle(method, params) }));
        const cipher = crypto.createCipheriv('aes-128-cbc', session.key, session.iv);
        const response = JSON.stringify({ error_code: 0, result: { responses } });
        json(200, { seq: session.seq, result: { response: Buffer.concat([cipher.update(response), cipher.final()]).toString('base64') } });
      });
    },
  );

  function handle(method, params) {
    switch (method) {
      case 'getDeviceInfo':
        return { device_info: { basic_info: basicInfo } };
      case 'getChildDeviceList': {
        const start = params.childControl.start_index;
        return { child_device_list: children.slice(start, start + 10), start_index: start, sum: children.length };
      }
      case 'controlChild': {
        const { device_id, request_data } = params.childControl;
        const child = children.find((c) => c.device_id === device_id);
        Object.assign(child, request_data.params);
        return { response_data: { error_code: 0, result: {} } };
      }
      default:
        return {};
    }
  }

  return {
    state,
    async start(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return server.address().port;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
