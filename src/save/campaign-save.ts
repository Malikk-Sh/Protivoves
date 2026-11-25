import { MISSION_ORDER } from '../content/campaign.ts';
import type { DifficultyId, MissionId, WeaponId } from '../content/campaign.ts';

export type Stars = [boolean, boolean, boolean];
type Completion = { stars: Stars; difficulty: DifficultyId };
export type Profile = {
  version: 1;
  completed: Partial<Record<MissionId, Completion>>;
  weapon: WeaponId;
  difficulty: DifficultyId;
  sound: boolean;
  reducedMotion: boolean | null;
};

const STORE = 'campaign';
const difficulties: readonly DifficultyId[] = ['story', 'normal', 'master'];

export function newProfile(): Profile {
  return { version: 1, completed: {}, weapon: 'W1', difficulty: 'normal', sound: true, reducedMotion: null };
}

export function nextMission(profile: Profile) {
  return MISSION_ORDER.find(id => !profile.completed[id]) ?? null;
}

export function canPlay(profile: Profile, id: MissionId) {
  const previous = MISSION_ORDER[MISSION_ORDER.indexOf(id) - 1];
  return !previous || Boolean(profile.completed[previous]);
}

export function hasTessak(profile: Profile) {
  return Boolean(profile.completed.M04);
}

export function finishMission(profile: Profile, id: MissionId, stars: Stars, difficulty: DifficultyId): Profile {
  const previous = profile.completed[id];
  const highest = previous && difficulties.indexOf(previous.difficulty) > difficulties.indexOf(difficulty)
    ? previous.difficulty : difficulty;
  const best: Stars = [true, stars[1] || Boolean(previous?.stars[1]), stars[2] || Boolean(previous?.stars[2])];
  return { ...profile, completed: { ...profile.completed, [id]: { stars: best, difficulty: highest } } };
}

export function validateProfile(value: unknown): Profile | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || typeof data.completed !== 'object' || data.completed === null ||
    Array.isArray(data.completed) || !difficulties.includes(data.difficulty as DifficultyId) ||
    (data.weapon !== 'W1' && data.weapon !== 'W2') || typeof data.sound !== 'boolean' ||
    (data.reducedMotion !== null && typeof data.reducedMotion !== 'boolean')) return null;
  const completed: Profile['completed'] = {};
  const entries = data.completed as Record<string, unknown>;
  if (Object.keys(entries).some(id => !MISSION_ORDER.includes(id as MissionId))) return null;
  for (const [index, id] of MISSION_ORDER.entries()) {
    const raw = entries[id];
    if (raw === undefined) continue;
    if (index > 0 && !completed[MISSION_ORDER[index - 1]]) return null;
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Partial<Completion>;
    if (!Array.isArray(item.stars) || item.stars.length !== 3 || item.stars[0] !== true ||
      item.stars.some(star => typeof star !== 'boolean') || !difficulties.includes(item.difficulty!)) return null;
    completed[id] = { stars: [...item.stars], difficulty: item.difficulty! };
  }
  if (data.weapon === 'W2' && !completed.M04) return null;
  return { version: 1, completed, weapon: data.weapon, difficulty: data.difficulty as DifficultyId,
    sound: data.sound, reducedMotion: data.reducedMotion };
}

export class CampaignSave {
  private db: IDBDatabase | null = null;
  private queue = Promise.resolve();
  private reported = false;
  private report: (message: string) => void;

  constructor(report: (message: string) => void) {
    this.report = report;
  }

  async open(): Promise<Profile> {
    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('protivoves', 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Save upgrade is blocked'));
      });
      this.db.onversionchange = () => {
        this.db?.close();
        this.db = null;
      };
      const [current, previous] = await new Promise<unknown[]>((resolve, reject) => {
        const transaction = this.db!.transaction(STORE, 'readonly');
        const store = transaction.objectStore(STORE);
        const main = store.get('current');
        const backup = store.get('previous');
        transaction.oncomplete = () => resolve([main.result, backup.result]);
        transaction.onabort = () => reject(transaction.error);
      });
      const valid = validateProfile(current);
      if (valid) return valid;
      const recovered = validateProfile(previous);
      if (recovered) {
        this.report('Восстановлен последний сохранённый прогресс.');
        return recovered;
      }
      if (current !== undefined) this.report('Сохранение повреждено. Открыта новая кампания.');
    } catch {
      this.db?.close();
      this.db = null;
      this.unavailable();
    }
    return newProfile();
  }

  write(profile: Profile) {
    const data = structuredClone(profile);
    this.queue = this.queue.then(async () => {
      if (!this.db) {
        this.unavailable();
        return;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction(STORE, 'readwrite');
          const store = transaction.objectStore(STORE);
          const prior = store.get('current');
          prior.onsuccess = () => {
            if (validateProfile(prior.result)) store.put(prior.result, 'previous');
            store.put(data, 'current');
          };
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
      } catch {
        this.unavailable();
      }
    });
    return this.queue;
  }

  private unavailable() {
    if (this.reported) return;
    this.reported = true;
    this.report('Запись недоступна. Прогресс сохранится до закрытия вкладки.');
  }
}
