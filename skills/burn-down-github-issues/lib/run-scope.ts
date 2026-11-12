type ParentFact = { number: number; parent?: { number: number } | null };

/** Run membership only; admission still obeys placement, holds, claims, and dependencies. */
export class RunScope {
  readonly roots: ReadonlySet<number> | null;
  private readonly members: Set<number> | null;

  constructor(roots: Iterable<number> | null) {
    this.roots = roots === null ? null : new Set(roots);
    this.members = this.roots === null ? null : new Set(this.roots);
  }

  /** Stable shared view for existing scope readers; null retains unrestricted behavior. */
  get effective(): ReadonlySet<number> | null {
    return this.members;
  }

  /** Admit descendants to a fixed point; return each newly admitted number once per run. */
  refresh(facts: readonly ParentFact[]): number[] {
    if (this.members === null) return [];
    const admitted: number[] = [];
    let changed: boolean;
    do {
      changed = false;
      for (const fact of facts) {
        if (!fact.parent || !this.members.has(fact.parent.number) || this.members.has(fact.number)) continue;
        this.members.add(fact.number);
        admitted.push(fact.number);
        changed = true;
      }
    } while (changed);
    return admitted;
  }
}
