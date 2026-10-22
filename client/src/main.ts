// 入口：先连服务器。浏览器里存着 token 就直接登录，没有就显示登录页（钱包或游客）。登录以后进教学关，大家站在一条数轴上。
import type { Board } from '../../shared/line.ts';
import { LineView } from './line/LineView';
import { LoginPage } from './login';

type ServerMsg =
  | { t: 'nonce'; nonce: string }
  | { t: 'login'; guest: boolean; address: string; token: string }
  | { t: 'fail'; nonce: string }
  | { t: 'state'; board: Board };

const TOKEN_KEY = 'tuanzhan.line.token';

// 浏览器存储可能用不了（比如隐私模式），用不了就每次都签
const storage = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* 不存也能玩 */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* 同上 */ } },
};

let ws: WebSocket;
let nonce = '';
let login: LoginPage | null = null;
let view: LineView | null = null;

const send = (msg: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function showLogin() {
  login ??= new LoginPage(
    document.body,
    () => nonce,
    (message, signature) => send({ t: 'siwe', message, signature }),
    () => send({ t: 'guest' }),
  );
}

/** 系统框里点了退出登录：服务器作废 token，这边回到登录页 */
function logout() {
  send({ t: 'logout' });
  storage.clear();
  view?.remove();
  view = null;
  showLogin();
}

function connect() {
  ws = new WebSocket(`ws://${location.hostname}:8788/`);
  ws.onopen = () => {
    // 正在登录页上签名时不用 token；否则有 token 就用（重连时也一样）
    const token = login ? null : storage.get();
    if (token) send({ t: 'token', token });
    else {
      view?.remove();
      view = null;
      showLogin();
    }
  };
  ws.onmessage = (e) => {
    const msg: ServerMsg = JSON.parse(e.data);
    if (msg.t === 'nonce') nonce = msg.nonce;
    else if (msg.t === 'login') {
      storage.set(msg.token);
      login?.remove();
      login = null;
      view ??= new LineView(document.body, msg.guest ? null : msg.address, send, logout);
    } else if (msg.t === 'fail') {
      // token 过期了、或者签名没对上：回到登录页
      nonce = msg.nonce;
      storage.clear();
      view?.remove();
      view = null;
      if (login) login.failed();
      else showLogin();
    } else if (msg.t === 'state') view?.update(msg.board);
  };
  // 被同一个账号的新页面顶掉（4000）就不再重连，其他情况每秒重连一次，重连后用 token 登录
  ws.onclose = (e) => {
    if (e.code !== 4000) setTimeout(connect, 1000);
  };
}

connect();
