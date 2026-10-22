// 换地图的动效（水墨）：墨从四周往中间晕开盖住上面的区域，换上新地图，中间写地名，墨再从中间散开。
// 从 game 的 fx.ts 搬过来，墨改成纯黑，地名改成白字。
const COVER = 900; // 盖住要几毫秒
const HOLD = 900; // 盖住以后，地名停留几毫秒
const OPEN = 900; // 打开要几毫秒

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 墨的毛边：用噪声把墨的边缘扭一扭，整页只放一份 */
function inkFilter() {
  if (document.getElementById('ink-edge')) return;
  document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute"><defs>
    <filter id="ink-edge" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="7"/>
      <feDisplacementMap in="SourceGraphic" scale="90"/>
    </filter></defs></svg>`);
}

/** 盖住 area → 调 swap 换上新地图 → 显示地名 → 打开。盖着的时候点不到下面 */
export async function changeMap(area: HTMLElement, place: string, swap: () => void) {
  inkFilter();
  const el = document.createElement('div');
  el.className = 'inkfx';
  // 毛边滤镜只加在墨上，不加在地名上，不然字也会被扭歪
  el.innerHTML = `<div class="ink"><div class="cover"></div></div><div class="place">${place}</div>`;
  area.appendChild(el);
  void el.offsetWidth; // 先让浏览器画出起始的样子，下面加 class 才会有过渡
  el.classList.add('shut');
  await wait(COVER);
  swap();
  el.classList.add('named');
  await wait(HOLD);
  el.classList.remove('named');
  await wait(300);
  el.classList.remove('shut');
  await wait(OPEN);
  el.remove();
}
