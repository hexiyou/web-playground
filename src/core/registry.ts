import type { ExecTarget, LangId, Runner } from './contract';

/** runner 注册表。能力表、路由、UI 都只信这里。 */
export class RunnerRegistry {
  private readonly runners = new Map<string, Runner>();

  register(runner: Runner): void {
    if (this.runners.has(runner.id)) {
      throw new Error(`runner id 重复：${runner.id}`);
    }
    this.runners.set(runner.id, runner);
  }

  unregister(id: string): boolean {
    return this.runners.delete(id);
  }

  /** 包含未启用的 runner，仅用于「接线真值」展示与诊断，不要拿它驱动 UI 可用性。 */
  all(): Runner[] {
    return [...this.runners.values()];
  }

  /** 这一刻真的能跑的 runner。enabled 判断必须是第一句。 */
  active(lang?: LangId, target?: ExecTarget): Runner[] {
    return this.all()
      .filter((r) => r.enabled)
      .filter((r) => typeof r.run === 'function')
      .filter((r) => (lang ? r.languages.includes(lang) : true))
      .filter((r) => (target ? r.target === target : true))
      .sort((a, b) => a.priority - b.priority);
  }
}
