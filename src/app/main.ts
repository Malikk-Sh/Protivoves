import '@fontsource-variable/golos-text';
import '@fontsource-variable/oswald';
import '../ui/game.css';
import RAPIER from '@dimforge/rapier3d-compat';
import { DIFFICULTIES, MISSIONS, MISSION_ORDER, WEAPONS } from '../content/campaign.ts';
import type { DifficultyId, MissionId, WeaponId } from '../content/campaign.ts';
import { STEP } from '../content/dry-dock.ts';
import { DockAudio } from '../engine/audio.ts';
import { DockView } from '../engine/dock-view.ts';
import { BrowserInput } from '../engine/input.ts';
import { DryDock } from '../game/dry-dock.ts';
import type { DrillPose, HitEvent, RunMode, RunOptions } from '../game/dry-dock.ts';
import { CampaignSave, canPlay, finishMission, hasTessak, newProfile, nextMission } from '../save/campaign-save.ts';
import { shell, tips } from '../ui/shell.ts';

type Screen = 'loading' | 'menu' | 'campaign' | 'prepare' | 'intro' | 'duel' | 'drill' |
  'pause' | 'leave' | 'controls' | 'result' | 'error';

function element<T extends HTMLElement = HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: ${id}`);
  return node as T;
}

function displayNumber(value: number, digits: number) {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const app = element('app');
app.innerHTML = shell;
const canvas = element<HTMLCanvasElement>('dock');
const inputSurface = element('battle-input');
const input = new BrowserInput(inputSurface, element('stick'), element('stick-knob'));
const hud = element('hud');
const hint = element('coaching');
const drills = element('drill-options');
const feedback = element('hit-feedback');
const diagnostics = element('diagnostics');
const sound = element<HTMLInputElement>('sound');
const weaponSelect = element<HTMLSelectElement>('weapon');
const difficultySelect = element<HTMLSelectElement>('difficulty');
const motion = element<HTMLInputElement>('motion');
const audio = new DockAudio();
const debugEnabled = import.meta.env.DEV && new URLSearchParams(location.search).has('debug');
motion.checked = matchMedia('(prefers-reduced-motion: reduce)').matches;
let noticeTimer = 0;
const save = new CampaignSave(message => {
  const node = element('save-message');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { node.hidden = true; }, 5600);
});
let profile = newProfile();
let selectedMission: MissionId = 'M01';
let introUsed = false;
let introUntil = 0;

let view: DockView | null = null;
let run: DryDock | null = null;
let screen: Screen = 'loading';
let controlsFrom: 'menu' | 'pause' = 'menu';
let controlsTrigger: HTMLElement | null = null;
let contextLost = false;
let setupError = true;
let currentHint = -1;
let feedbackUntil = 0;
let accumulator = 0;
let lastFrame = performance.now();
let sceneTime = 0;
let aftermath = 0;
let repaint = true;

function simulate() {
  return screen === 'duel' || screen === 'drill';
}

function setScreen(next: Screen, focus?: string) {
  screen = next;
  repaint = true;
  app.dataset.screen = next;
  for (const panel of app.querySelectorAll<HTMLElement>('[data-screen]')) {
    panel.hidden = panel.dataset.screen !== next;
  }
  const playing = simulate();
  const showBattle = playing || next === 'pause' || next === 'leave' || (next === 'controls' && controlsFrom === 'pause');
  hud.hidden = !showBattle;
  hud.inert = !playing;
  inputSurface.hidden = next !== 'duel';
  drills.hidden = next !== 'drill';
  hint.hidden = next !== 'duel' || run?.mission.id !== 'M01' || currentHint < 0 || currentHint >= tips.length;
  feedback.hidden = true;
  input.setActive(next === 'duel');
  run?.clearInput();
  accumulator = 0;
  if (focus) app.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
}

function newRun(mode: RunMode, stance: DrillPose = 'planted', options: RunOptions = {}, intro = false) {
  const launchFocus = run !== null;
  run?.dispose();
  run = new DryDock(mode, stance, options);
  currentHint = -1;
  feedbackUntil = 0;
  aftermath = 0;
  if (mode === 'drill') {
    text('drill-result', 'Куда уйдёт вес сторожа?');
    text('drill-measurement', 'Один боковой удар · две постановки стоп');
    drills.querySelectorAll('[aria-pressed]').forEach(button => {
      button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.action === stance));
    });
  }
  if (mode === 'preview') updateMenu();
  if (intro) {
    introUntil = sceneTime + 3.8;
    audio.briefing();
  }
  setScreen(intro ? 'intro' : mode === 'preview' ? 'menu' : mode);
  updateHud();
  if (mode === 'preview' && launchFocus) app.querySelector<HTMLElement>('[data-action="start"]')?.focus({ preventScroll: true });
  if (intro) app.querySelector<HTMLElement>('[data-action="skip"]')?.focus({ preventScroll: true });
  else if (mode === 'duel') element('pause').focus({ preventScroll: true });
  if (mode === 'drill') drills.querySelector<HTMLElement>(`[data-action="${stance}"]`)?.focus({ preventScroll: true });
}

function text(id: string, value: string) {
  const node = element(id);
  if (node.textContent !== value) node.textContent = value;
}

function progress(id: string, value: number) {
  const node = element<HTMLProgressElement>(id);
  if (node.value !== value) node.value = value;
}

function updateMenu() {
  const next = nextMission(profile);
  text('menu-start', !next ? 'Карта главы' : next === 'M01' ? 'Начать дуэль' : 'Продолжить');
  text('menu-mission', next ? MISSIONS[next].title : 'Нижние доки');
}

function openCampaign() {
  if (run?.mode !== 'preview') newRun('preview');
  const list = element('mission-list');
  list.replaceChildren();
  for (const [index, id] of MISSION_ORDER.entries()) {
    const mission = MISSIONS[id];
    const completion = profile.completed[id];
    const available = canPlay(profile, id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'button secondary mission-row';
    row.dataset.action = 'mission';
    row.dataset.mission = id;
    row.disabled = !available;
    const title = document.createElement('strong');
    title.textContent = mission.title;
    const subtitle = document.createElement('span');
    subtitle.className = 'mission-note';
    subtitle.textContent = completion ? DIFFICULTIES[completion.difficulty].title
      : available ? mission.objective : `После миссии «${MISSIONS[MISSION_ORDER[index - 1]].title}»`;
    row.append(title, subtitle);
    if (completion) {
      const stars = document.createElement('small');
      stars.textContent = completion.stars.map(earned => earned ? '★' : '☆').join('');
      stars.setAttribute('aria-label', `Звёзд ${completion.stars.filter(Boolean).length} из 3`);
      row.append(stars);
    }
    list.append(row);
  }
  setScreen('campaign', `[data-mission="${nextMission(profile) ?? 'M04'}"]`);
}

function prepare(id: MissionId) {
  if (!canPlay(profile, id)) return;
  selectedMission = id;
  const mission = MISSIONS[id];
  text('prepare-title', mission.title);
  text('prepare-summary', mission.summary);
  weaponSelect.options[1].disabled = !hasTessak(profile);
  weaponSelect.options[1].textContent = hasTessak(profile) ? 'Короткий тесак' : 'Короткий тесак · после М04';
  weaponSelect.value = profile.weapon;
  difficultySelect.value = profile.difficulty;
  text('weapon-description', WEAPONS[profile.weapon].description);
  const goals = element('prepare-stars');
  goals.replaceChildren();
  for (const star of mission.stars) {
    const item = document.createElement('li');
    item.className = 'unearned';
    item.textContent = star;
    goals.append(item);
  }
  setScreen('prepare', '[data-action="launch"]');
}

function launch(id: MissionId) {
  if (!canPlay(profile, id)) return;
  const intro = id === 'M01' && !introUsed && !profile.completed.M01;
  introUsed = introUsed || intro;
  newRun('duel', 'planted', { mission: id, weapon: profile.weapon, difficulty: profile.difficulty }, intro);
}

function finishIntro() {
  if (screen === 'intro') setScreen('duel', '#pause');
}

function replay() {
  if (!run) return;
  newRun(run.mode, run.drillPose, { mission: run.mission.id, weapon: run.weapon, difficulty: run.difficulty });
}

function updateHud() {
  if (!run || run.mode === 'preview') return;
  const duel = run.mode === 'duel';
  const zone = duel && run.mission.boarding;
  const enemy = run.focusEnemy;
  text('chapter', duel ? run.mission.title : 'Тренировка опоры');
  const initial = zone ? 'Дойди до зоны посадки' : 'Дойди до боевой зоны';
  const goal = run.gateOpen ? 'Пройди через ворота'
    : run.bossTransitionStart !== null ? 'Экраны складываются'
    : run.awake ? run.mission.objective : initial;
  text('objective', duel ? goal : run.drillPose === 'planted' ? 'Две опорные стопы' : 'Одна опорная стопа');
  text('player-hp', String(run.player.hp));
  progress('player-health', run.player.hp);
  element('enemy-health').hidden = !run.awake || !enemy;
  if (enemy) {
    text('enemy-name', enemy.spec.name ?? 'Противник');
    text('enemy-hp', String(enemy.hp));
    element<HTMLProgressElement>('enemy-bar').max = enemy.spec.hp;
    progress('enemy-bar', enemy.hp);
  }
  element('boss-mark').hidden = enemy?.spec.id !== 'B1' || run.bossPhase === 2;
  element('boarding').hidden = !zone || !run.awake;
  if (zone && run.awake) {
    const seconds = Math.floor(run.boardingTicks * STEP);
    const intrusion = run.intrusionTicks * STEP;
    element<HTMLProgressElement>('boarding-bar').max = zone.cleanSeconds;
    progress('boarding-bar', run.boardingTicks * STEP);
    text('boarding-time', `${seconds} / ${zone.cleanSeconds} с`);
    element('intrusion').hidden = intrusion < 1;
    text('intrusion-time', `${Math.floor(intrusion)} / ${zone.intrusionSeconds} с`);
  }
  if (currentHint !== run.hint) {
    currentHint = run.hint;
    const tip = duel && run.mission.id === 'M01' ? tips[currentHint] : undefined;
    if (tip) {
      text('tip-title', tip[0]);
      text('tip-detail', tip[1]);
    }
    hint.hidden = screen !== 'duel' || !tip;
  }
}

function handleHit(hit: HitEvent) {
  view?.impact(hit);
  audio.impact(hit.result);
  if (screen === 'drill' && hit.hpDamage > 0) {
    text('drill-result', hit.result === 'down' ? 'Сторож потерял опору' : 'Сторож сделал шаг восстановления');
    text('drill-measurement',
      `${displayNumber(hit.s, 1)} м/с · P ${displayNumber(hit.balanceForce, 2)} · ${hit.hpDamage} урона`);
  } else if (screen === 'duel') {
    const boss = run?.mission.id === 'M04';
    const message = hit.result === 'parry' ? 'Парирование'
      : hit.surface === 'shield' && hit.attackerId === run?.player.id ? 'Удар в щит'
      : hit.result === 'down' && run?.player.id === hit.attackerId
        ? boss ? 'Мастер на колене' : 'Машина потеряла опору' : '';
    if (message) {
      text('hit-feedback', message);
      feedback.hidden = false;
      feedbackUntil = sceneTime + 1.1;
    }
  }
}

function pause() {
  if (!run || !simulate() || run.outcome) return;
  text('pause-location', run.mode === 'drill' ? 'Тренировка опоры' : run.mission.title);
  text('pause-exit', run.mode === 'drill' ? 'В главное меню' : 'К карте');
  setScreen('pause', '[data-action="resume"]');
}

function resume() {
  if (!run || screen !== 'pause' || contextLost) return;
  setScreen(run.mode === 'drill' ? 'drill' : 'duel', '#pause');
}

function showOutcome() {
  if (!run?.outcome) return;
  if (run.outcome.kind === 'error') {
    fail('Симуляция остановилась. Попробуй начать дуэль заново.', false);
    return;
  }
  const victory = run.outcome.kind === 'won';
  const mission = run.mission;
  const unlocked = victory && mission.id === 'M04' && !hasTessak(profile);
  text('result-mission', mission.title);
  text('result-title', victory ? (mission.id === 'M04' ? 'Нижние доки пройдены' : 'Победа') : 'Поражение');
  text('result-detail', run.outcome.kind === 'won'
    ? unlocked ? 'Бригада на платформе. Открыт короткий тесак.' : 'Путь к эвакуационной платформе открыт.'
    : {
      hp: 'Машина нанесла решающий удар.',
      edge: 'Данил сошёл с настила.',
      both: 'Обоюдное попадание.',
      boarding: 'Машины заняли вход на платформу.',
    }[run.outcome.reason]);
  const following = MISSION_ORDER[MISSION_ORDER.indexOf(mission.id) + 1];
  element('result-next').hidden = !victory || !following;
  const starList = element('result-stars');
  starList.replaceChildren();
  starList.hidden = !victory;
  if (run.outcome.kind === 'won') {
    profile = finishMission(profile, mission.id, run.outcome.stars, run.difficulty);
    void save.write(profile);
    const labels = ['Миссия пройдена', ...mission.stars];
    for (const [index, earned] of run.outcome.stars.entries()) {
      const li = document.createElement('li');
      li.className = earned ? 'earned' : 'unearned';
      li.textContent = `${labels[index]} · ${earned ? 'зачтено' : 'не зачтено'}`;
      starList.append(li);
    }
  }
  setScreen('result', victory && following ? '#result-next' : '[data-screen="result"] [data-action="repeat"]');
}

function fail(message: string, needsReload: boolean) {
  setupError = needsReload;
  text('error-message', message);
  setScreen('error', '[data-action="retry"]');
}

function controls(button: HTMLElement) {
  if (screen !== 'pause' && screen !== 'menu') return;
  controlsFrom = screen;
  controlsTrigger = button;
  setScreen('controls', '[data-action="back"]');
}

function closeControls() {
  if (screen !== 'controls') return;
  setScreen(controlsFrom);
  controlsTrigger?.focus({ preventScroll: true });
  controlsTrigger = null;
}

app.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  if (!button) return;
  audio.unlock();
  switch (button.dataset.action) {
    case 'start':
      if (screen === 'menu') {
        const id = nextMission(profile);
        if (id === 'M01') launch(id);
        else if (id) prepare(id);
        else openCampaign();
      }
      break;
    case 'campaign':
      if (screen === 'menu' || screen === 'prepare' || screen === 'result' || screen === 'leave') openCampaign();
      break;
    case 'mission': {
      const id = button.dataset.mission as MissionId;
      if (screen === 'campaign' && MISSION_ORDER.includes(id)) prepare(id);
      break;
    }
    case 'launch': if (screen === 'prepare') launch(selectedMission); break;
    case 'skip': finishIntro(); break;
    case 'next':
      if (screen === 'result' && run?.outcome?.kind === 'won') {
        const id = MISSION_ORDER[MISSION_ORDER.indexOf(run.mission.id) + 1];
        if (id) prepare(id);
      }
      break;
    case 'training': if (screen === 'menu') newRun('drill'); break;
    case 'planted':
    case 'transfer': if (screen === 'drill') newRun('drill', button.dataset.action); break;
    case 'pause': pause(); break;
    case 'resume': resume(); break;
    case 'controls': controls(button); break;
    case 'back': closeControls(); break;
    case 'repeat': if (screen === 'pause' || screen === 'result') replay(); break;
    case 'leave':
      if (screen === 'pause') {
        if (run?.mode === 'drill') newRun('preview');
        else setScreen('leave', '[data-action="keep-playing"]');
      }
      break;
    case 'keep-playing': if (screen === 'leave') setScreen('pause', '#pause-exit'); break;
    case 'menu': if (screen === 'campaign') newRun('preview'); break;
    case 'retry':
      if (setupError || contextLost || !view) location.reload();
      else replay();
      break;
  }
});

element('pause').addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' || !simulate()) return;
  event.preventDefault();
  pause();
});
weaponSelect.addEventListener('change', () => {
  const weapon = weaponSelect.value as WeaponId;
  if (weapon === 'W2' && !hasTessak(profile)) return;
  profile = { ...profile, weapon };
  text('weapon-description', WEAPONS[weapon].description);
  void save.write(profile);
});
difficultySelect.addEventListener('change', () => {
  profile = { ...profile, difficulty: difficultySelect.value as DifficultyId };
  void save.write(profile);
});
sound.addEventListener('change', () => {
  audio.muted = !sound.checked;
  profile = { ...profile, sound: sound.checked };
  void save.write(profile);
});
motion.addEventListener('change', () => {
  repaint = true;
  profile = { ...profile, reducedMotion: motion.checked };
  void save.write(profile);
});
window.addEventListener('keydown', event => {
  if (event.code === 'Escape') {
    if (simulate()) pause();
    else if (screen === 'pause') resume();
    else if (screen === 'controls') closeControls();
    else if (screen === 'intro') finishIntro();
    else if (screen === 'prepare') openCampaign();
    else if (screen === 'campaign') newRun('preview');
    else if (screen === 'leave') setScreen('pause', '#pause-exit');
    return;
  }
  if (debugEnabled && event.code === 'F2' && !event.repeat) {
    diagnostics.hidden = !diagnostics.hidden;
    repaint = true;
    event.preventDefault();
  }
  if (event.code !== 'Tab') return;
  const modal = app.querySelector<HTMLElement>(`[data-screen="${screen}"] [aria-modal="true"]`);
  if (!modal) return;
  const focusable = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled):not([hidden]), input:not(:disabled)')];
  const first = focusable.at(0);
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    last?.focus();
    event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first?.focus();
    event.preventDefault();
  }
});

function suspend() {
  input.reset();
  run?.clearInput();
  pause();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); });
window.addEventListener('blur', suspend);
new ResizeObserver(() => {
  input.reset();
  run?.clearInput();
  view?.resize();
  repaint = true;
}).observe(app);
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  contextLost = true;
  fail('Видеоконтекст потерян. После восстановления можно продолжить попытку.', true);
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  if (!run) return;
  view?.resize();
  if (run.mode === 'preview') setScreen('menu', '[data-action="start"]');
  else if (run.outcome) showOutcome();
  else {
    text('pause-location', run.mode === 'drill' ? 'Тренировка опоры' : run.mission.title);
    text('pause-exit', run.mode === 'drill' ? 'В главное меню' : 'К карте');
    setScreen('pause', '[data-action="resume"]');
  }
});

function frame(now: number) {
  requestAnimationFrame(frame);
  const elapsed = Math.max(0, Math.min((now - lastFrame) / 1000, STEP * 4));
  lastFrame = now;
  if (!run || !view || contextLost || document.hidden) return;
  const active = simulate();
  const animation = active || screen === 'menu' || screen === 'intro';
  if (!animation && !repaint) return;
  repaint = false;
  const delta = animation ? elapsed : 0;
  sceneTime += delta;
  if (screen === 'intro' && sceneTime >= introUntil) finishIntro();
  if (active) {
    accumulator = Math.min(accumulator + elapsed, STEP * 4);
    while (accumulator >= STEP) {
      accumulator -= STEP;
      if (run.outcome) {
        run.settle();
        aftermath += STEP;
        continue;
      }
      const previousTick = run.tick;
      const priorGate = run.gateOpen;
      const playerPhase = run.player.phase(previousTick);
      run.step(input.sample(previousTick + 1));
      if (run.fighters.some(actor => !actor.isPlayer && actor.strike?.start === run!.tick)) audio.signal();
      if (run.player.phase(run.tick) === 'active' && playerPhase !== 'active') audio.swing();
      if (run.gateOpen && !priorGate) audio.gate();
      for (const hit of run.hits) if (hit.tick > previousTick) handleHit(hit);
      if (run.outcome) input.setActive(false);
    }
    if (run.tick % 3 === 0 || run.outcome) updateHud();
    if (run.outcome && aftermath >= (run.outcome.kind === 'lost' ? 0.57 : 0.06)) showOutcome();
  }
  if (!feedback.hidden && sceneTime >= feedbackUntil) feedback.hidden = true;
  const interpolation = animation ? Math.min(1, accumulator / STEP) : 1;
  view.paint(run, interpolation, delta, sceneTime, motion.checked);
  if (debugEnabled && !diagnostics.hidden) {
    const info = view.renderer.info.render;
    const lastHit = run.hits.at(-1);
    diagnostics.textContent = `${run.mission.id} · тик ${run.tick} · ${run.lastTickMs.toFixed(2)} мс/тик\n`
      + `${info.calls} вызовов · ${info.triangles} треугольников\n`
      + (lastHit ? `${lastHit.source} · ${lastHit.surface} · ${lastHit.result} · s ${lastHit.s.toFixed(2)} · P ${lastHit.balanceForce.toFixed(2)}\n`
        + `опора ${lastHit.footSupport} · точка ${lastHit.point.toArray().map(value => value.toFixed(2)).join(', ')}\n`
        + `ось клинка ${lastHit.bladeAxis.toArray().map(value => value.toFixed(2)).join(', ')}` : '');
  }
}

function debugState() {
  if (!run) return null;
  const actor = (fighter: DryDock['player']) => ({
    position: fighter.at.toArray(), hp: fighter.hp, yaw: fighter.yaw,
    phase: fighter.phase(run!.tick), phaseStart: fighter.strike?.start,
    guardUntil: fighter.guardUntil, stance: fighter.stance, support: fighter.support,
  });
  return {
    screen, mode: run.mode, mission: run.mission.id, runId: run.runId, tick: run.tick, awake: run.awake, gateOpen: run.gateOpen,
    player: actor(run.player), watchman: actor(run.watchman), enemies: run.fighters.slice(1).map(actor),
    outcome: run.outcome, parries: run.parries, hits: run.hits.map(hit => ({ ...hit, point: hit.point.toArray() })),
  };
}

async function boot() {
  if (debugEnabled) Object.defineProperty(window, '__protivoves', { value: debugState });
  try {
    [profile] = await Promise.all([save.open(), RAPIER.init()]);
    audio.muted = !profile.sound;
    sound.checked = profile.sound;
    if (profile.reducedMotion !== null) motion.checked = profile.reducedMotion;
    view = new DockView(canvas);
    newRun('preview');
    requestAnimationFrame(frame);
  } catch (error) {
    console.error(error);
    fail('Для игры нужен браузер с WebGL 2. Если он доступен, попробуй загрузить док ещё раз.', true);
  }
}

void boot();
