// 规则：所有人站在一条数轴上，位置用米。玩家登录后控制徒弟，先进教学关（师傅、木桩）。
// 时间都用秒。走路是随着时间一点点走，中途能换目标，也会被打断；出招以后有冷却，冷却中不能走也不能出招。
// 玩家在线、冷却为 0、又没在走时，时间停下来等他；玩家不在线，时间不走。
// 地图上还有敌人就是战斗中；敌人都没了就是战斗外，没有冷却，点人就走到他身边说话。

export const TICK = 0.05; // 服务器每次推进多少秒
export const SPEED = 1; // 走路速度：米/秒，所有人一样
export const SP_PER_M = 1; // 每走 1 米扣多少脚力
export const SP_REGEN = 10; // 没在走的时候，每秒回多少脚力
export const TALK_REACH = 1; // 离人这么多米以内就能说话
export const START_SPREAD = 1.5; // 开局每人随机一个冷却，在 0 到这么多秒之间
export const NPC_WAIT = 1; // 师傅和木桩还不会行动，冷却到 0 时原地等这么久
export const FOE_GAP = 0.2; // 和敌人至少隔这么多米，走到这么近就自动停

/** 系统里的数都只留 6 位小数，免得小数越走越长 */
export const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** 师傅一句一句教。走起来以后说第二句，木桩打坏以后说第三句 */
export const LESSONS = ['点下面的数轴，走过去', '走到木桩 1 米以内，点「拳」打它', '过来和我聊聊'];
export const TEACHER = 'shifu'; // 谁在对话框里教

export type Side = 'friend' | 'foe';

export interface Unit {
  id: string;
  name: string;
  side: Side;
  player: boolean; // 是不是玩家控制的人
  x: number; // 在数轴上的位置（米）
  to: number | null; // 正在往哪里走，null 是站着
  cd: number; // 冷却：还要等几秒才能行动
  hp: number;
  maxHp: number;
  mp: number; // 内力
  maxMp: number;
  sp: number; // 脚力
  maxSp: number;
  buffs: string[]; // 状态名，比如“中毒”
}

export interface Board {
  id: string;
  units: Unit[];
  time: number; // 开局以来过了多少秒
  lesson: number; // 师傅教到第几句，是 LESSONS 的下标；等于 LESSONS.length 就是教完了
  talkTo: string | null; // 走到这个人身边就和他说话
  talking: string | null; // 正在和谁说话，页面据此弹出对话框
}

/** 对话框里的一段话：谁说的、说什么、下面有哪些选项 */
export interface Talk {
  who: string;
  text: string;
  options: { id: OptionId; text: string }[];
}
export type OptionId = 'close';

/** 武学：打离自己最近的、够得着的敌人 */
export interface Skill {
  id: SkillId;
  name: string;
  cd: number; // 用完加多少冷却
  reach: number; // 几米以内的敌人能打到
  power: number; // 扣多少血
}

export type SkillId = 'quan';

export const SKILLS: Record<SkillId, Skill> = {
  quan: { id: 'quan', name: '拳', cd: 1.5, reach: 1, power: 100 },
};

function unit(id: string, name: string, side: Side, player: boolean, x: number, hp = 1000): Unit {
  return {
    id, name, side, player, x,
    to: null,
    cd: 0,
    hp, maxHp: hp,
    mp: 100, maxMp: 100,
    sp: 100, maxSp: 100,
    buffs: [],
  };
}

/** 教学关：徒弟走 3 米就能打到木桩，木桩三下打坏 */
export function createTutorial(): Board {
  const units = [
    unit('tudi', '徒弟', 'friend', true, 0),
    unit(TEACHER, '师傅', 'friend', false, -2),
    unit('muzhuang', '木桩', 'foe', false, 4, 300),
  ];
  // 开局每人随机一个 0 到 1.5 秒的冷却，互相不一样，这样谁先谁后是随机的
  const used = new Set<number>();
  for (const u of units) {
    do u.cd = Math.round(Math.random() * START_SPREAD * 1000) / 1000;
    while (used.has(u.cd));
    used.add(u.cd);
  }
  return { id: Math.random().toString(36).slice(2), units, time: 0, lesson: 0, talkTo: null, talking: null };
}

export const unitOf = (b: Board) => b.units.find((u) => u.player);

export const dist = (a: Unit, b: Unit) => round(Math.abs(a.x - b.x));

/** 地图上还有敌人就是战斗中 */
export const inCombat = (b: Board) => b.units.some((u) => u.side === 'foe');

/** 时间停着等玩家：战斗中，玩家冷却为 0，又没在走 */
export function waiting(b: Board) {
  const u = unitOf(b);
  return !!u && inCombat(b) && u.cd === 0 && u.to === null;
}

/** 打断：被打中、或者状态变了，就停下脚步，也不再去找人说话 */
function interrupt(b: Board, u: Unit) {
  u.to = null;
  if (u.player) b.talkTo = null;
}

/** 扣血。打坏了就从地图上拿掉 */
function hurt(b: Board, v: Unit, power: number) {
  v.hp = Math.max(0, v.hp - power);
  interrupt(b, v);
  if (v.hp === 0) b.units = b.units.filter((w) => w !== v);
}

/** 点了数轴：往那里走。冷却中、在说话、脚力用完了，都不能走 */
export function move(b: Board, x: number): boolean {
  const u = unitOf(b);
  if (!u || !Number.isFinite(x) || u.cd > 0 || u.sp <= 0 || b.talking) return false;
  u.to = round(x);
  b.talkTo = null;
  if (b.lesson === 0 && inCombat(b)) b.lesson = 1;
  return true;
}

/** 这招现在能打谁：够得着的敌人里最近的一个。冷却不为 0 就谁都打不了 */
export function targetOf(b: Board, skill: SkillId): Unit | null {
  const u = unitOf(b), s = SKILLS[skill];
  if (!u || !s || u.cd > 0 || b.talking) return null;
  let best: Unit | null = null;
  for (const v of b.units) {
    if (v.side === u.side || dist(u, v) > s.reach) continue;
    if (!best || dist(u, v) < dist(u, best)) best = v;
  }
  return best;
}

/** 出招。出招就停下脚步。不合法就什么都不做，返回 false */
export function act(b: Board, skill: SkillId): boolean {
  const v = targetOf(b, skill);
  if (!v) return false;
  const u = unitOf(b)!, s = SKILLS[skill];
  u.to = null;
  hurt(b, v, s.power);
  u.cd = s.cd;
  // 教学：敌人都打完了就叫徒弟过去聊聊
  if (!inCombat(b)) b.lesson = 2;
  return true;
}

/** 这个人现在能说什么。战斗中谁都不说话 */
export function talkOf(b: Board, id: string): Talk | null {
  if (inCombat(b)) return null;
  if (id === TEACHER) return {
    who: '师傅',
    text: '木桩打得不错。走路、出招，山下的功夫就这两样，今天先教到这里。',
    options: [{ id: 'close', text: '好' }],
  };
  return null;
}

/** 师傅现在教的这句，在对话框里说，没有选项，不挡着玩。正在说话、或者教完了，就没有 */
export function lessonOf(b: Board): Talk | null {
  const text = LESSONS[b.lesson];
  if (!text || b.talking || !b.units.some((u) => u.id === TEACHER)) return null;
  return { who: '师傅', text, options: [] };
}

/** 对话框里点了选项。只认现在有的选项。和师傅聊完，教学就结束了 */
export function choose(b: Board, option: OptionId): boolean {
  const options = b.talking ? talkOf(b, b.talking)?.options ?? [] : [];
  if (!options.some((o) => o.id === option)) return false;
  if (b.talking === TEACHER && b.lesson === LESSONS.length - 1) b.lesson = LESSONS.length;
  b.talking = null;
  return true;
}

/** 战斗外点了人：够近就直接说话，不够近就先朝他走，走到 1 米以内再说 */
export function talk(b: Board, id: string): boolean {
  const u = unitOf(b), v = b.units.find((w) => w.id === id);
  if (!u || !v || v === u || !talkOf(b, id) || b.talking) return false;
  if (dist(u, v) <= TALK_REACH) {
    u.to = null;
    b.talking = id;
    return true;
  }
  u.to = v.x;
  b.talkTo = id;
  return true;
}

/** 推进时间。玩家不在线、或者在等玩家，就不动；否则所有人一起走路、减冷却 */
export function step(b: Board, dt: number, online: boolean) {
  if (!online) return;
  if (!inCombat(b)) for (const u of b.units) u.cd = 0;
  else {
    for (const u of b.units) if (!u.player && u.cd === 0) u.cd = NPC_WAIT;
    if (waiting(b)) return;
    // 最多只走到下一个人冷却到 0，这样开局排好的先后不会在同一下里挤在一起
    dt = Math.min(dt, ...b.units.map((u) => u.cd).filter((cd) => cd > 0));
  }
  for (const u of b.units) {
    walkStep(b, u, dt);
    u.cd = round(Math.max(0, u.cd - dt));
  }
  b.time = round(b.time + dt);
}

/** 走 dt 秒。脚力不够就少走；不能穿过敌人，离他 0.2 米就停；走到了要说话的人身边就开始说话 */
function walkStep(b: Board, u: Unit, dt: number) {
  if (u.to === null) {
    u.sp = round(Math.min(u.maxSp, u.sp + SP_REGEN * dt));
    return;
  }
  const dir = Math.sign(u.to - u.x);
  let next = round(u.x + dir * Math.min(SPEED * dt, Math.abs(u.to - u.x), u.sp / SP_PER_M));
  // 前面最近的敌人：停在离他 FOE_GAP 的地方。已经比这还近了（比如他走过来），就原地不动，不能再往前
  for (const v of b.units) {
    const stop = round(v.x - dir * FOE_GAP);
    if (v.side === u.side || dir * (v.x - u.x) <= 0 || dir * (next - stop) <= 0) continue;
    next = u.to = dir * (u.x - stop) > 0 ? u.x : stop;
  }
  u.sp = round(Math.max(0, u.sp - Math.abs(next - u.x) * SP_PER_M));
  u.x = next;
  if (u.x === u.to || u.sp === 0) u.to = null;
  const v = u.player && b.talkTo ? b.units.find((w) => w.id === b.talkTo) : null;
  if (v && dist(u, v) <= TALK_REACH) {
    u.to = null;
    b.talking = b.talkTo;
    b.talkTo = null;
  }
}
