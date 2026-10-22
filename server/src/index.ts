// 教学关服务器：玩家用钱包签名登录（SIWE），或者当游客。每个账号一条自己的数轴。服务器跑规则，每 tick 把数轴发给在线的玩家。
import { randomBytes } from 'node:crypto';
import { verifyMessage, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  SKILLS, TICK, act, choose, createTutorial, move, step, talk,
  type Board, type OptionId, type SkillId,
} from '../../shared/line.ts';

const PORT = Number(process.env.PORT ?? 8788);
const TOKEN_LIFE = 7 * 24 * 3600 * 1000; // token 管 7 天，这期间刷新页面不用再签
// 只认这些域名上的页面。别的网站能让人签它自己的域名，再转发过来冒充登录，所以不能拿 Origin 直接比
const DOMAINS = (process.env.DOMAINS ?? 'localhost:5174,127.0.0.1:5174').split(',');

// 用系统的安全随机数。viem 的 generateSiweNonce 用 Math.random，而且下一个能从上一个猜出来
const newNonce = () => randomBytes(16).toString('hex');

// 游客的账号名用这个开头，钱包地址都是 0x 开头，不会撞上
const GUEST = 'guest:';

// 没登录时只认 token、siwe、guest；登录以后才认 move、act、talk、choose、reset、logout
type ClientMsg =
  | { t: 'token'; token: string }
  | { t: 'siwe'; message: string; signature: Hex }
  | { t: 'guest' }
  | { t: 'move'; x: number }
  | { t: 'act'; skill: SkillId }
  | { t: 'talk'; who: string }
  | { t: 'choose'; option: OptionId }
  | { t: 'reset' }
  | { t: 'logout' };

interface Account {
  board: Board;
  ws: WebSocket | null; // 这个账号现在连着的页面
}

// 都存在内存里，服务器重启就没了，要重新签
const accounts = new Map<string, Account>(); // 钱包地址或游客名 → 账号
const tokens = new Map<string, { address: string; until: number }>();

const send = (ws: WebSocket, msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

/** 签名对上了就返回地址。要求：域名是打开页面的域名，nonce 是这条连接发出去的，没过期 */
async function checkSiwe(message: string, signature: Hex, domain: string, nonce: string) {
  const fields = parseSiweMessage(message);
  if (!fields.address || !validateSiweMessage({ message: fields, domain, nonce })) return null;
  const ok = await verifyMessage({ address: fields.address, message, signature }).catch(() => false);
  return ok ? fields.address : null;
}

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
  // 浏览器连 WebSocket 时会带上页面的 Origin，要在名单里，签名文字里的域名也要和它对上
  const host = req.headers.origin ? URL.parse(req.headers.origin)?.host ?? '' : '';
  const domain = DOMAINS.includes(host) ? host : '';
  let nonce = newNonce();
  let address: string | null = null; // 登录后是钱包地址或游客名
  let token: string | null = null;
  send(ws, { t: 'nonce', nonce });

  const login = (addr: string, tok: string) => {
    address = addr;
    token = tok;
    let acc = accounts.get(addr);
    if (!acc) accounts.set(addr, (acc = { board: createTutorial(), ws: null }));
    // 同一个账号再连进来，就顶掉旧的。4000 告诉旧页面别自动重连
    acc.ws?.close(4000, 'replaced');
    acc.ws = ws;
    const guest = addr.startsWith(GUEST);
    send(ws, { t: 'login', guest, address: guest ? '' : addr, token: tok });
    console.log(`${addr} 已登录`);
  };

  // 发一个新 token 再登录：签名对上了，或者点了游客进入
  const issue = (addr: string) => {
    const tok = randomBytes(32).toString('hex');
    tokens.set(tok, { address: addr, until: Date.now() + TOKEN_LIFE });
    login(addr, tok);
  };

  // 登录失败：换一个新 nonce，让页面可以再签一次
  const fail = () => {
    nonce = newNonce();
    send(ws, { t: 'fail', nonce });
  };

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!address) {
      if (msg.t === 'token') {
        const s = tokens.get(String(msg.token));
        if (s && s.until > Date.now()) login(s.address, msg.token);
        else fail();
      } else if (msg.t === 'siwe') {
        // nonce 只能用一次：先作废，再验签
        const used = nonce;
        nonce = '';
        const addr = domain && used ? await checkSiwe(String(msg.message), msg.signature, domain, used).catch(() => null) : null;
        if (!addr) return fail();
        issue(addr);
      } else if (msg.t === 'guest') issue(GUEST + randomBytes(8).toString('hex'));
      return;
    }

    const acc = accounts.get(address)!;
    const b = acc.board;
    if (msg.t === 'move') move(b, Number(msg.x));
    else if (msg.t === 'act' && Object.hasOwn(SKILLS, msg.skill)) act(b, msg.skill);
    else if (msg.t === 'talk') talk(b, String(msg.who));
    else if (msg.t === 'choose') choose(b, msg.option);
    else if (msg.t === 'reset') acc.board = createTutorial();
    else if (msg.t === 'logout') {
      // 作废 token，连接还留着，回到没登录的样子。游客退出后再也登不回去，账号直接删掉
      if (token) tokens.delete(token);
      acc.ws = null;
      if (address.startsWith(GUEST)) accounts.delete(address);
      console.log(`${address} 已退出`);
      address = null;
      token = null;
      nonce = newNonce();
      send(ws, { t: 'nonce', nonce });
    }
  });

  ws.on('close', () => {
    const acc = address && accounts.get(address);
    if (acc && acc.ws === ws) {
      acc.ws = null;
      console.log(`${address} 已断开`);
    }
  });
});

setInterval(() => {
  for (const acc of accounts.values()) {
    step(acc.board, TICK, !!acc.ws);
    if (acc.ws) send(acc.ws, { t: 'state', board: acc.board });
  }
}, TICK * 1000);

console.log(`团战服务器 ws://localhost:${PORT}`);
