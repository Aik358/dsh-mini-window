/**
 * 悬浮球交互
 *
 * 关键设计：位移判定用「屏幕光标坐标」而不是 renderer 内坐标。
 * 原因：球本身在被拖动时窗口位置一直在变，renderer 里的 clientX 会
 *      随窗口一起漂移，用它算位移会得到恒定的抖动值，判定必然失真。
 */
'use strict';

const ball = document.getElementById('ball');
const dot = document.getElementById('dot');

const DRAG_THRESHOLD = 4; // px：小于此位移视为点击
let pressed = false;
let moved = false;
let startPoint = null;

function pointOf(e) {
  // screenX/screenY 是屏幕坐标，跨窗口移动时依然单调，适合判定位移
  return { x: e.screenX, y: e.screenY };
}

ball.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  pressed = true;
  moved = false;
  startPoint = pointOf(e);
  ball.setPointerCapture(e.pointerId);
  ball.classList.add('dragging');
  window.companion.ball.dragStart();
});

ball.addEventListener('pointermove', (e) => {
  if (!pressed) return;
  const p = pointOf(e);
  const dist = Math.hypot(p.x - startPoint.x, p.y - startPoint.y);
  if (!moved && dist < DRAG_THRESHOLD) return;
  moved = true;
  window.companion.ball.dragMove();
});

ball.addEventListener('pointerup', async (e) => {
  if (!pressed) return;
  pressed = false;
  ball.classList.remove('dragging');
  try { ball.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }

  if (moved) {
    window.companion.ball.dragEnd();
  } else {
    window.companion.ball.click();
  }
});

ball.addEventListener('pointercancel', () => {
  if (!pressed) return;
  pressed = false;
  ball.classList.remove('dragging');
  if (moved) window.companion.ball.dragEnd();
});

// 双击：等价于"回到主界面"
ball.addEventListener('dblclick', () => {
  window.companion.showMain();
});

// 右键：不再另做菜单（托盘已有），仅在未配对时提示
ball.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  refreshStatus();
});

/** 状态点：认证失效时亮起，提示需要从 DSH 里重新取一次交接链接。 */
async function refreshStatus() {
  try {
    const r = await window.companion.probe();
    if (r.authed) {
      dot.classList.add('on', 'ok');
      dot.title = '已连接';
    } else {
      dot.classList.add('on');
      dot.classList.remove('ok');
      dot.title = '未连接：请在 DSH 中打开小窗以完成握手';
    }
  } catch {
    dot.classList.add('on');
    dot.classList.remove('ok');
  }
}

refreshStatus();
setInterval(refreshStatus, 30000);
