import './line.css';
import {
  SKILLS, inCombat, lessonOf, round, talkOf, targetOf, unitOf, waiting,
  type Board, type SkillId,
} from '../../../shared/line.ts';

// 每种状态是好是坏：坏的黑底白字，好的白底黑框
const KIND: Record<string, 'good' | 'bad'> = {
  中毒: 'bad', 流血: 'bad', 眩晕: 'bad', 封穴: 'bad', 残废: 'bad', 内伤: 'bad', 减速: 'bad', 定身: 'bad',
  护体: 'good', 铁甲: 'good', 狂暴: 'good', 醉酒: 'good', 加速: 'good', 疗伤: 'good',
};

const CD_FULL = 3; // 冷却条满格是几秒，超过的也画满
const ACTIONS: SkillId[] = ['quan'];

// ---- 数轴的尺寸（像素） ----
const PAD = 28; // 数轴两头留的空
const MARGIN = 1.5; // 最外面的人再往外多画几米，好点到外面去
const MIN_HALF = 3; // 数轴至少画到原点两边各几米
const LABEL_H = 26; // 一个名字框的高
const ROW_H = 34; // 名字框一层的高（名字挤在一起时往上叠）
const ARROW = 22; // 最下面一层名字框到数轴的箭头长
const BELOW = 60; // 数轴下面写刻度和目标坐标的地方

const meters = (n: number) => `${n.toFixed(2)} 米`;

/** 钱包地址太长，只留头尾：0x12ab…9f3c */
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** 名字框的宽：每个字 15 像素，两边各留 8 */
const labelW = (name: string) => name.length * 15 + 16;

/** 两个刻度之间隔几米：让两个刻度之间至少有 56 像素 */
function tickStep(scale: number) {
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]) if (s * scale >= 56) return s;
  return 200;
}

/** 游戏页面。联网在 main.ts，这里只管画和点。上面一排卡片，下面一条数轴 */
export class LineView {
  private board: Board | null = null;
  private hover: number | null = null; // 鼠标在数轴上指着哪里，是离原点几米，已经对到 0.1
  private cardKey = ''; // 上次排卡片时有哪些人，没变就只改数字，免得点卡片时卡片被换掉
  private talkKey = ''; // 上次画对话框时的内容，没变就不重画
  private origin = 0; // 原点在系统里的位置：永远是自己站的地方
  private center = 0; // 屏幕中间在系统里的位置：最左和最右两个人的中点
  private scale = 1; // 一米多少像素
  private width = 0; // 数轴区域的宽
  private readonly root: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly status: HTMLElement;
  private readonly axis: HTMLElement;
  private readonly buttons = new Map<SkillId, HTMLButtonElement>();

  constructor(
    parent: HTMLElement,
    private readonly address: string | null, // 登录的钱包地址，游客是 null
    private readonly send: (msg: object) => void,
    private readonly logout: () => void,
  ) {
    document.title = '团战';
    this.root = document.createElement('div');
    this.root.className = 'linepage';
    this.root.innerHTML = `
      <div class="cards"></div>
      <div class="status"></div>
      <div class="axis"></div>
      <div class="actions"></div>
      <div class="talk" hidden></div>
      <div class="sysmask" hidden><div class="sysbox">
        <h2>系统</h2>
        <p class="who">${address ? `钱包 ${short(address)}` : '游客'}</p>
        <button data-do="restart">重新开始</button>
        <button data-do="logout">退出登录</button>
        <button data-do="close">返回游戏</button>
      </div></div>`;
    parent.appendChild(this.root);
    this.cards = this.root.querySelector('.cards')!;
    this.status = this.root.querySelector('.status')!;
    this.axis = this.root.querySelector('.axis')!;

    // 动作栏：点武学就打够得着的最近的敌人
    const bar = this.root.querySelector('.actions')!;
    for (const id of ACTIONS) {
      const b = document.createElement('button');
      b.textContent = SKILLS[id].name;
      b.title = `${SKILLS[id].reach} 米以内，冷却 ${SKILLS[id].cd}s`;
      b.addEventListener('click', () => this.send({ t: 'act', skill: id }));
      bar.appendChild(b);
      this.buttons.set(id, b);
    }
    // 系统按钮：和玩法无关的功能都在这里面
    const sys = document.createElement('button');
    sys.className = 'system';
    sys.textContent = '系统';
    sys.addEventListener('click', () => this.toggleSystem(true));
    bar.appendChild(sys);

    this.bindSystem();
    this.bindTalk();
    this.bindAxis();
    // 战斗外点能说话的人的卡片：走过去说话
    this.cards.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-card]')?.dataset.card;
      if (id) this.talkTo(id);
    });
    new ResizeObserver(() => this.render()).observe(this.axis);
  }

  /** 服务器发来新的数轴 */
  update(board: Board) {
    this.board = board;
    this.render();
  }

  remove() {
    this.root.remove();
    window.removeEventListener('keydown', this.onKey);
  }

  private talkTo(id: string) {
    const b = this.board;
    if (b && talkOf(b, id)) this.send({ t: 'talk', who: id });
  }

  /** 现在点数轴能不能走：冷却为 0、还有脚力、没在说话 */
  private canMove() {
    const b = this.board, u = b && unitOf(b);
    return !!u && u.cd === 0 && u.sp > 0 && !b.talking;
  }

  private render() {
    const b = this.board;
    if (!b) return;
    this.renderCards(b);
    this.renderStatus(b);
    this.renderAxis(b);
    const fight = inCombat(b);
    for (const [id, btn] of this.buttons) {
      btn.hidden = !fight;
      btn.disabled = !targetOf(b, id);
    }
    this.renderTalk(b);
  }

  // ---- 上面的卡片：居中，从左到右和数轴上的顺序一样 ----

  private renderCards(b: Board) {
    const me = unitOf(b);
    const list = [...b.units].sort((p, q) => p.x - q.x);
    const key = list.map((u) => u.id).join(',');
    if (key !== this.cardKey) {
      this.cardKey = key;
      this.cards.innerHTML = list.map((u) => `<div class="card ${u.side}${u === me ? ' mine' : ''}" data-card="${u.id}">
        <div class="head"><span class="name">${u.name}</span><span class="dist"></span></div>
        ${u.player ? `<div class="addr">${this.address ? short(this.address) : '游客'}</div>` : ''}
        ${(['hp', 'mp', 'sp', 'cd'] as const).map((k) => `<div class="row" data-k="${k}">
          <span>${{ hp: '血', mp: '内力', sp: '脚力', cd: '冷却' }[k]}</span><div class="bar"><i></i></div><span class="num"></span></div>`).join('')}
        <div class="buffs"></div>
      </div>`).join('');
    }
    for (const u of list) {
      const card = this.cards.querySelector<HTMLElement>(`[data-card="${u.id}"]`)!;
      card.querySelector('.dist')!.textContent = u === me ? '自己' : me ? meters(round(Math.abs(u.x - me.x))) : '';
      const set = (k: string, f: number, text: string) => {
        const row = card.querySelector(`[data-k="${k}"]`)!;
        row.querySelector<HTMLElement>('i')!.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
        row.querySelector('.num')!.textContent = text;
      };
      set('hp', u.hp / u.maxHp, `${Math.round(u.hp)}/${u.maxHp}`);
      set('mp', u.mp / u.maxMp, `${Math.round(u.mp)}/${u.maxMp}`);
      set('sp', u.sp / u.maxSp, `${u.sp.toFixed(2)}/${u.maxSp}`);
      set('cd', u.cd / CD_FULL, `${u.cd.toFixed(2)}s`);
      const buffs = u.buffs.map((k) => `<span class="${KIND[k] ?? 'bad'}">${k}</span>`).join('');
      const el = card.querySelector<HTMLElement>('.buffs')!;
      if (el.innerHTML !== buffs) el.innerHTML = buffs;
      card.classList.toggle('talker', !!talkOf(b, u.id) && !b.talking);
    }
  }

  /** 数轴上面一行：过了多少时间，现在在干什么 */
  private renderStatus(b: Board) {
    const u = unitOf(b);
    if (!inCombat(b)) {
      this.status.textContent = b.talking ? '战斗外 · 说话中' : '战斗外 · 点数轴走路，点人的卡片过去说话';
      return;
    }
    const doing = !u ? '' : waiting(b) ? '等你出手' : u.cd > 0 ? '冷却中' : u.to !== null ? '走路中' : '';
    this.status.textContent = `时间 ${b.time.toFixed(2)}s · ${doing}`;
  }

  // ---- 下面的数轴：名字加箭头指着位置。自己永远是原点，屏幕中间是最左和最右两个人的中点 ----

  private renderAxis(b: Board) {
    const xs = b.units.map((u) => u.x);
    if (!xs.length) {
      this.axis.innerHTML = '';
      return;
    }
    const me = unitOf(b);
    this.center = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.origin = me ? me.x : this.center;
    // 要放进来的点：所有人，还有自己正要走去的地方。half 是屏幕中间到一头有几米
    const far = Math.max(...xs.map((x) => Math.abs(x - this.center)), me?.to != null ? Math.abs(me.to - this.center) : 0);
    const half = Math.max(MIN_HALF, far + MARGIN);
    this.width = this.axis.clientWidth;
    const W = this.width;
    this.scale = (W - 2 * PAD) / (2 * half);
    // 离原点 r 米的地方在屏幕上的横坐标
    const px = (r: number) => W / 2 + (this.origin + r - this.center) * this.scale;
    const rel = (x: number) => x - this.origin;

    // 名字框按位置从左到右排，和左边的挤在一起就往上放一层
    const ends: number[] = []; // 每一层最右边的名字框到哪里了
    const labels = [...b.units].sort((p, q) => p.x - q.x).map((u) => {
      const w = labelW(u.name);
      const at = px(rel(u.x));
      const left = Math.max(0, Math.min(W - w, at - w / 2));
      let level = ends.findIndex((end) => end + 6 <= left);
      if (level < 0) level = ends.push(0) - 1;
      ends[level] = left + w;
      return { u, w, at, left, level };
    });
    const levels = Math.max(1, ends.length);
    const y0 = (levels - 1) * ROW_H + LABEL_H + ARROW; // 数轴的高度
    const H = y0 + BELOW;

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <defs><marker id="tip" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="#000"/></marker></defs>
      <line class="axisline" x1="${PAD / 2}" y1="${y0}" x2="${W - PAD / 2}" y2="${y0}" marker-end="url(#tip)" marker-start="url(#tip)"/>`;

    // 刻度：每 step 米一个长刻度写数字；一米够宽时，每 0.1 米一个短刻度。数字都是离自己的距离，左边也不写负号
    const step = tickStep(this.scale);
    // 屏幕两头离原点几米
    const lo = this.center - half - this.origin, hi = this.center + half - this.origin;
    if (this.scale * 0.1 >= 6) for (let k = Math.ceil(lo * 10); k <= hi * 10; k++)
      svg += `<line class="minor" x1="${px(k / 10)}" y1="${y0}" x2="${px(k / 10)}" y2="${y0 + 4}"/>`;
    for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
      const r = round(k * step);
      const text = step < 1 ? Math.abs(r).toFixed(1) : String(Math.abs(r));
      svg += `<line class="major${r === 0 ? ' zero' : ''}" x1="${px(r)}" y1="${y0 - (r === 0 ? 6 : 0)}" x2="${px(r)}" y2="${y0 + 8}"/>
        <text class="tick${r === 0 ? ' zero' : ''}" x="${px(r)}" y="${y0 + 24}">${text}</text>`;
    }
    // 单位写在右头箭头的上面，免得和最右边的刻度数字挤在一起
    svg += `<text class="unit" x="${W - PAD / 2}" y="${y0 - 10}">米</text>`;

    // 自己正要走去的地方：数轴上一个空心三角，从自己画一条虚线过去，刻度下面写还要走几米，边走边变小
    if (me && me.to !== null) {
      const a = px(rel(me.x)), t = px(rel(me.to));
      svg += `<line class="route" x1="${a}" y1="${y0 - 5}" x2="${t}" y2="${y0 - 5}"/>
        <path class="goal" d="M${t} ${y0 + 2} l-6 10 h12 z"/>
        <text class="goaltext" x="${t}" y="${y0 + 46}">目标 ${Math.abs(rel(me.to)).toFixed(2)} 米</text>`;
    }

    // 鼠标指着的地方：一条竖虚线，上面写离自己几米。走路时把它清掉：自己在动，鼠标没动，这个数马上就不对了。
    // 停下以后也不画，等鼠标再动一下才画
    if (me?.to != null) this.hover = null;
    if (this.hover !== null && this.hover >= lo && this.hover <= hi) {
      const h = px(this.hover);
      svg += `<g class="ghost${this.canMove() ? '' : ' off'}"><line x1="${h}" y1="${y0 - ARROW}" x2="${h}" y2="${y0 + 8}"/>
        <text x="${h}" y="${y0 - ARROW - 4}">${Math.abs(this.hover).toFixed(1)} 米</text></g>`;
    }

    // 名字框和箭头：框底到数轴的箭头，叠在上层的箭头长一些。先画全部箭头，再画框，箭头穿过下层时被框盖住
    const top = (level: number) => y0 - ARROW - LABEL_H - level * ROW_H;
    for (const { at, level } of labels)
      svg += `<line class="arrow" x1="${at}" y1="${top(level) + LABEL_H}" x2="${at}" y2="${y0 - 1}" marker-end="url(#tip)"/>`;
    for (const { u, w, left, level } of labels) {
      const cls = ['label', u.side, u === me ? 'mine' : '', talkOf(b, u.id) && !b.talking ? 'talker' : ''].join(' ');
      svg += `<g class="${cls}" data-id="${u.id}">
        <rect x="${left}" y="${top(level)}" width="${w}" height="${LABEL_H}"/>
        <text x="${left + w / 2}" y="${top(level) + LABEL_H / 2 + 5}">${u.name}</text>
      </g>`;
    }
    this.axis.innerHTML = svg + '</svg>';
  }

  /** 数轴上：移动鼠标显示指着的位置；点名字框去说话；点别的地方就走过去，点到 0.1 米 */
  private bindAxis() {
    const at = (e: MouseEvent) => {
      const box = this.axis.getBoundingClientRect();
      const r = this.center - this.origin + (e.clientX - box.left - this.width / 2) / this.scale;
      return round(Math.round(r * 10) / 10);
    };
    this.axis.addEventListener('mousemove', (e) => {
      this.hover = at(e);
      this.render();
    });
    this.axis.addEventListener('mouseleave', () => {
      this.hover = null;
      this.render();
    });
    // 用按下而不是 click：数轴每 tick 都重画，按下和松开时手下的元素已经换了，click 就认不出点的是谁
    this.axis.addEventListener('pointerdown', (e) => {
      const id = (e.target as Element).closest<SVGElement>('[data-id]')?.dataset.id;
      const b = this.board;
      if (id && b && talkOf(b, id)) return this.talkTo(id);
      if (this.canMove()) this.send({ t: 'move', x: round(this.origin + at(e)) });
    });
  }

  // ---- 系统框：屏幕中间弹出，后面的游戏变暗。点框外面或按 Esc 关上 ----

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.toggleSystem(false);
  };

  private bindSystem() {
    const mask = this.root.querySelector<HTMLElement>('.sysmask')!;
    mask.addEventListener('click', (e) => {
      const what = (e.target as HTMLElement).closest<HTMLElement>('[data-do]')?.dataset.do;
      if (what === 'restart') this.send({ t: 'reset' });
      if (what === 'logout') return this.logout();
      // 点了按钮，或者点在框外面，都关上
      if (what || e.target === mask) this.toggleSystem(false);
    });
    window.addEventListener('keydown', this.onKey);
  }

  private toggleSystem(open: boolean) {
    this.root.querySelector<HTMLElement>('.sysmask')!.hidden = !open;
  }

  // ---- 对话框：所有说的话都在这里。正在说话时在屏幕下方，盖住动作栏，点选项就告诉服务器；
  //      师傅教的话没有选项，放在动作栏上面，不挡着玩 ----

  private bindTalk() {
    this.root.querySelector('.talk')!.addEventListener('click', (e) => {
      const option = (e.target as HTMLElement).closest<HTMLElement>('[data-option]')?.dataset.option;
      if (option) this.send({ t: 'choose', option });
    });
  }

  private renderTalk(b: Board) {
    const talk = b.talking ? talkOf(b, b.talking) : lessonOf(b);
    const key = talk ? JSON.stringify(talk) : '';
    if (key === this.talkKey) return;
    this.talkKey = key;
    const el = this.root.querySelector<HTMLElement>('.talk')!;
    el.hidden = !talk;
    if (!talk) return;
    el.classList.toggle('hint', !talk.options.length);
    el.innerHTML = `<div class="who">${talk.who}</div>
      <div class="said">${talk.text}</div>
      <div class="options">${talk.options.map((o) => `<button data-option="${o.id}">${o.text}</button>`).join('')}</div>`;
  }
}
