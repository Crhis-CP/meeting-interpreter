import { join } from 'node:path';
import { applyPreset, type PresetId } from '../../core/config/presets';
import { parseSettings, type AppSettings } from '../../core/config/schema';
import { Emitter } from '../../core/events';
import { deepMerge, readJson, writeJson } from './json-file';

export class SettingsStore extends Emitter<{ changed: AppSettings }> {
  private readonly path: string;
  private current: AppSettings;

  constructor(dataDir: string) {
    super();
    this.path = join(dataDir, 'settings.json');
    this.current = parseSettings(readJson<unknown>(this.path, {}));
  }

  get(): AppSettings {
    return this.current;
  }

  set(patch: unknown): AppSettings {
    const merged = deepMerge(this.current, patch);
    this.current = parseSettings(merged);
    writeJson(this.path, this.current);
    this.emit('changed', this.current);
    return this.current;
  }

  applyPreset(id: PresetId): AppSettings {
    this.current = applyPreset(this.current, id);
    writeJson(this.path, this.current);
    this.emit('changed', this.current);
    return this.current;
  }
}
