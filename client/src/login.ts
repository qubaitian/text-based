// 登录页：用 EIP-6963 找出浏览器里装的所有钱包，点一个，签一段文字就登录。不上链，不花钱。
// 下面还有一个游客进入，不用钱包也能玩。
import { getAddress, stringToHex } from 'viem';
import { createSiweMessage } from 'viem/siwe';

type Provider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
type Wallet = { info: { uuid: string; name: string; icon: string }; provider: Provider };

export class LoginPage {
  private readonly wallets = new Map<string, Wallet>();
  private readonly root: HTMLElement;
  private status = '';
  private busy = false;

  /** nonce() 拿服务器最新发的 nonce；签完调 submit 把文字和签名交给服务器；点游客进入调 guest */
  constructor(
    parent: HTMLElement,
    private readonly nonce: () => string,
    private readonly submit: (message: string, signature: string) => void,
    private readonly guest: () => void,
  ) {
    document.title = '登录 · 团战';
    this.root = document.createElement('main');
    this.root.className = 'login';
    parent.appendChild(this.root);
    // 每个钱包收到 requestProvider 都会回一个 announceProvider
    window.addEventListener('eip6963:announceProvider', (e) => {
      const w = (e as CustomEvent<Wallet>).detail;
      this.wallets.set(w.info.uuid, w);
      this.render();
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    this.render();
  }

  remove() {
    this.root.remove();
  }

  /** 服务器说签名没对上 */
  failed() {
    this.busy = false;
    this.say('登录没成功，再试一次');
  }

  private say(text: string) {
    this.status = text;
    this.render();
  }

  private render() {
    const list = [...this.wallets.values()];
    this.root.innerHTML = `<h1>团战</h1>
      ${list.length ? '<p>选一个钱包登录</p>' : '<p>没找到浏览器钱包</p><a class="get" href="https://metamask.io/download/" target="_blank" rel="noreferrer">安装 MetaMask</a>'}
      <div class="wallets"></div>
      <p>或者</p>
      <button class="guest">游客进入</button>
      <p class="status">${this.status}</p>`;
    const guest = this.root.querySelector<HTMLButtonElement>('.guest')!;
    guest.disabled = this.busy;
    guest.addEventListener('click', () => {
      this.busy = true;
      this.say('正在进入');
      this.guest();
    });
    const box = this.root.querySelector('.wallets')!;
    for (const w of list) {
      const b = document.createElement('button');
      b.disabled = this.busy;
      const icon = document.createElement('img');
      icon.src = w.info.icon;
      icon.alt = '';
      b.append(icon, w.info.name);
      b.addEventListener('click', () => this.signIn(w.provider));
      box.appendChild(b);
    }
  }

  private async signIn(p: Provider) {
    this.busy = true;
    this.say('请在钱包里确认');
    try {
      const [account] = (await p.request({ method: 'eth_requestAccounts' })) as string[];
      const chainId = Number(await p.request({ method: 'eth_chainId' }));
      const message = createSiweMessage({
        domain: location.host,
        address: getAddress(account),
        statement: '登录团战',
        uri: location.origin,
        version: '1',
        chainId,
        nonce: this.nonce(),
        issuedAt: new Date(),
      });
      const signature = (await p.request({ method: 'personal_sign', params: [stringToHex(message), account] })) as string;
      this.say('正在登录');
      this.submit(message, signature);
    } catch {
      // 多半是在钱包里点了取消
      this.busy = false;
      this.say('没有签名，再试一次');
    }
  }
}
